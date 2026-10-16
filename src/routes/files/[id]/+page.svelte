<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { api, errorText, on, streamLlm } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { duration, relDate, languageName, LANGUAGES, words } from "$lib/format";
  import type { JobProgress, Recording, RecordingPatch } from "$lib/types";
  import Transcript from "$lib/components/Transcript.svelte";
  import Player from "$lib/components/Player.svelte";
  import Chat from "$lib/components/Chat.svelte";
  import Markdown from "$lib/components/Markdown.svelte";
  import ExportMenu from "$lib/components/ExportMenu.svelte";
  import Modal from "$lib/components/Modal.svelte";
  import {
    ChevronLeft,
    Ellipsis,
    FolderOpen,
    Languages,
    RefreshCw,
    Search,
    Sparkles,
    Star,
    Trash2,
    X,
    LoaderCircle,
    CircleAlert,
    Pencil,
  } from "@lucide/svelte";

  const id = $derived(page.params.id!);
  let rec = $state<Recording | null>(null);
  let loaded = $state(false);
  let job = $state<JobProgress | null>(null);
  let currentMs = $state(0);
  let player = $state<Player | null>(null);
  let transcriptView = $state<Transcript | null>(null);
  let query = $state("");
  let searchOpen = $state(false);
  let panel = $state<"summary" | "chat">("summary");
  let more = $state(false);

  // The recording a summary is being generated for, if any.
  let summarizingFor = $state<string | null>(null);
  const summarizing = $derived(summarizingFor === id);
  let summaryDraft = $state("");
  let editingSummary = $state(false);
  let summaryReq = "";

  let retxOpen = $state(false);
  let retxProfile = $state("");
  let retxLang = $state<string | null>(null);
  let trOpen = $state(false);
  let trLang = $state("English");
  let translating = $state(false);

  async function load() {
    const want = id;
    const r = await api.recording(want);
    if (want !== id) return; // navigated away while loading
    rec = r;
    loaded = true;
  }

  $effect(() => {
    id;
    loaded = false;
    job = null;
    query = "";
    // Drafts belong to the recording they were opened on.
    editingSummary = false;
    summaryDraft = "";
    load();
  });

  $effect(() => {
    const off1 = on<string>("recording:updated", (rid) => rid === id && load());
    const off2 = on<JobProgress>("recording:progress", (p) => {
      if (p.id !== id) return;
      job = p;
      if (rec) {
        rec.status = p.status;
        if (p.error) rec.error = p.error;
      }
      // Finished or failed: pick up the transcript or error from the database.
      if (p.status === "ready" || p.status === "error") load();
    });
    return () => {
      off1();
      off2();
    };
  });

  const busy = $derived(rec && (rec.status === "processing" || rec.status === "queued"));
  const hasSpeakers = $derived(!!rec?.segments.some((s) => s.speaker));
  const matches = $derived(
    query.trim() && rec ? rec.segments.filter((s) => s.text.toLowerCase().includes(query.trim().toLowerCase())).length : 0,
  );

  async function patch(p: RecordingPatch) {
    const forId = id;
    const r = await api.updateRecording(forId, p);
    if (r && forId === id) rec = r;
  }

  async function summarize() {
    if (!rec) return;
    // Results only touch the page while it still shows this recording.
    const forId = id;
    const here = () => forId === id && rec?.id === forId;
    summarizingFor = forId;
    rec.summary = "";
    panel = "summary";
    try {
      const { requestId, result } = await streamLlm(
        (r) => api.summarize(forId, r),
        (d) => here() && (rec!.summary += d),
      );
      summaryReq = requestId;
      const summary = await result;
      if (here()) rec!.summary = summary;
    } catch (e) {
      if (forId === id) {
        app.toast("error", errorText(e));
        load();
      }
    } finally {
      if (summarizingFor === forId) summarizingFor = null;
    }
  }

  async function remove() {
    if (!rec) return;
    if (await ask(`Delete “${rec.title}” and its transcript?`, { title: "Delete recording", kind: "warning" })) {
      await api.deleteRecording(id);
      app.recordingsVersion++;
      goto("/files");
    }
  }

  async function retranscribe() {
    retxOpen = false;
    try {
      await api.retranscribe(id, retxProfile, retxLang);
      load();
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function translate() {
    translating = true;
    try {
      const { result } = await streamLlm((r) => api.translate(id, trLang, r), () => {});
      const newId = await result;
      trOpen = false;
      app.recordingsVersion++;
      goto(`/files/${newId}`);
    } catch (e) {
      app.toast("error", errorText(e));
    } finally {
      translating = false;
    }
  }

  function keys(e: KeyboardEvent) {
    if (e.metaKey && e.key === "f") {
      e.preventDefault();
      searchOpen = true;
      setTimeout(() => document.querySelector<HTMLInputElement>(".tsearch input")?.focus());
    }
  }
</script>

<svelte:window onkeydown={keys} onclick={(e) => more && !(e.target as HTMLElement).closest(".more") && (more = false)} />

{#if !loaded}
  <div></div>
{:else if !rec}
  <div class="empty" style="margin-top:80px"><h3>Not found</h3><a href="/files">Back to files</a></div>
{:else}
  <div class="detail">
    <header>
      <a class="back" href="/files"><ChevronLeft size={15} /> Files</a>
      <div class="titlerow">
        <input
          class="title selectable"
          value={rec.title}
          onchange={(e) => patch({ title: e.currentTarget.value.trim() || rec!.title })}
          onkeydown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <button class="btn icon sm ghost star" class:on={rec.starred} title="Star" onclick={() => patch({ starred: !rec!.starred })}>
          <Star size={15} fill={rec.starred ? "currentColor" : "none"} />
        </button>
        <span class="spacer"></span>
        {#if rec.status === "ready"}
          <button class="btn sm ghost" title="Search (⌘F)" onclick={() => (searchOpen = !searchOpen)}><Search size={14} /></button>
          <ExportMenu {id} title={rec.title} hasNotes={!!rec.summary} {hasSpeakers} />
        {/if}
        <div class="more">
          <button class="btn sm icon" onclick={() => (more = !more)}><Ellipsis size={15} /></button>
          {#if more}
            <div class="menu card">
              <button onclick={() => { more = false; retxProfile = rec!.stt ?? app.settings!.files.stt_profile; retxLang = rec!.language; retxOpen = true; }} disabled={!!busy}>
                <RefreshCw size={14} /> Transcribe again…
              </button>
              {#if app.settings?.llm_profiles.length}
                <button onclick={() => { more = false; trOpen = true; }} disabled={rec.status !== "ready"}><Languages size={14} /> Translate…</button>
              {/if}
              {#if rec.media_path}
                <button onclick={() => { more = false; api.reveal(rec!.media_path!); }}><FolderOpen size={14} /> Show in Finder</button>
              {/if}
              <div class="sep"></div>
              <button class="danger" onclick={remove}><Trash2 size={14} /> Delete</button>
            </div>
          {/if}
        </div>
      </div>
      <div class="meta faint small">
        <span>{relDate(rec.created_at)}</span>
        {#if rec.duration_ms}<span>{duration(rec.duration_ms)}</span>{/if}
        {#if rec.segments.length}<span>{words(rec.segments.map((s) => s.text).join(" ")).toLocaleString()} words</span>{/if}
        {#if rec.language}<span>{languageName(rec.language)}</span>{/if}
        {#if rec.stt}<span>{app.sttName(rec.stt)}</span>{/if}
        {#if rec.source && /^https?:/.test(rec.source)}<a href={rec.source} target="_blank" rel="noreferrer">Source</a>{/if}
      </div>
    </header>

    <div class="cols">
      <div class="left">
        {#if searchOpen}
          <div class="tsearch">
            <Search size={14} />
            <input class="selectable" placeholder="Find in transcript" bind:value={query} onkeydown={(e) => e.key === "Enter" && transcriptView?.scrollToFirstMatch()} />
            {#if query}<span class="faint small">{matches} {matches === 1 ? "match" : "matches"}</span>{/if}
            <button class="btn icon sm ghost" aria-label="Close search" onclick={() => { searchOpen = false; query = ""; }}><X size={13} /></button>
          </div>
        {/if}

        <div class="scroll">
          {#if busy}
            <div class="state">
              <LoaderCircle size={22} class="spin" />
              <h3>
                {rec.status === "queued"
                  ? "Waiting in queue"
                  : job?.stage === "downloading"
                    ? "Downloading media"
                    : job?.stage === "decoding"
                      ? "Reading audio"
                      : "Transcribing"}
              </h3>
              <div class="progress" class:indeterminate={!job || job.progress <= 0} style="width:260px">
                <div style:width="{(job?.progress ?? 0) * 100}%"></div>
              </div>
              <p class="faint small">{app.sttName(rec.stt ?? app.settings?.files.stt_profile)} · you can keep using Hush meanwhile</p>
              <button class="btn sm" onclick={() => api.cancelJob(id)}>Cancel</button>
            </div>
          {:else if rec.status === "error"}
            <div class="state">
              <CircleAlert size={22} />
              <h3>Transcription failed</h3>
              <p class="muted selectable err">{rec.error}</p>
              <button class="btn sm" onclick={() => { retxProfile = rec!.stt ?? app.settings!.files.stt_profile; retxLang = rec!.language; retxOpen = true; }}>
                <RefreshCw size={13} /> Try again
              </button>
            </div>
          {:else if !rec.segments.length}
            <div class="state"><h3>No speech found</h3><p class="muted">This file didn't contain recognizable speech.</p></div>
          {:else}
            <Transcript
              bind:this={transcriptView}
              segments={rec.segments}
              speakers={rec.speakers}
              {currentMs}
              {query}
              onseek={(ms) => player?.seek(ms)}
              onedit={(i, text) => patch({ segment_edit: [i, text] })}
              onrename={(key, name) => patch({ speakers: { ...rec!.speakers, [key]: name } })}
              onreassign={(i, key) => patch({ segment_speaker: [i, key] })}
            />
          {/if}
        </div>

        {#if rec.media_path || rec.audio_path}
          <div class="playerwrap">
            <Player bind:this={player} path={rec.media_path ?? rec.audio_path} fallback={rec.audio_path} bind:currentMs durationMs={rec.duration_ms} />
          </div>
        {/if}
      </div>

      <aside class="right">
        <div class="tabs">
          <button class:on={panel === "summary"} onclick={() => (panel = "summary")}>Summary</button>
          <button class:on={panel === "chat"} onclick={() => (panel = "chat")}>Ask</button>
        </div>
        {#if !app.settings?.llm_profiles.length}
          <div class="noai">
            <Sparkles size={18} />
            <p class="muted small">Connect an AI in <a href="/settings?tab=ai">Settings → AI</a> to summarize, translate and chat with transcripts.</p>
          </div>
        {:else if panel === "summary"}
          <div class="summary">
            {#if rec.summary || summarizing}
              {#if editingSummary}
                <textarea class="textarea" bind:value={summaryDraft} rows="18"></textarea>
                <div class="row">
                  <button class="btn sm primary" onclick={() => { patch({ summary: summaryDraft }); editingSummary = false; }}>Save</button>
                  <button class="btn sm ghost" onclick={() => (editingSummary = false)}>Cancel</button>
                </div>
              {:else}
                <Markdown source={rec.summary || "…"} />
                <div class="row acts">
                  {#if summarizing}
                    <button class="btn sm" onclick={() => api.cancelLlm(summaryReq)}>Stop</button>
                  {:else}
                    <button class="btn sm ghost" onclick={summarize}><RefreshCw size={13} /> Regenerate</button>
                    <button class="btn sm ghost" onclick={() => { summaryDraft = rec!.summary; editingSummary = true; }}><Pencil size={13} /> Edit</button>
                  {/if}
                </div>
              {/if}
            {:else}
              <div class="noai">
                <Sparkles size={18} />
                <p class="muted small">Get the gist, key points and action items in a few seconds.</p>
                <button class="btn sm primary" disabled={rec.status !== "ready" || !rec.segments.length} onclick={summarize}>Summarize</button>
              </div>
            {/if}
          </div>
        {:else}
          <Chat
            {id}
            bind:messages={rec.chat}
            llmName={app.llmName(app.settings.files.llm_profile)}
            suggestions={["What are the key takeaways?", "List every action item with an owner", "What questions were left unanswered?"]}
          />
        {/if}
      </aside>
    </div>
  </div>
{/if}

<Modal bind:open={retxOpen} title="Transcribe again" width={440}>
  <div class="stack">
    <label class="stack" style="gap:6px">
      <span class="eyebrow">Speech model</span>
      <select class="select" bind:value={retxProfile}>
        {#each app.settings?.stt_profiles ?? [] as p}<option value={p.id}>{app.sttName(p.id)}</option>{/each}
      </select>
    </label>
    <label class="stack" style="gap:6px">
      <span class="eyebrow">Language</span>
      <select class="select" bind:value={retxLang}>
        <option value={null}>Auto-detect</option>
        {#each LANGUAGES as [c, n]}<option value={c}>{n}</option>{/each}
      </select>
    </label>
    <p class="faint small">Edits to the current transcript will be replaced.</p>
  </div>
  {#snippet footer()}
    <button class="btn ghost" onclick={() => (retxOpen = false)}>Cancel</button>
    <button class="btn primary" onclick={retranscribe}>Transcribe</button>
  {/snippet}
</Modal>

<Modal bind:open={trOpen} title="Translate transcript" width={420}>
  <div class="stack">
    <p class="muted small">Creates a translated copy with the same timestamps, using {app.llmName(app.settings?.files.llm_profile)}.</p>
    <input class="input" list="langs" bind:value={trLang} placeholder="Language" />
    <datalist id="langs">{#each LANGUAGES as [, n]}<option value={n}></option>{/each}</datalist>
  </div>
  {#snippet footer()}
    <button class="btn ghost" onclick={() => (trOpen = false)}>Cancel</button>
    <button class="btn primary" disabled={translating || !trLang.trim()} onclick={translate}>
      {#if translating}<LoaderCircle size={14} class="spin" /> Translating…{:else}Translate{/if}
    </button>
  {/snippet}
</Modal>

<style>
  .detail {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  header {
    padding: 38px 32px 14px 40px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .back {
    position: relative;
    z-index: 6;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: -4px;
    color: var(--text-3);
    font-size: 12.5px;
  }
  .back:hover {
    color: var(--text);
  }
  .titlerow {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .title {
    flex: 0 1 auto;
    field-sizing: content;
    min-width: 120px;
    max-width: 100%;
    padding: 2px 6px;
    margin-left: -6px;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: none;
    color: var(--text);
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 500;
    outline: none;
    text-overflow: ellipsis;
  }
  .title:hover {
    border-color: var(--line);
  }
  .title:focus {
    border-color: var(--line-2);
    background: var(--surface);
  }
  .star.on {
    color: var(--amber);
  }
  .meta {
    display: flex;
    gap: 14px;
    margin-top: 2px;
  }
  .more {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 32px;
    z-index: 40;
    width: 210px;
    padding: 5px;
    border-radius: var(--r);
    box-shadow: var(--shadow-pop);
    display: flex;
    flex-direction: column;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .menu button:hover {
    background: var(--surface-2);
  }
  .menu button:disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .menu .danger {
    color: var(--ember-text);
  }
  .sep {
    height: 1px;
    margin: 4px;
    background: var(--line);
  }
  .cols {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 340px;
  }
  .left {
    position: relative;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tsearch {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 32px 0 40px;
    padding: 4px 4px 4px 12px;
    border-radius: var(--r-sm);
    background: var(--surface-2);
  }
  .tsearch input {
    flex: 1;
    height: 26px;
    border: 0;
    outline: 0;
    background: none;
    color: var(--text);
    font: inherit;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 22px 32px 30px 26px;
    display: flex;
    flex-direction: column;
  }
  .playerwrap {
    padding: 10px 24px 16px;
    flex: none;
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin: auto;
    padding: 40px;
    text-align: center;
    color: var(--text-2);
  }
  .state h3 {
    color: var(--text);
    font-size: 18px;
  }
  .state :global(svg) {
    color: var(--ember-text);
  }
  .err {
    max-width: 480px;
    overflow-wrap: anywhere;
  }
  .right {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px 20px 16px;
    border-left: 1px solid var(--line);
    background: var(--bg-sidebar);
  }
  .right .tabs {
    align-self: flex-start;
  }
  .summary {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .summary :global(.prose) {
    font-size: 13.5px;
  }
  .acts {
    gap: 4px;
  }
  .noai {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 2px;
  }
  .noai :global(svg) {
    color: var(--ember-text);
  }
</style>

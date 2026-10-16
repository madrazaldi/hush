<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { api, errorText, on } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { clock, duration, relDate } from "#lib/format.js";
  import type { Recording, RecordingPatch } from "#lib/types.js";
  import Transcript from "#lib/components/Transcript.svelte";
  import Player from "#lib/components/Player.svelte";
  import Chat from "#lib/components/Chat.svelte";
  import Markdown from "#lib/components/Markdown.svelte";
  import ExportMenu from "#lib/components/ExportMenu.svelte";
  import Levels from "#lib/components/Levels.svelte";
  import {
    ChevronLeft,
    Copy,
    Ellipsis,
    Mic,
    Pause,
    Pencil,
    Play,
    RefreshCw,
    Sparkles,
    Square,
    Star,
    Trash2,
    TriangleAlert,
    LoaderCircle,
    PanelRightClose,
    PanelRightOpen,
  } from "@lucide/svelte";

  const id = $derived(page.params.id!);
  let rec = $state<Recording | null>(null);
  let loaded = $state(false);
  let notes = $state("");
  let notesTimer: ReturnType<typeof setTimeout> | undefined;
  let view = $state<"enhanced" | "notes" | "transcript">("notes");
  let side = $state(true);
  let enhancing = $state(false);
  let editingEnhanced = $state(false);
  let enhancedDraft = $state("");
  let levels = $state({ me: 0, them: 0 });
  let currentMs = $state(0);
  let player = $state<Player | null>(null);
  let more = $state(false);
  let stopping = $state(false);

  const live = $derived(app.meeting?.id === id);
  const s = $derived(app.settings!);
  const hasAi = $derived(!!s.llm_profiles.length);

  async function load(initial = false) {
    const want = id;
    const r = await api.recording(want);
    // Navigated to another meeting while this was loading.
    if (want !== id) return;
    if (initial) {
      notes = r?.notes ?? "";
      view = r?.enhanced ? "enhanced" : r?.segments.length && r.status === "ready" ? (hasAi ? "enhanced" : "transcript") : "notes";
    }
    // Never clobber what's being typed.
    if (r && rec && !initial) r.notes = notes;
    rec = r;
    loaded = true;
  }

  $effect(() => {
    id;
    loaded = false;
    rec = null;
    enhancing = false;
    editingEnhanced = false;
    enhancedDraft = "";
    load(true);
    // Save pending edits to the meeting they were typed in before switching away.
    return flushNotes;
  });

  $effect(() => {
    const offs = [
      on<string>("meeting:transcript", (rid) => rid === id && load()),
      on<string>("recording:updated", (rid) => rid === id && !enhancing && load()),
      on<{ me: number; them: number }>("meeting:levels", (l) => (levels = l)),
      on<{ id: string; reset?: boolean; delta?: string; done?: boolean }>("meeting:enhance", (e) => {
        if (e.id !== id || !rec) return;
        if (e.reset) {
          enhancing = true;
          rec.enhanced = "";
          view = "enhanced";
        } else if (e.delta && enhancing) rec.enhanced += e.delta;
        else if (e.done) {
          enhancing = false;
          load();
        }
      }),
      on<{ id: string }>("meeting:enhance-error", (e) => e.id === id && (enhancing = false)),
    ];
    return () => offs.forEach((f) => f());
  });

  // Debounced autosave. The target id and text are captured when typed, so a
  // save that fires after navigation still lands on the right meeting.
  let pendingNotes: { id: string; notes: string } | null = null;

  function flushNotes() {
    clearTimeout(notesTimer);
    const p = pendingNotes;
    pendingNotes = null;
    if (p) api.updateRecording(p.id, { notes: p.notes }).catch((e) => app.toast("error", errorText(e)));
  }

  function onNotes() {
    clearTimeout(notesTimer);
    pendingNotes = { id, notes };
    notesTimer = setTimeout(flushNotes, 500);
  }

  async function saveNotesNow() {
    clearTimeout(notesTimer);
    pendingNotes = null;
    await api.updateRecording(id, { notes });
  }

  async function patch(p: RecordingPatch) {
    const forId = id;
    const r = await api.updateRecording(forId, p);
    if (r && forId === id) {
      r.notes = notes;
      rec = r;
    }
  }

  async function start() {
    const forId = id;
    try {
      await saveNotesNow();
      await api.meetingStart(forId);
      await app.refreshMeeting();
      if (forId !== id) return;
      view = "notes";
      load();
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function stop() {
    const forId = id;
    stopping = true;
    await saveNotesNow();
    try {
      await api.meetingStop();
      app.meeting = null;
      if (forId !== id) return;
      await load();
      if (hasAi && s.meetings.auto_enhance) view = "enhanced";
      else view = "transcript";
    } catch (e) {
      app.toast("error", errorText(e));
    } finally {
      stopping = false;
    }
  }

  async function enhance(templateId?: string) {
    if (!rec) return;
    const forId = id;
    await saveNotesNow();
    if (forId !== id || !rec) return; // navigated away while saving
    enhancing = true;
    view = "enhanced";
    rec.enhanced = "";
    try {
      await api.meetingEnhance(forId, templateId ?? rec.template_id ?? s.meetings.default_template);
    } catch (e) {
      if (forId === id) app.toast("error", errorText(e));
    } finally {
      if (forId === id) {
        enhancing = false;
        load();
      }
    }
  }

  async function remove() {
    if (!rec) return;
    if (await ask(`Delete “${rec.title}”, its notes and transcript?`, { title: "Delete meeting", kind: "warning" })) {
      await api.deleteRecording(id);
      app.recordingsVersion++;
      goto("/meetings");
    }
  }

  const template = $derived(s.meetings.templates.find((t) => t.id === (rec?.template_id ?? s.meetings.default_template)));
</script>

<svelte:window onclick={(e) => more && !(e.target as HTMLElement).closest(".more") && (more = false)} />

{#if !loaded}
  <div></div>
{:else if !rec}
  <div class="empty" style="margin-top:80px"><h3>Not found</h3><a href="/meetings">Back to meetings</a></div>
{:else}
  <div class="detail">
    <header>
      <a class="back" href="/meetings"><ChevronLeft size={15} /> Meetings</a>
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
        {#if !live && rec.status === "ready" && rec.segments.length}
          <ExportMenu {id} title={rec.title} hasNotes={!!(rec.notes || rec.enhanced)} hasSpeakers />
        {/if}
        <div class="more">
          <button class="btn sm icon" onclick={() => (more = !more)}><Ellipsis size={15} /></button>
          {#if more}
            <div class="menu card">
              {#if rec.enhanced}
                <button onclick={() => { more = false; writeText(rec!.enhanced); app.toast("success", "Notes copied"); }}><Copy size={14} /> Copy notes</button>
              {/if}
              {#if rec.audio_path}
                <button onclick={() => { more = false; api.reveal(rec!.audio_path!); }}><Mic size={14} /> Show recording</button>
              {/if}
              <button class="danger" disabled={live} onclick={remove}><Trash2 size={14} /> Delete</button>
            </div>
          {/if}
        </div>
        <button class="btn sm icon ghost" title="Toggle side panel" onclick={() => (side = !side)}>
          {#if side}<PanelRightClose size={15} />{:else}<PanelRightOpen size={15} />{/if}
        </button>
      </div>
      <div class="meta faint small">
        <span>{relDate(rec.created_at)}</span>
        {#if rec.duration_ms && !live}<span>{duration(rec.duration_ms)}</span>{/if}
        {#if Object.keys(rec.speakers).length}<span>{Object.values(rec.speakers).join(", ")}</span>{/if}
      </div>
    </header>

    {#if live && app.meeting}
      <div class="recbar">
        <span class="dot" class:live={!app.meeting.paused}></span>
        <b class="mono">{clock(app.meeting.elapsed_ms)}</b>
        <span class="faint small">{app.meeting.paused ? "Paused" : "Recording"}</span>
        <div class="lv">
          <Levels label="You" level={app.meeting.paused ? 0 : levels.me} active={app.meeting.mic} />
          <Levels label={rec.speakers["Them"] || "Them"} level={app.meeting.paused ? 0 : levels.them} active={app.meeting.system} tone="sage" />
        </div>
        {#if app.meeting.system_error}
          <button class="chip amber warn" title={app.meeting.system_error} onclick={() => api.openPrivacy("system_audio")}>
            <TriangleAlert size={12} /> Mic only — allow system audio
          </button>
        {/if}
        <span class="spacer"></span>
        <button class="btn sm" onclick={() => api.meetingPause(!app.meeting!.paused).then(() => app.refreshMeeting())}>
          {#if app.meeting.paused}<Play size={13} /> Resume{:else}<Pause size={13} /> Pause{/if}
        </button>
        <button class="btn sm primary" onclick={stop} disabled={stopping}>
          {#if stopping}<LoaderCircle size={13} class="spin" /> Finishing…{:else}<Square size={11} fill="currentColor" /> Stop{/if}
        </button>
      </div>
    {:else if rec.status === "processing"}
      <div class="recbar"><LoaderCircle size={14} class="spin" /> <span class="muted">Finishing the transcript…</span></div>
    {/if}

    <div class="cols" class:noside={!side}>
      <div class="left">
        {#if !live && (rec.segments.length || rec.enhanced)}
          <div class="viewbar">
            <div class="tabs">
              {#if hasAi || rec.enhanced}<button class:on={view === "enhanced"} onclick={() => (view = "enhanced")}><Sparkles size={12} /> Notes</button>{/if}
              <button class:on={view === "notes"} onclick={() => (view = "notes")}>My notes</button>
              <button class:on={view === "transcript"} onclick={() => (view = "transcript")}>Transcript</button>
            </div>
            {#if view === "enhanced" && hasAi}
              <span class="spacer"></span>
              <select
                class="select tpl"
                value={rec.template_id ?? s.meetings.default_template}
                disabled={enhancing}
                onchange={(e) => {
                  const t = e.currentTarget.value;
                  patch({ template_id: t });
                  enhance(t);
                }}
              >
                {#each s.meetings.templates as t}<option value={t.id}>{t.name}</option>{/each}
              </select>
              {#if rec.enhanced && !enhancing}
                <button class="btn sm ghost" title="Regenerate" onclick={() => enhance()}><RefreshCw size={13} /></button>
                <button class="btn sm ghost" title="Edit" onclick={() => { enhancedDraft = rec!.enhanced; editingEnhanced = true; }}><Pencil size={13} /></button>
              {/if}
            {/if}
          </div>
        {/if}

        <div class="scroll">
          {#if view === "notes" || live || (!rec.segments.length && !rec.enhanced)}
            <div class="notepad">
              {#if !live && !rec.segments.length && rec.status !== "processing"}
                <div class="startcard">
                  <div>
                    <h3>Ready when you are</h3>
                    <p class="muted small">
                      Hush records your mic{s.meetings.capture_system_audio ? " and the call's audio" : ""}. Type the things you'd want to remember — Hush fills in the rest.
                    </p>
                  </div>
                  <button class="btn primary" onclick={start} disabled={!!app.meeting}><Mic size={14} /> Start recording</button>
                </div>
              {/if}
              <textarea
                class="notes selectable"
                placeholder={live ? "Write notes… key points, questions, decisions. Rough is fine." : "Agenda, context, or notes…"}
                bind:value={notes}
                oninput={onNotes}
              ></textarea>
              {#if !live && rec.segments.length && hasAi && !rec.enhanced && !enhancing}
                <button class="btn primary enh" onclick={() => enhance()}><Sparkles size={14} /> Enhance notes with {template?.name ?? "template"}</button>
              {/if}
            </div>
          {:else if view === "enhanced"}
            <div class="enhanced">
              {#if editingEnhanced}
                <textarea class="textarea" rows="24" bind:value={enhancedDraft}></textarea>
                <div class="row">
                  <button class="btn sm primary" onclick={() => { patch({ enhanced: enhancedDraft }); editingEnhanced = false; }}>Save</button>
                  <button class="btn sm ghost" onclick={() => (editingEnhanced = false)}>Cancel</button>
                </div>
              {:else if rec.enhanced}
                <Markdown source={rec.enhanced} class="big" />
                {#if enhancing}<span class="cursor"></span>{/if}
              {:else if enhancing}
                <div class="state"><LoaderCircle size={18} class="spin" /><p class="muted">Writing notes from your transcript{notes ? " and jottings" : ""}…</p></div>
              {:else}
                <div class="state">
                  <Sparkles size={20} />
                  <h3>Turn this into notes</h3>
                  <p class="muted small">Combines your jottings with the transcript using the “{template?.name}” template.</p>
                  <button class="btn primary" onclick={() => enhance()}>Enhance notes</button>
                </div>
              {/if}
            </div>
          {:else}
            <Transcript
              segments={rec.segments}
              speakers={rec.speakers}
              {currentMs}
              onseek={(ms) => player?.seek(ms)}
              onedit={(i, text) => patch({ segment_edit: [i, text] })}
              onrename={(key, name) => patch({ speakers: { ...rec!.speakers, [key]: name } })}
              onreassign={(i, key) => patch({ segment_speaker: [i, key] })}
            />
          {/if}
        </div>

        {#if !live && view === "transcript" && rec.audio_path}
          <div class="playerwrap">
            <Player bind:this={player} path={rec.audio_path} bind:currentMs durationMs={rec.duration_ms} />
          </div>
        {/if}
      </div>

      {#if side}
        <aside class="right">
          {#if live || (!rec.enhanced && view !== "transcript" && rec.segments.length && !hasAi)}
            <div class="sidehead"><span class="eyebrow">Live transcript</span></div>
            <div class="scroll livet">
              {#if rec.segments.length}
                <Transcript segments={rec.segments} speakers={rec.speakers} live showTimes={false} editable={false} />
              {:else}
                <p class="faint small">{live ? "Listening… lines appear a few seconds after someone stops talking." : "No transcript yet."}</p>
              {/if}
            </div>
          {:else if hasAi && rec.segments.length}
            <Chat
              {id}
              bind:messages={rec.chat}
              recipes={s.meetings.recipes}
              llmName={app.llmName(s.meetings.llm_profile)}
            />
          {:else if !hasAi}
            <div class="noai">
              <Sparkles size={18} />
              <p class="muted small">Connect an AI in <a href="/settings?tab=ai">Settings → AI</a> to enhance notes, run recipes like “Write follow-up email”, and chat with your meeting.</p>
            </div>
          {:else}
            <div class="noai">
              <p class="faint small">Record the meeting to ask questions about it here.</p>
            </div>
          {/if}
        </aside>
      {/if}
    </div>
  </div>
{/if}

<style>
  .detail {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  header {
    padding: 38px 24px 12px 40px;
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
    width: 200px;
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
  }
  .menu .danger {
    color: var(--ember-text);
  }
  .recbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 24px 8px 40px;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--ember-soft) 50%, var(--bg));
    flex: none;
  }
  .recbar b {
    font-size: 13px;
  }
  .lv {
    display: flex;
    gap: 14px;
    margin-left: 10px;
  }
  .warn {
    cursor: pointer;
    font: inherit;
    font-size: 11.5px;
  }
  .cols {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 340px;
  }
  .cols.noside {
    grid-template-columns: 1fr;
  }
  .left {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .viewbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 24px 0 40px;
  }
  .viewbar .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .tpl {
    width: 170px;
    height: 28px;
    font-size: 12.5px;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 22px 40px 40px;
    display: flex;
    flex-direction: column;
  }
  .notepad {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 760px;
  }
  .startcard {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 16px 18px;
    border-radius: var(--r-lg);
    background: var(--surface);
    border: 1px solid var(--line);
  }
  .startcard div {
    flex: 1;
  }
  .startcard h3 {
    margin-bottom: 2px;
  }
  .notes {
    flex: 1;
    min-height: 320px;
    border: 0;
    outline: 0;
    resize: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 15.5px;
    line-height: 1.75;
  }
  .notes::placeholder {
    color: var(--text-3);
    font-family: var(--serif);
    font-style: italic;
    font-size: 17px;
  }
  .enh {
    align-self: flex-start;
  }
  .enhanced {
    max-width: 760px;
  }
  .enhanced :global(.prose.big) {
    font-size: 15px;
    line-height: 1.7;
  }
  .cursor {
    display: inline-block;
    width: 8px;
    height: 16px;
    background: var(--ember);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin: 60px auto;
    text-align: center;
  }
  .state :global(svg) {
    color: var(--ember-text);
  }
  .playerwrap {
    padding: 10px 24px 16px;
    flex: none;
  }
  .right {
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 16px 20px;
    border-left: 1px solid var(--line);
    background: var(--bg-sidebar);
  }
  .sidehead {
    margin-bottom: 8px;
  }
  .livet {
    padding: 0;
  }
  .livet :global(.text) {
    font-size: 13px;
    line-height: 1.55;
  }
  .noai {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 6px 2px;
  }
  .noai :global(svg) {
    color: var(--ember-text);
  }
</style>

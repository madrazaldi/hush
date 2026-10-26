<script lang="ts">
  import { goto } from "$app/navigation";
  import { open } from "#lib/ipc.js";
  import { api, errorText, streamLlm } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { duration, relDate } from "#lib/format.js";
  import { MEDIA_EXTS } from "#lib/media.js";
  import type { Dictation, RecordingSummary, Stats } from "#lib/types.js";
  import Keys from "#lib/components/Keys.svelte";
  import Markdown from "#lib/components/Markdown.svelte";
  import { ArrowUp, FileAudio, Flame, Mic, Square, Users, Sparkles, X } from "@lucide/svelte";

  let stats = $state<Stats | null>(null);
  let dictations = $state<Dictation[]>([]);
  let recent = $state<RecordingSummary[]>([]);

  let question = $state("");
  let answer = $state("");
  let asking = $state(false);
  let askId = "";

  $effect(() => {
    app.recordingsVersion;
    app.dictationsVersion;
    api.stats().then((s) => (stats = s));
    api.dictations("", 4).then((d) => (dictations = d));
    api.recordings().then((r) => (recent = r.slice(0, 6)));
  });

  const name = $derived(app.settings?.meetings.your_name?.split(" ")[0] ?? "");
  const greeting = $derived.by(() => {
    const h = new Date().getHours();
    return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  });
  // Typing at ~40 wpm vs. the time actually spent speaking.
  const saved = $derived(stats ? Math.max(0, (stats.dictation_words / 40) * 60_000 - stats.dictation_ms) : 0);

  async function newMeeting() {
    try {
      const rec = await api.meetingStart();
      await app.refreshMeeting();
      goto(`/meetings/${rec.id}`);
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function pickFiles() {
    const sel = await open({ multiple: true, filters: [{ name: "Audio & video", extensions: MEDIA_EXTS }] });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    try {
      const recs = await api.addFiles(paths);
      goto(recs.length === 1 ? `/files/${recs[0].id}` : "/files");
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function ask(e: Event) {
    e.preventDefault();
    if (!question.trim() || asking) return;
    answer = "";
    asking = true;
    try {
      const { requestId, result } = await streamLlm((rid) => api.askAll(question, undefined, rid), (d) => (answer += d));
      askId = requestId;
      answer = await result;
    } catch (err) {
      answer = `**Couldn't answer:** ${errorText(err)}`;
    } finally {
      asking = false;
    }
  }
</script>

<div class="page">
  <div class="page-narrow">
    <header class="hello">
      <p class="eyebrow">{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
      <h1>{greeting}{name ? `, ${name}` : ""}.</h1>
    </header>

    <div class="actions">
      <button class="action" onclick={() => api.dictationToggle()}>
        <div class="ic"><Mic size={18} /></div>
        <b>Dictate</b>
        <span>{app.settings?.dictation.activation === "toggle" ? "Press" : "Hold"} <Keys combo={app.settings?.dictation.hotkey ?? "Fn"} /> anywhere</span>
      </button>
      {#if app.meeting}
        <button class="action live" onclick={() => goto(`/meetings/${app.meeting!.id}`)}>
          <div class="ic"><Square size={15} fill="currentColor" /></div>
          <b>Meeting in progress</b>
          <span>Open live notes</span>
        </button>
      {:else}
        <button class="action" onclick={newMeeting}>
          <div class="ic"><Users size={18} /></div>
          <b>Record a meeting</b>
          <span>Mic and system audio, with notes</span>
        </button>
      {/if}
      <button class="action" onclick={pickFiles}>
        <div class="ic"><FileAudio size={18} /></div>
        <b>Transcribe a file</b>
        <span>Or drop audio, video or a link</span>
      </button>
    </div>

    {#if app.settings?.llm_profiles.length}
      <form class="ask card" onsubmit={ask}>
        <Sparkles size={16} />
        <input class="selectable" placeholder="Ask across all your meetings and files…" bind:value={question} />
        {#if asking}
          <button type="button" class="btn icon sm ghost" aria-label="Stop" onclick={() => api.cancelLlm(askId)}><X size={14} /></button>
        {:else}
          <button class="btn icon sm primary" aria-label="Ask" disabled={!question.trim()}><ArrowUp size={14} /></button>
        {/if}
      </form>
      {#if answer || asking}
        <div class="answer card">
          {#if answer}<Markdown source={answer} />{:else}<p class="faint">Reading your transcripts…</p>{/if}
        </div>
      {/if}
    {/if}

    {#if stats}
      <div class="stats">
        <div class="stat">
          <span class="num">{stats.dictation_words.toLocaleString()}</span>
          <span class="lbl">words dictated</span>
        </div>
        <div class="stat">
          <span class="num">{saved >= 60_000 ? duration(saved) : "—"}</span>
          <span class="lbl">saved vs. typing</span>
        </div>
        <div class="stat">
          <span class="num">{stats.meeting_count + stats.file_count}</span>
          <span class="lbl">recordings · {duration(stats.transcribed_ms)}</span>
        </div>
        <div class="stat">
          <span class="num"><Flame size={20} class={stats.streak_days ? "flame" : ""} />{stats.streak_days}</span>
          <span class="lbl">day streak</span>
        </div>
      </div>
    {/if}

    <div class="cols">
      <section>
        <div class="row head"><h3>Recent dictation</h3><a href="/dictation" class="small">See all</a></div>
        {#each dictations as d}
          <div class="dict">
            <p class="selectable">{d.text || d.raw_text}</p>
            <span class="faint small">{relDate(d.created_at)}{d.app ? ` · ${d.app}` : ""}</span>
          </div>
        {:else}
          <p class="faint small pad">Nothing yet. Your dictations will show up here.</p>
        {/each}
      </section>
      <section>
        <div class="row head"><h3>Recent recordings</h3></div>
        {#each recent as r}
          <a class="rec" href={r.kind === "meeting" ? `/meetings/${r.id}` : `/files/${r.id}`}>
            {#if r.kind === "meeting"}<Users size={15} />{:else}<FileAudio size={15} />{/if}
            <div>
              <b>{r.title}</b>
              <span class="faint small">{relDate(r.created_at)}{r.duration_ms ? ` · ${duration(r.duration_ms)}` : ""}</span>
            </div>
            {#if r.status === "recording"}<span class="dot live"></span>{:else if r.status !== "ready"}<span class="chip">{r.status}</span>{/if}
          </a>
        {:else}
          <p class="faint small pad">Meetings and files you transcribe appear here.</p>
        {/each}
      </section>
    </div>
  </div>
</div>

<style>
  .hello {
    margin: 10px 0 26px;
  }
  .hello h1 {
    font-size: 36px;
    margin-top: 6px;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  .action {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 16px;
    border-radius: var(--r-lg);
    border: 1px solid var(--line);
    background: var(--surface);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    box-shadow: var(--shadow);
    transition:
      transform 0.15s var(--ease),
      border-color 0.15s;
  }
  .action:hover {
    transform: translateY(-1px);
    border-color: var(--line-2);
  }
  .action .ic {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    margin-bottom: 8px;
    border-radius: 10px;
    background: var(--ember-soft);
    color: var(--ember-text);
  }
  .action span {
    color: var(--text-3);
    font-size: 12.5px;
  }
  .action span :global(kbd) {
    height: 17px;
    font-size: 10px;
  }
  .action.live {
    border-color: color-mix(in srgb, var(--ember) 40%, transparent);
  }
  .action.live .ic {
    background: var(--ember);
    color: #fff;
  }
  .ask {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
    padding: 6px 6px 6px 14px;
    border-radius: var(--r);
  }
  .ask :global(svg:first-child) {
    color: var(--ember-text);
    flex: none;
  }
  .ask input {
    flex: 1;
    height: 32px;
    border: 0;
    outline: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 14px;
  }
  .ask input::placeholder {
    color: var(--text-3);
  }
  .answer {
    margin-top: 8px;
    padding: 16px 20px;
    border-radius: var(--r);
    max-height: 360px;
    overflow: auto;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    margin: 30px 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .stat {
    display: flex;
    flex-direction: column;
    padding: 18px 4px;
  }
  .stat + .stat {
    padding-left: 20px;
    border-left: 1px solid var(--line);
  }
  .num {
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: var(--serif);
    font-size: 28px;
    line-height: 1.1;
  }
  .num :global(.flame) {
    color: var(--ember);
  }
  .lbl {
    color: var(--text-3);
    font-size: 12px;
    margin-top: 4px;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 28px;
  }
  .head {
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .head h3 {
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 650;
  }
  .dict {
    padding: 10px 0;
    border-top: 1px solid var(--line);
  }
  .dict p {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 2px;
  }
  .rec {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 8px;
    margin: 0 -8px;
    border-radius: var(--r-sm);
    color: inherit;
  }
  .rec:hover {
    background: var(--surface-2);
  }
  .rec > :global(svg) {
    color: var(--text-3);
    flex: none;
  }
  .rec div {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .rec b {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pad {
    padding: 10px 0;
  }
</style>

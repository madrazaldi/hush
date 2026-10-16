<script lang="ts">
  import { goto } from "$app/navigation";
  import { open } from "@tauri-apps/plugin-dialog";
  import { api, errorText, on } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { duration, relDate, LANGUAGES } from "$lib/format";
  import { MEDIA_EXTS, isVideo } from "$lib/media";
  import type { JobProgress, RecordingSummary } from "$lib/types";
  import { FileAudio, FileVideo, Link, Search, Star, Upload, X, CircleAlert, LoaderCircle } from "@lucide/svelte";

  let items = $state<RecordingSummary[]>([]);
  let query = $state("");
  let url = $state("");
  let adding = $state(false);
  let progress = $state<Record<string, JobProgress>>({});

  const s = $derived(app.settings!);

  $effect(() => {
    app.recordingsVersion;
    const q = query;
    const t = setTimeout(() => api.recordings("file", q).then((r) => (items = r)), q ? 180 : 0);
    return () => clearTimeout(t);
  });

  $effect(() =>
    on<JobProgress>("recording:progress", (p) => {
      progress[p.id] = p;
    }),
  );

  async function pick() {
    const sel = await open({ multiple: true, filters: [{ name: "Audio & video", extensions: MEDIA_EXTS }] });
    if (!sel) return;
    try {
      await api.addFiles(Array.isArray(sel) ? sel : [sel]);
      app.recordingsVersion++;
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function addUrl(e: Event) {
    e.preventDefault();
    if (!url.trim()) return;
    adding = true;
    try {
      const rec = await api.addUrl(url.trim());
      url = "";
      app.recordingsVersion++;
      goto(`/files/${rec.id}`);
    } catch (err) {
      app.toast("error", errorText(err));
    } finally {
      adding = false;
    }
  }

  const STAGES: Record<string, string> = {
    downloading: "Downloading",
    decoding: "Reading audio",
    transcribing: "Transcribing",
    summarizing: "Summarizing",
  };

  function status(r: RecordingSummary) {
    const p = progress[r.id];
    const st = p?.status ?? r.status;
    return { st, stage: p?.stage ?? "", pct: p?.progress ?? r.progress, error: p?.error ?? r.error };
  }
</script>

<div class="page">
  <div class="page-narrow">
    <div class="page-head">
      <div>
        <h1>Files</h1>
        <p class="sub">Transcribe recordings, voice memos, podcasts and videos. Everything stays searchable.</p>
      </div>
    </div>

    <div class="import card">
      <button class="drop" onclick={pick}>
        <Upload size={22} strokeWidth={1.6} />
        <b>Drop files anywhere, or click to choose</b>
        <span class="faint small">MP3, M4A, WAV, FLAC, MP4, MOV and more{app.info && !app.info.ffmpeg ? " · install ffmpeg for more formats" : ""}</span>
      </button>
      <form class="url" onsubmit={addUrl}>
        <Link size={14} />
        <input class="selectable" placeholder={app.info?.ytdlp ? "Paste a YouTube, podcast or media link" : "Paste a direct link to an audio or video file"} bind:value={url} />
        <button class="btn sm primary" disabled={!url.trim() || adding}>{adding ? "Adding…" : "Transcribe"}</button>
      </form>
      <div class="opts">
        <label>
          <span>Model</span>
          <select class="select" bind:value={s.files.stt_profile} onchange={() => app.save()}>
            {#each s.stt_profiles as p}<option value={p.id}>{app.sttName(p.id)}</option>{/each}
          </select>
        </label>
        <label>
          <span>Language</span>
          <select class="select" bind:value={s.files.language} onchange={() => app.save()}>
            <option value={null}>Auto-detect</option>
            {#each LANGUAGES as [c, n]}<option value={c}>{n}</option>{/each}
          </select>
        </label>
        <label class="chk">
          <input type="checkbox" bind:checked={s.files.diarize} onchange={() => app.save()} />
          <span>Identify speakers <span class="faint">(cloud providers)</span></span>
        </label>
        {#if s.llm_profiles.length}
          <label class="chk">
            <input type="checkbox" bind:checked={s.files.auto_summarize} onchange={() => app.save()} />
            <span>Summarize automatically</span>
          </label>
        {/if}
      </div>
    </div>

    <div class="row tools">
      <div class="search spacer">
        <Search size={14} />
        <input class="input" placeholder="Search titles and transcripts" bind:value={query} />
      </div>
    </div>

    <div class="list">
      {#each items as r (r.id)}
        {@const st = status(r)}
        <a class="item" href={`/files/${r.id}`}>
          <div class="ic" class:busy={st.st === "processing" || st.st === "queued"}>
            {#if st.st === "error"}<CircleAlert size={16} />
            {:else if st.st === "processing"}<LoaderCircle size={16} class="spin" />
            {:else if isVideo(r.source)}<FileVideo size={16} />
            {:else}<FileAudio size={16} />{/if}
          </div>
          <div class="main">
            <div class="row">
              <b class="title">{r.title}</b>
              {#if r.starred}<Star size={12} fill="currentColor" class="star" />{/if}
            </div>
            {#if st.st === "processing" || st.st === "queued"}
              <div class="row prog">
                <span class="faint small">{st.st === "queued" ? "Waiting in queue" : (STAGES[st.stage] ?? "Working")}{st.pct > 0 ? ` · ${Math.round(st.pct * 100)}%` : ""}</span>
                <div class="progress spacer" class:indeterminate={st.pct <= 0}><div style:width="{st.pct * 100}%"></div></div>
              </div>
            {:else if st.st === "error"}
              <span class="err small">{st.error ?? "Failed"}</span>
            {:else}
              <span class="preview faint small">{r.preview || "No speech detected"}</span>
            {/if}
          </div>
          <div class="side faint small">
            <span>{relDate(r.created_at)}</span>
            {#if r.duration_ms}<span>{duration(r.duration_ms)}</span>{/if}
          </div>
          {#if st.st === "processing" || st.st === "queued"}
            <button
              class="btn icon sm ghost"
              title="Cancel"
              onclick={(e) => {
                e.preventDefault();
                api.cancelJob(r.id);
              }}><X size={14} /></button
            >
          {/if}
        </a>
      {:else}
        <div class="empty">
          <h3>{query ? "No matches" : "No files yet"}</h3>
          <p>{query ? "Try a different search." : "Your transcripts will be listed here."}</p>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .import {
    padding: 8px;
    border-radius: var(--r-lg);
    margin-bottom: 26px;
  }
  .drop {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 26px;
    border-radius: var(--r);
    border: 1.5px dashed var(--line-2);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .drop:hover {
    border-color: var(--ember);
  }
  .drop :global(svg) {
    color: var(--ember-text);
  }
  .url {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 0 0;
    padding: 4px 4px 4px 12px;
    border-radius: var(--r-sm);
    background: var(--surface-2);
  }
  .url :global(svg) {
    color: var(--text-3);
  }
  .url input {
    flex: 1;
    height: 30px;
    border: 0;
    outline: 0;
    background: none;
    color: var(--text);
    font: inherit;
  }
  .opts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 18px;
    padding: 12px 8px 4px;
  }
  .opts label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-2);
    font-size: 12.5px;
  }
  .opts .select {
    width: 190px;
    height: 28px;
    font-size: 12.5px;
  }
  .chk input {
    accent-color: var(--ember);
  }
  .tools {
    margin-bottom: 6px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 10px;
    margin: 0 -10px;
    border-radius: var(--r);
    color: inherit;
  }
  .item:hover {
    background: var(--surface);
  }
  .ic {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text-2);
    flex: none;
  }
  .ic.busy {
    color: var(--ember-text);
    background: var(--ember-soft);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    font-weight: 550;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .main :global(.star) {
    color: var(--amber);
    flex: none;
  }
  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prog {
    gap: 12px;
  }
  .prog .progress {
    max-width: 260px;
  }
  .err {
    color: var(--ember-text);
  }
  .side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    flex: none;
  }
</style>

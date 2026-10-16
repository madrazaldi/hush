<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, errorText } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { dayGroup, duration, groupBy } from "$lib/format";
  import type { RecordingSummary } from "$lib/types";
  import { Mic, NotebookPen, Search, Star, Radar } from "@lucide/svelte";

  let items = $state<RecordingSummary[]>([]);
  let query = $state("");
  let starting = $state(false);

  $effect(() => {
    app.recordingsVersion;
    const q = query;
    const t = setTimeout(() => api.recordings("meeting", q).then((r) => (items = r)), q ? 180 : 0);
    return () => clearTimeout(t);
  });

  const groups = $derived(groupBy(items, (r) => dayGroup(r.created_at)));
  const s = $derived(app.settings!);

  async function record() {
    starting = true;
    try {
      const rec = await api.meetingStart();
      await app.refreshMeeting();
      goto(`/meetings/${rec.id}`);
    } catch (e) {
      app.toast("error", errorText(e));
    } finally {
      starting = false;
    }
  }

  async function note() {
    const rec = await api.meetingCreate();
    goto(`/meetings/${rec.id}`);
  }
</script>

<div class="page">
  <div class="page-narrow">
    <div class="page-head">
      <div>
        <h1>Meetings</h1>
        <p class="sub">Jot what matters; Hush listens to both sides and turns it into clean notes. No bot joins your call.</p>
      </div>
      <div class="row">
        <button class="btn" onclick={note}><NotebookPen size={14} /> New note</button>
        {#if app.meeting}
          <button class="btn primary" onclick={() => goto(`/meetings/${app.meeting!.id}`)}><span class="dot live"></span> Recording…</button>
        {:else}
          <button class="btn primary" onclick={record} disabled={starting}><Mic size={14} /> Record now</button>
        {/if}
      </div>
    </div>

    {#if !s.meetings.detect_meetings}
      <button class="tip" onclick={() => { s.meetings.detect_meetings = true; app.save(); }}>
        <Radar size={15} />
        <span>Turn on meeting detection to get a nudge when Zoom, Meet, Teams or FaceTime starts using your mic.</span>
        <b>Enable</b>
      </button>
    {/if}

    <div class="row tools">
      <div class="search spacer">
        <Search size={14} />
        <input class="input" placeholder="Search meetings, notes and transcripts" bind:value={query} />
      </div>
    </div>

    {#each groups as [day, list]}
      <h4 class="eyebrow day">{day}</h4>
      {#each list as r (r.id)}
        <a class="item" href={`/meetings/${r.id}`}>
          <div class="when mono faint">{new Date(r.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
          <div class="main">
            <div class="row">
              <b>{r.title}</b>
              {#if r.starred}<Star size={12} fill="currentColor" class="star" />{/if}
              {#if r.status === "recording"}<span class="chip ember"><span class="dot live"></span> Live</span>{/if}
              {#if r.status === "processing"}<span class="chip">Finishing…</span>{/if}
            </div>
            <span class="preview faint small">{r.preview || (r.status === "recording" ? "Listening…" : "No transcript")}</span>
          </div>
          {#if r.duration_ms}<span class="faint small">{duration(r.duration_ms)}</span>{/if}
        </a>
      {/each}
    {:else}
      <div class="empty">
        <h3>{query ? "No matches" : "No meetings yet"}</h3>
        <p>{query ? "Try a different search." : "Hit Record when your next call starts, and type notes as you go."}</p>
      </div>
    {/each}
  </div>
</div>

<style>
  .tip {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
    padding: 10px 14px;
    border-radius: var(--r);
    border: 1px dashed var(--line-2);
    background: none;
    color: var(--text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tip span {
    flex: 1;
  }
  .tip b {
    color: var(--ember-text);
    font-weight: 600;
  }
  .tools {
    margin-bottom: 4px;
  }
  .day {
    margin: 22px 0 4px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 10px;
    margin: 0 -10px;
    border-radius: var(--r);
    color: inherit;
  }
  .item:hover {
    background: var(--surface);
  }
  .when {
    width: 64px;
    flex: none;
    font-size: 11.5px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .main b {
    font-weight: 550;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .main :global(.star) {
    color: var(--amber);
  }
  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

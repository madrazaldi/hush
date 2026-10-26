<script lang="ts">
  import { save, writeText } from "#lib/ipc.js";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import type { ExportOptions } from "#lib/types.js";
  import { Download, Copy } from "@lucide/svelte";

  let { id, title, hasNotes = false, hasSpeakers = false }: { id: string; title: string; hasNotes?: boolean; hasSpeakers?: boolean } = $props();

  let open = $state(false);
  let timestamps = $state(true);
  let speakers = $state(true);
  let notes = $state(true);

  const FORMATS: { f: ExportOptions["format"]; label: string; hint: string }[] = [
    { f: "md", label: "Markdown", hint: "Notes and transcript" },
    { f: "txt", label: "Plain text", hint: "Transcript only" },
    { f: "srt", label: "SRT subtitles", hint: "For video editors" },
    { f: "vtt", label: "WebVTT", hint: "Web video captions" },
    { f: "csv", label: "CSV", hint: "Spreadsheet of segments" },
    { f: "json", label: "JSON", hint: "Everything, structured" },
  ];

  function opts(format: ExportOptions["format"]): ExportOptions {
    return { format, timestamps, speakers, include_notes: notes };
  }

  async function exportAs(format: ExportOptions["format"]) {
    open = false;
    const safe = title.replace(/[/\\:*?"<>|]+/g, "-").slice(0, 80) || "transcript";
    const path = await save({ defaultPath: `${safe}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    try {
      await api.exportRecording(id, opts(format), path);
      app.toast("success", "Exported", { label: "Show", run: () => api.reveal(path) });
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function copy() {
    open = false;
    try {
      await writeText(await api.exportText(id, opts("txt")));
      app.toast("success", "Transcript copied");
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }
</script>

<svelte:window onclick={(e) => open && !(e.target as HTMLElement).closest(".exp") && (open = false)} />

<div class="exp">
  <button class="btn sm" onclick={() => (open = !open)}><Download size={13} /> Export</button>
  {#if open}
    <div class="menu card">
      <button class="item" onclick={copy}><Copy size={13} /><span><b>Copy transcript</b></span></button>
      <div class="sep"></div>
      {#each FORMATS as x}
        <button class="item" onclick={() => exportAs(x.f)}>
          <span class="fmt mono">.{x.f}</span><span><b>{x.label}</b><i>{x.hint}</i></span>
        </button>
      {/each}
      <div class="sep"></div>
      <label><input type="checkbox" bind:checked={timestamps} /> Timestamps</label>
      {#if hasSpeakers}<label><input type="checkbox" bind:checked={speakers} /> Speaker names</label>{/if}
      {#if hasNotes}<label><input type="checkbox" bind:checked={notes} /> Include notes & summary</label>{/if}
    </div>
  {/if}
</div>

<style>
  .exp {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 32px;
    z-index: 40;
    width: 250px;
    padding: 6px;
    border-radius: var(--r);
    box-shadow: var(--shadow-pop);
    display: flex;
    flex-direction: column;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .item:hover {
    background: var(--surface-2);
  }
  .item span:last-child {
    display: flex;
    flex-direction: column;
  }
  .item b {
    font-weight: 500;
  }
  .item i {
    font-style: normal;
    font-size: 11.5px;
    color: var(--text-3);
  }
  .fmt {
    width: 38px;
    color: var(--text-3);
    font-size: 11px;
  }
  .sep {
    height: 1px;
    margin: 5px 4px;
    background: var(--line);
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    font-size: 12.5px;
    color: var(--text-2);
  }
  input {
    accent-color: var(--ember);
  }
</style>

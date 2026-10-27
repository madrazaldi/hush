<script lang="ts">
  import { save, writeText } from "#lib/ipc.js";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import type { ExportOptions } from "#lib/types.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { ChevronDown, Copy, Download } from "@lucide/svelte";

  let { id, title, hasNotes = false, hasSpeakers = false }: { id: string; title: string; hasNotes?: boolean; hasSpeakers?: boolean } = $props();

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
    try {
      await writeText(await api.exportText(id, opts("txt")));
      app.toast("success", "Transcript copied");
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button variant="outline" size="sm" {...props}><Download /> Export <ChevronDown class="-mr-0.5 text-muted-foreground" /></Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-64">
    <DropdownMenu.Item onclick={copy}><Copy /> Copy transcript</DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">Save as</DropdownMenu.Label>
    {#each FORMATS as x}
      <DropdownMenu.Item onclick={() => exportAs(x.f)} class="gap-2.5">
        <span class="w-9 font-mono text-[11px] text-muted-foreground">.{x.f}</span>
        <span class="flex flex-col leading-tight">
          <span>{x.label}</span>
          <span class="text-xs text-muted-foreground">{x.hint}</span>
        </span>
      </DropdownMenu.Item>
    {/each}
    <DropdownMenu.Separator />
    <DropdownMenu.CheckboxItem bind:checked={timestamps}>Timestamps</DropdownMenu.CheckboxItem>
    {#if hasSpeakers}<DropdownMenu.CheckboxItem bind:checked={speakers}>Speaker names</DropdownMenu.CheckboxItem>{/if}
    {#if hasNotes}<DropdownMenu.CheckboxItem bind:checked={notes}>Include notes & summary</DropdownMenu.CheckboxItem>{/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

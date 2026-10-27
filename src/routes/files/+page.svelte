<script lang="ts">
  import { goto } from "$app/navigation";
  import { open } from "#lib/ipc.js";
  import { api, errorText, on } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { duration, relDate, languageName, LANGUAGES } from "#lib/format.js";
  import { MEDIA_EXTS, isVideo } from "#lib/media.js";
  import type { JobProgress, RecordingSummary } from "#lib/types.js";
  import Page from "#lib/components/Page.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Progress } from "#lib/components/ui/progress/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as InputGroup from "#lib/components/ui/input-group/index.js";
  import * as Item from "#lib/components/ui/item/index.js";
  import * as Empty from "#lib/components/ui/empty/index.js";
  import { FileAudio, FileVideo, Link, Search, Star, Upload, X, CircleAlert, LoaderCircle, FolderOpen } from "@lucide/svelte";

  let items = $state<RecordingSummary[]>([]);
  let query = $state("");
  let url = $state("");
  let adding = $state(false);
  let progress = $state<Record<string, JobProgress>>({});

  const s = $derived(app.settings!);
  // Select values are strings; "auto" stands for no fixed language.
  const AUTO = "auto";

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

<Page>
  <PageHeader title="Files" description="Transcribe recordings, voice memos, podcasts and videos. Everything stays searchable.">
    {#snippet actions()}
      <Button onclick={pick}><Upload /> Choose files</Button>
    {/snippet}
  </PageHeader>

  <section class="mb-10 overflow-hidden rounded-2xl border bg-card shadow-xs">
    <div class="p-2">
      <button
        class="group flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-input bg-muted/40 px-6 py-8 text-center transition-colors hover:border-ember/50 hover:bg-ember-soft/60"
        onclick={pick}
      >
        <div class="mb-1 grid size-11 place-items-center rounded-xl bg-background text-ember-text shadow-sm ring-1 ring-border transition-transform group-hover:-translate-y-0.5">
          <Upload class="size-5" strokeWidth={1.8} />
        </div>
        <span class="text-sm font-medium">Drop files anywhere, or click to choose</span>
        <span class="text-xs text-muted-foreground">
          MP3, M4A, WAV, FLAC, MP4, MOV and more{app.info && !app.info.ffmpeg ? " · install ffmpeg for more formats" : ""}
        </span>
      </button>
      <form class="mt-2" onsubmit={addUrl}>
        <InputGroup.Root class="h-10 rounded-xl bg-background">
          <InputGroup.Addon><Link /></InputGroup.Addon>
          <InputGroup.Input
            class="selectable"
            placeholder={app.info?.ytdlp ? "Paste a YouTube, podcast or media link" : "Paste a direct link to an audio or video file"}
            bind:value={url}
          />
          <InputGroup.Addon align="inline-end">
            <InputGroup.Button type="submit" variant="default" size="sm" class="h-7 px-3" disabled={!url.trim() || adding}>
              {#if adding}<LoaderCircle class="animate-spin" /> Adding…{:else}Transcribe{/if}
            </InputGroup.Button>
          </InputGroup.Addon>
        </InputGroup.Root>
      </form>
    </div>
    <div class="flex flex-wrap items-center gap-x-6 gap-y-3 border-t bg-muted/30 px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-xs text-muted-foreground">Model</span>
        <Select.Root
          type="single"
          bind:value={
            () => s.files.stt_profile,
            (v) => {
              s.files.stt_profile = v;
              app.save();
            }
          }
        >
          <Select.Trigger size="sm" class="w-48 bg-background"><span class="truncate">{app.sttName(s.files.stt_profile)}</span></Select.Trigger>
          <Select.Content>
            {#each s.stt_profiles as p}<Select.Item value={p.id} label={app.sttName(p.id)} />{/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-muted-foreground">Language</span>
        <Select.Root
          type="single"
          bind:value={
            () => s.files.language ?? AUTO,
            (v) => {
              s.files.language = v === AUTO ? null : v;
              app.save();
            }
          }
        >
          <Select.Trigger size="sm" class="w-40 bg-background">{languageName(s.files.language)}</Select.Trigger>
          <Select.Content class="max-h-72">
            <Select.Item value={AUTO} label="Auto-detect" />
            <Select.Separator />
            {#each LANGUAGES as [c, n]}<Select.Item value={c} label={n} />{/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox id="f-diarize" bind:checked={s.files.diarize} onCheckedChange={() => app.save()} />
        <Label for="f-diarize" class="text-xs font-normal">Identify speakers <span class="text-muted-foreground">(cloud providers)</span></Label>
      </div>
      {#if s.llm_profiles.length}
        <div class="flex items-center gap-2">
          <Checkbox id="f-summarize" bind:checked={s.files.auto_summarize} onCheckedChange={() => app.save()} />
          <Label for="f-summarize" class="text-xs font-normal">Summarize automatically</Label>
        </div>
      {/if}
    </div>
  </section>

  <div class="mb-3 flex items-center justify-between gap-4">
    <h2 class="heading text-xl">Library</h2>
    <InputGroup.Root class="w-72">
      <InputGroup.Addon><Search /></InputGroup.Addon>
      <InputGroup.Input placeholder="Search titles and transcripts" bind:value={query} />
    </InputGroup.Root>
  </div>

  {#if items.length}
    <Item.Group class="gap-0 overflow-hidden rounded-xl border bg-card">
      {#each items as r, i (r.id)}
        {@const st = status(r)}
        {@const busy = st.st === "processing" || st.st === "queued"}
        <Item.Root class="rounded-none border-0 px-4 py-3 {i ? 'border-t border-border' : ''} hover:bg-muted/50">
          {#snippet child({ props })}
            <a href={`/files/${r.id}`} {...props}>
              <Item.Media
                class="size-9 rounded-lg {busy ? 'bg-ember-soft text-ember-text' : st.st === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}"
              >
                {#if st.st === "error"}<CircleAlert class="size-4" />
                {:else if st.st === "processing"}<LoaderCircle class="size-4 animate-spin" />
                {:else if isVideo(r.source)}<FileVideo class="size-4" />
                {:else}<FileAudio class="size-4" />{/if}
              </Item.Media>
              <Item.Content class="min-w-0 gap-0.5">
                <Item.Title class="w-full">
                  <span class="truncate">{r.title}</span>
                  {#if r.starred}<Star class="size-3 shrink-0 text-amber" fill="currentColor" />{/if}
                </Item.Title>
                {#if busy}
                  <div class="flex items-center gap-3">
                    <span class="shrink-0 text-xs text-muted-foreground">
                      {st.st === "queued" ? "Waiting in queue" : (STAGES[st.stage] ?? "Working")}{st.pct > 0 ? ` · ${Math.round(st.pct * 100)}%` : ""}
                    </span>
                    {#if st.pct > 0}
                      <Progress value={st.pct * 100} class="max-w-64" />
                    {:else}
                      <div class="relative h-1 w-full max-w-64 overflow-hidden rounded-full bg-muted">
                        <div class="h-full w-1/3 animate-indeterminate rounded-full bg-primary"></div>
                      </div>
                    {/if}
                  </div>
                {:else if st.st === "error"}
                  <span class="truncate text-xs text-destructive">{st.error ?? "Failed"}</span>
                {:else}
                  <span class="truncate text-xs text-muted-foreground">{r.preview || "No speech detected"}</span>
                {/if}
              </Item.Content>
              <div class="flex shrink-0 flex-col items-end text-xs text-muted-foreground tabular-nums">
                <span>{relDate(r.created_at)}</span>
                {#if r.duration_ms}<span>{duration(r.duration_ms)}</span>{/if}
              </div>
              {#if busy}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  title="Cancel"
                  onclick={(e) => {
                    e.preventDefault();
                    api.cancelJob(r.id);
                  }}><X /></Button
                >
              {/if}
            </a>
          {/snippet}
        </Item.Root>
      {/each}
    </Item.Group>
  {:else}
    <Empty.Root class="rounded-xl border border-dashed py-14">
      <Empty.Header>
        <Empty.Media variant="icon">{#if query}<Search />{:else}<FolderOpen />{/if}</Empty.Media>
        <Empty.Title>{query ? "No matches" : "No files yet"}</Empty.Title>
        <Empty.Description>{query ? "Try a different search." : "Your transcripts will be listed here."}</Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {/if}
</Page>

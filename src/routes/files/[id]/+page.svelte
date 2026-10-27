<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ask } from "#lib/ipc.js";
  import { api, errorText, on, streamLlm } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { duration, relDate, languageName, LANGUAGES, words } from "#lib/format.js";
  import type { JobProgress, Recording, RecordingPatch } from "#lib/types.js";
  import Transcript from "#lib/components/Transcript.svelte";
  import Player from "#lib/components/Player.svelte";
  import Chat from "#lib/components/Chat.svelte";
  import Markdown from "#lib/components/Markdown.svelte";
  import ExportMenu from "#lib/components/ExportMenu.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { Progress } from "#lib/components/ui/progress/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as InputGroup from "#lib/components/ui/input-group/index.js";
  import * as Empty from "#lib/components/ui/empty/index.js";
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
    MessageCircle,
    ExternalLink,
    SearchX,
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

  // The recording a summary is being generated for, if any.
  let summarizingFor = $state<string | null>(null);
  const summarizing = $derived(summarizingFor === id);
  let summaryDraft = $state("");
  let editingSummary = $state(false);
  let summaryReq = "";

  let retxOpen = $state(false);
  let retxProfile = $state("");
  let retxLang = $state<string | null>(null);
  // Select values are strings; "auto" stands for no fixed language.
  const AUTO = "auto";
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

<svelte:window onkeydown={keys} />

{#snippet aiHint(text: string)}
  <div class="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
    <div class="grid size-9 place-items-center rounded-lg bg-ember-soft text-ember-text"><Sparkles class="size-4" /></div>
    <p class="text-xs leading-relaxed text-muted-foreground">{@html text}</p>
  </div>
{/snippet}

{#if !loaded}
  <div></div>
{:else if !rec}
  <Empty.Root class="mt-20">
    <Empty.Header>
      <Empty.Media variant="icon"><SearchX /></Empty.Media>
      <Empty.Title>Not found</Empty.Title>
      <Empty.Description>This file may have been deleted.</Empty.Description>
    </Empty.Header>
    <Empty.Content><Button variant="outline" size="sm" href="/files"><ChevronLeft /> Back to files</Button></Empty.Content>
  </Empty.Root>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <header class="shrink-0 border-b px-8 pt-10 pb-4">
      <a class="relative z-10 -ml-1 inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground" href="/files">
        <ChevronLeft class="size-3.5" /> Files
      </a>
      <div class="mt-1 flex items-center gap-1.5">
        <input
          class="selectable heading field-sizing-content -ml-1.5 max-w-full min-w-32 truncate rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-[26px] leading-tight outline-none hover:border-border focus:border-ring focus:bg-background focus:ring-3 focus:ring-ring/20"
          value={rec.title}
          onchange={(e) => patch({ title: e.currentTarget.value.trim() || rec!.title })}
          onkeydown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          class={rec.starred ? "text-amber hover:text-amber" : "text-muted-foreground"}
          title="Star"
          onclick={() => patch({ starred: !rec!.starred })}
        >
          <Star fill={rec.starred ? "currentColor" : "none"} />
        </Button>
        <span class="flex-1"></span>
        {#if rec.status === "ready"}
          <Button variant="ghost" size="icon-sm" class="text-muted-foreground" title="Search (⌘F)" onclick={() => (searchOpen = !searchOpen)}><Search /></Button>
          <ExportMenu {id} title={rec.title} hasNotes={!!rec.summary} {hasSpeakers} />
        {/if}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button variant="outline" size="icon-sm" title="More" {...props}><Ellipsis /></Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-52">
            <DropdownMenu.Item
              disabled={!!busy}
              onclick={() => {
                retxProfile = rec!.stt ?? app.settings!.files.stt_profile;
                retxLang = rec!.language;
                retxOpen = true;
              }}
            >
              <RefreshCw /> Transcribe again…
            </DropdownMenu.Item>
            {#if app.settings?.llm_profiles.length}
              <DropdownMenu.Item disabled={rec.status !== "ready"} onclick={() => (trOpen = true)}><Languages /> Translate…</DropdownMenu.Item>
            {/if}
            {#if rec.media_path}
              <DropdownMenu.Item onclick={() => api.reveal(rec!.media_path!)}><FolderOpen /> Show in Finder</DropdownMenu.Item>
            {/if}
            <DropdownMenu.Separator />
            <DropdownMenu.Item variant="destructive" onclick={remove}><Trash2 /> Delete</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" class="font-normal">{relDate(rec.created_at)}</Badge>
        {#if rec.duration_ms}<Badge variant="secondary" class="font-normal">{duration(rec.duration_ms)}</Badge>{/if}
        {#if rec.segments.length}<Badge variant="secondary" class="font-normal">{words(rec.segments.map((s) => s.text).join(" ")).toLocaleString()} words</Badge>{/if}
        {#if rec.language}<Badge variant="outline" class="font-normal text-muted-foreground">{languageName(rec.language)}</Badge>{/if}
        {#if rec.stt}<Badge variant="outline" class="font-normal text-muted-foreground">{app.sttName(rec.stt)}</Badge>{/if}
        {#if rec.source && /^https?:/.test(rec.source)}
          <Badge variant="outline" href={rec.source} target="_blank" rel="noreferrer" class="font-normal text-ember-text">Source <ExternalLink /></Badge>
        {/if}
      </div>
    </header>

    <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
      <div class="relative flex min-h-0 min-w-0 flex-col">
        {#if searchOpen}
          <div class="tsearch shrink-0 px-8 pt-4">
            <InputGroup.Root class="bg-background">
              <InputGroup.Addon><Search /></InputGroup.Addon>
              <InputGroup.Input
                class="selectable"
                placeholder="Find in transcript"
                bind:value={query}
                onkeydown={(e) => e.key === "Enter" && transcriptView?.scrollToFirstMatch()}
              />
              <InputGroup.Addon align="inline-end">
                {#if query}<InputGroup.Text class="text-xs font-normal">{matches} {matches === 1 ? "match" : "matches"}</InputGroup.Text>{/if}
                <InputGroup.Button
                  size="icon-xs"
                  aria-label="Close search"
                  onclick={() => {
                    searchOpen = false;
                    query = "";
                  }}><X /></InputGroup.Button
                >
              </InputGroup.Addon>
            </InputGroup.Root>
          </div>
        {/if}

        <div class="scroll flex flex-1 flex-col overflow-y-auto px-8 pt-6 pb-8">
          {#if busy}
            <div class="m-auto flex flex-col items-center gap-3 p-10 text-center">
              <div class="grid size-12 place-items-center rounded-2xl bg-ember-soft text-ember-text"><LoaderCircle class="size-5 animate-spin" /></div>
              <h3 class="heading text-xl">
                {rec.status === "queued"
                  ? "Waiting in queue"
                  : job?.stage === "downloading"
                    ? "Downloading media"
                    : job?.stage === "decoding"
                      ? "Reading audio"
                      : "Transcribing"}
              </h3>
              {#if job && job.progress > 0}
                <Progress value={job.progress * 100} class="w-64" />
              {:else}
                <div class="relative h-1 w-64 overflow-hidden rounded-full bg-muted"><div class="h-full w-1/3 animate-indeterminate rounded-full bg-primary"></div></div>
              {/if}
              <p class="text-xs text-muted-foreground">{app.sttName(rec.stt ?? app.settings?.files.stt_profile)} · you can keep using Hush meanwhile</p>
              <Button variant="outline" size="sm" onclick={() => api.cancelJob(id)}>Cancel</Button>
            </div>
          {:else if rec.status === "error"}
            <Empty.Root class="m-auto">
              <Empty.Header>
                <Empty.Media variant="icon" class="bg-destructive/10 text-destructive"><CircleAlert /></Empty.Media>
                <Empty.Title class="heading text-xl">Transcription failed</Empty.Title>
                <Empty.Description class="selectable max-w-md [overflow-wrap:anywhere]">{rec.error}</Empty.Description>
              </Empty.Header>
              <Empty.Content>
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => {
                    retxProfile = rec!.stt ?? app.settings!.files.stt_profile;
                    retxLang = rec!.language;
                    retxOpen = true;
                  }}
                >
                  <RefreshCw /> Try again
                </Button>
              </Empty.Content>
            </Empty.Root>
          {:else if !rec.segments.length}
            <Empty.Root class="m-auto">
              <Empty.Header>
                <Empty.Title class="heading text-xl">No speech found</Empty.Title>
                <Empty.Description>This file didn't contain recognizable speech.</Empty.Description>
              </Empty.Header>
            </Empty.Root>
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
          <div class="shrink-0 px-6 pt-1 pb-4">
            <Player bind:this={player} path={rec.media_path ?? rec.audio_path} fallback={rec.audio_path} bind:currentMs durationMs={rec.duration_ms} />
          </div>
        {/if}
      </div>

      <aside class="flex min-h-0 flex-col gap-4 border-l bg-muted/30 p-4">
        <Tabs.Root bind:value={() => panel, (v) => (panel = v as typeof panel)}>
          <Tabs.List class="w-full">
            <Tabs.Trigger value="summary"><Sparkles /> Summary</Tabs.Trigger>
            <Tabs.Trigger value="chat"><MessageCircle /> Ask</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
        {#if !app.settings?.llm_profiles.length}
          {@render aiHint('Connect an AI in <a href="/settings?tab=ai">Settings → AI</a> to summarize, translate and chat with transcripts.')}
        {:else if panel === "summary"}
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {#if rec.summary || summarizing}
              {#if editingSummary}
                <Textarea bind:value={summaryDraft} rows={18} class="field-sizing-fixed bg-background" />
                <div class="flex gap-1.5">
                  <Button
                    size="sm"
                    onclick={() => {
                      patch({ summary: summaryDraft });
                      editingSummary = false;
                    }}>Save</Button
                  >
                  <Button variant="ghost" size="sm" onclick={() => (editingSummary = false)}>Cancel</Button>
                </div>
              {:else}
                <Markdown source={rec.summary || "…"} class="text-[13.5px]" />
                <div class="flex gap-1">
                  {#if summarizing}
                    <Button variant="outline" size="sm" onclick={() => api.cancelLlm(summaryReq)}><LoaderCircle class="animate-spin" /> Stop</Button>
                  {:else}
                    <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={summarize}><RefreshCw /> Regenerate</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="text-muted-foreground"
                      onclick={() => {
                        summaryDraft = rec!.summary;
                        editingSummary = true;
                      }}><Pencil /> Edit</Button
                    >
                  {/if}
                </div>
              {/if}
            {:else}
              <div class="flex flex-col items-start gap-3 rounded-xl border bg-background p-4 shadow-xs">
                <div class="grid size-9 place-items-center rounded-lg bg-ember-soft text-ember-text"><Sparkles class="size-4" /></div>
                <div>
                  <p class="text-sm font-medium">Summarize this file</p>
                  <p class="mt-0.5 text-xs text-muted-foreground">Get the gist, key points and action items in a few seconds.</p>
                </div>
                <Button size="sm" disabled={rec.status !== "ready" || !rec.segments.length} onclick={summarize}>Summarize</Button>
              </div>
            {/if}
          </div>
        {:else}
          <div class="min-h-0 flex-1">
            <Chat
              {id}
              bind:messages={rec.chat}
              llmName={app.llmName(app.settings.files.llm_profile)}
              suggestions={["What are the key takeaways?", "List every action item with an owner", "What questions were left unanswered?"]}
            />
          </div>
        {/if}
      </aside>
    </div>
  </div>
{/if}

<Dialog.Root bind:open={retxOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="heading text-xl">Transcribe again</Dialog.Title>
      <Dialog.Description>Edits to the current transcript will be replaced.</Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-4 py-1">
      <div class="grid gap-1.5">
        <Label class="text-xs text-muted-foreground">Speech model</Label>
        <Select.Root type="single" bind:value={retxProfile}>
          <Select.Trigger class="w-full"><span class="truncate">{app.sttName(retxProfile)}</span></Select.Trigger>
          <Select.Content>
            {#each app.settings?.stt_profiles ?? [] as p}<Select.Item value={p.id} label={app.sttName(p.id)} />{/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="grid gap-1.5">
        <Label class="text-xs text-muted-foreground">Language</Label>
        <Select.Root type="single" bind:value={() => retxLang ?? AUTO, (v) => (retxLang = v === AUTO ? null : v)}>
          <Select.Trigger class="w-full">{languageName(retxLang)}</Select.Trigger>
          <Select.Content class="max-h-72">
            <Select.Item value={AUTO} label="Auto-detect" />
            <Select.Separator />
            {#each LANGUAGES as [c, n]}<Select.Item value={c} label={n} />{/each}
          </Select.Content>
        </Select.Root>
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (retxOpen = false)}>Cancel</Button>
      <Button onclick={retranscribe}><RefreshCw /> Transcribe</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={trOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="heading text-xl">Translate transcript</Dialog.Title>
      <Dialog.Description>Creates a translated copy with the same timestamps, using {app.llmName(app.settings?.files.llm_profile)}.</Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-1.5 py-1">
      <Label for="tr-lang" class="text-xs text-muted-foreground">Language</Label>
      <Input id="tr-lang" list="langs" bind:value={trLang} placeholder="Language" />
      <datalist id="langs">{#each LANGUAGES as [, n]}<option value={n}></option>{/each}</datalist>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (trOpen = false)}>Cancel</Button>
      <Button disabled={translating || !trLang.trim()} onclick={translate}>
        {#if translating}<LoaderCircle class="animate-spin" /> Translating…{:else}<Languages /> Translate{/if}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

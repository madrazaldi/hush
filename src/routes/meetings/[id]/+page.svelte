<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { ask, writeText } from "#lib/ipc.js";
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
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as Empty from "#lib/components/ui/empty/index.js";
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
    SearchX,
    NotebookPen,
    AudioLines,
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
  let stopping = $state(false);

  const live = $derived(app.meeting?.id === id);
  const s = $derived(app.settings!);
  const hasAi = $derived(!!s.llm_profiles.length);

  // Meeting whose notes to regenerate once its re-transcription finishes.
  let regenerateFor: string | null = null;

  async function retranscribe() {
    const ok = await ask("This replaces the transcript with a fresh one from the saved recording. Edits to the transcript are lost.", {
      title: "Re-transcribe meeting?",
      kind: "warning",
      okLabel: "Re-transcribe",
    });
    if (!ok) return;
    // Notes generated from the old transcript would go stale; replacing them
    // (and any edits to them) is the user's call.
    const regen =
      !!rec?.enhanced &&
      hasAi &&
      (await ask("Regenerate the notes from the new transcript when it's ready? This replaces the current notes, including any edits.", {
        title: "Update notes?",
        kind: "info",
        okLabel: "Regenerate",
        cancelLabel: "Keep notes",
      }));
    try {
      await api.retranscribe(id);
      regenerateFor = regen ? id : null;
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

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
      on<{ id: string; status: string; error: string | null }>("recording:progress", (p) => {
        if (p.id !== id || !rec || p.status === rec.status) return;
        if (p.status === "error") {
          regenerateFor = null;
          app.toast("error", `Re-transcription failed: ${p.error ?? "unknown error"}`);
        } else if (p.status === "ready" && regenerateFor === id) {
          regenerateFor = null;
          enhance();
        }
        load();
      }),
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

{#snippet noAi(text: string)}
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
      <Empty.Description>This meeting may have been deleted.</Empty.Description>
    </Empty.Header>
    <Empty.Content><Button variant="outline" size="sm" href="/meetings"><ChevronLeft /> Back to meetings</Button></Empty.Content>
  </Empty.Root>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <header class="shrink-0 border-b px-8 pt-10 pb-4">
      <a class="relative z-10 -ml-1 inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground" href="/meetings">
        <ChevronLeft class="size-3.5" /> Meetings
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
        {#if !live && rec.status === "ready" && rec.segments.length}
          <ExportMenu {id} title={rec.title} hasNotes={!!(rec.notes || rec.enhanced)} hasSpeakers />
        {/if}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button variant="outline" size="icon-sm" title="More" {...props}><Ellipsis /></Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-52">
            {#if rec.enhanced}
              <DropdownMenu.Item
                onclick={() => {
                  writeText(rec!.enhanced);
                  app.toast("success", "Notes copied");
                }}><Copy /> Copy notes</DropdownMenu.Item
              >
            {/if}
            {#if rec.audio_path}
              <DropdownMenu.Item onclick={() => api.reveal(rec!.audio_path!)}><Mic /> Show recording</DropdownMenu.Item>
            {/if}
            {#if rec.audio_path && !live}
              <DropdownMenu.Item disabled={rec.status === "processing"} onclick={retranscribe}><RefreshCw /> Re-transcribe</DropdownMenu.Item>
            {/if}
            {#if rec.enhanced || rec.audio_path}<DropdownMenu.Separator />{/if}
            <DropdownMenu.Item variant="destructive" disabled={live} onclick={remove}><Trash2 /> Delete</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <Button variant="ghost" size="icon-sm" class="text-muted-foreground" title="Toggle side panel" onclick={() => (side = !side)}>
          {#if side}<PanelRightClose />{:else}<PanelRightOpen />{/if}
        </Button>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        {#if live}
          <Badge class="bg-ember-soft text-ember-text"><span class="size-1.5 animate-pulse-ring rounded-full bg-ember"></span> Live</Badge>
        {/if}
        <Badge variant="secondary" class="font-normal">{relDate(rec.created_at)}</Badge>
        {#if rec.duration_ms && !live}<Badge variant="secondary" class="font-normal">{duration(rec.duration_ms)}</Badge>{/if}
        {#if Object.keys(rec.speakers).length}
          <Badge variant="outline" class="font-normal text-muted-foreground">{Object.values(rec.speakers).join(", ")}</Badge>
        {/if}
      </div>
    </header>

    {#if live && app.meeting}
      <div class="flex shrink-0 items-center gap-3 border-b bg-ember-soft/40 py-2 pr-6 pl-8">
        <span class="size-2 rounded-full {app.meeting.paused ? 'bg-muted-foreground/50' : 'animate-pulse-ring bg-ember'}"></span>
        <b class="font-mono text-[13px] font-semibold tabular-nums">{clock(app.meeting.elapsed_ms)}</b>
        <span class="text-xs text-muted-foreground">{app.meeting.paused ? "Paused" : "Recording"}</span>
        <div class="ml-3 flex gap-4">
          <Levels label="You" level={app.meeting.paused ? 0 : levels.me} active={app.meeting.mic} />
          <Levels label={rec.speakers["Them"] || "Them"} level={app.meeting.paused ? 0 : levels.them} active={app.meeting.system} tone="sage" />
        </div>
        {#if app.meeting.system_error}
          <button
            class="inline-flex h-6 items-center gap-1.5 rounded-full bg-amber-soft px-2.5 text-xs font-medium text-amber"
            title={app.meeting.system_error}
            onclick={() => api.openPrivacy("system_audio")}
          >
            <TriangleAlert class="size-3" /> Mic only — allow system audio
          </button>
        {/if}
        <span class="flex-1"></span>
        <Button variant="outline" size="sm" class="bg-background" onclick={() => api.meetingPause(!app.meeting!.paused).then(() => app.refreshMeeting())}>
          {#if app.meeting.paused}<Play /> Resume{:else}<Pause /> Pause{/if}
        </Button>
        <Button size="sm" onclick={stop} disabled={stopping}>
          {#if stopping}<LoaderCircle class="animate-spin" /> Finishing…{:else}<Square class="size-3" fill="currentColor" /> Stop{/if}
        </Button>
      </div>
    {:else if rec.status === "processing"}
      <div class="flex shrink-0 items-center gap-2 border-b bg-muted/40 py-2 pr-6 pl-8 text-sm text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin text-ember-text" /> Finishing the transcript…
      </div>
    {/if}

    <div class="grid min-h-0 flex-1 {side ? 'grid-cols-[minmax(0,1fr)_340px]' : 'grid-cols-1'}">
      <div class="flex min-h-0 min-w-0 flex-col">
        {#if !live && (rec.segments.length || rec.enhanced)}
          <div class="flex shrink-0 items-center gap-1.5 px-8 pt-4">
            <Tabs.Root bind:value={() => view, (v) => (view = v as typeof view)}>
              <Tabs.List>
                {#if hasAi || rec.enhanced}<Tabs.Trigger value="enhanced" class="px-2.5"><Sparkles /> Notes</Tabs.Trigger>{/if}
                <Tabs.Trigger value="notes" class="px-2.5"><NotebookPen /> My notes</Tabs.Trigger>
                <Tabs.Trigger value="transcript" class="px-2.5"><AudioLines /> Transcript</Tabs.Trigger>
              </Tabs.List>
            </Tabs.Root>
            {#if view === "enhanced" && hasAi}
              <span class="flex-1"></span>
              <Select.Root
                type="single"
                value={rec.template_id ?? s.meetings.default_template}
                disabled={enhancing}
                onValueChange={(t) => {
                  patch({ template_id: t });
                  enhance(t);
                }}
              >
                <Select.Trigger size="sm" class="w-44"><span class="truncate">{template?.name ?? "Template"}</span></Select.Trigger>
                <Select.Content align="end">
                  {#each s.meetings.templates as t}<Select.Item value={t.id} label={t.name} />{/each}
                </Select.Content>
              </Select.Root>
              {#if rec.enhanced && !enhancing}
                <Button variant="ghost" size="icon-sm" class="text-muted-foreground" title="Regenerate" onclick={() => enhance()}><RefreshCw /></Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  title="Edit"
                  onclick={() => {
                    enhancedDraft = rec!.enhanced;
                    editingEnhanced = true;
                  }}><Pencil /></Button
                >
              {/if}
            {/if}
          </div>
        {/if}

        <div class="scroll flex flex-1 flex-col overflow-y-auto px-8 pt-6 pb-10">
          {#if view === "notes" || live || (!rec.segments.length && !rec.enhanced)}
            <div class="flex max-w-3xl flex-1 flex-col gap-4">
              {#if !live && !rec.segments.length && rec.status !== "processing"}
                <div class="flex items-center gap-5 rounded-2xl border bg-card p-5 shadow-xs">
                  <div class="grid size-11 shrink-0 place-items-center rounded-xl bg-ember-soft text-ember-text"><Mic class="size-5" /></div>
                  <div class="flex-1">
                    <h3 class="heading text-lg">Ready when you are</h3>
                    <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      Hush records your mic{s.meetings.capture_system_audio ? " and the call's audio" : ""}. Type the things you'd want to remember — Hush fills in the rest.
                    </p>
                  </div>
                  <Button onclick={start} disabled={!!app.meeting}><Mic /> Start recording</Button>
                </div>
              {/if}
              <textarea
                class="notes selectable min-h-80 flex-1 resize-none bg-transparent text-[15.5px] leading-[1.75] outline-none"
                placeholder={live ? "Write notes… key points, questions, decisions. Rough is fine." : "Agenda, context, or notes…"}
                bind:value={notes}
                oninput={onNotes}
              ></textarea>
              {#if !live && rec.segments.length && hasAi && !rec.enhanced && !enhancing}
                <Button class="self-start" onclick={() => enhance()}><Sparkles /> Enhance notes with {template?.name ?? "template"}</Button>
              {/if}
            </div>
          {:else if view === "enhanced"}
            <div class="max-w-3xl">
              {#if editingEnhanced}
                <Textarea class="field-sizing-fixed font-mono text-[13px]" rows={24} bind:value={enhancedDraft} />
                <div class="mt-3 flex gap-1.5">
                  <Button
                    size="sm"
                    onclick={() => {
                      patch({ enhanced: enhancedDraft });
                      editingEnhanced = false;
                    }}>Save</Button
                  >
                  <Button variant="ghost" size="sm" onclick={() => (editingEnhanced = false)}>Cancel</Button>
                </div>
              {:else if rec.enhanced}
                <Markdown source={rec.enhanced} class="text-[15px]! leading-[1.7]!" />
                {#if enhancing}<span class="cursor"></span>{/if}
              {:else if enhancing}
                <div class="mx-auto my-16 flex flex-col items-center gap-3 text-center">
                  <div class="grid size-11 place-items-center rounded-xl bg-ember-soft text-ember-text"><LoaderCircle class="size-5 animate-spin" /></div>
                  <p class="text-sm text-muted-foreground">Writing notes from your transcript{notes ? " and jottings" : ""}…</p>
                </div>
              {:else}
                <Empty.Root class="my-10">
                  <Empty.Header>
                    <Empty.Media variant="icon" class="size-11 rounded-xl bg-ember-soft text-ember-text"><Sparkles class="size-5" /></Empty.Media>
                    <Empty.Title class="heading text-xl">Turn this into notes</Empty.Title>
                    <Empty.Description>Combines your jottings with the transcript using the “{template?.name}” template.</Empty.Description>
                  </Empty.Header>
                  <Empty.Content><Button onclick={() => enhance()}><Sparkles /> Enhance notes</Button></Empty.Content>
                </Empty.Root>
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
          <div class="shrink-0 px-6 pt-1 pb-4">
            <Player bind:this={player} path={rec.audio_path} bind:currentMs durationMs={rec.duration_ms} />
          </div>
        {/if}
      </div>

      {#if side}
        <aside class="flex min-h-0 flex-col border-l bg-muted/30 p-4">
          {#if live || (!rec.enhanced && view !== "transcript" && rec.segments.length && !hasAi)}
            <div class="mb-3 flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {#if live}<span class="size-1.5 animate-pulse-ring rounded-full bg-ember"></span>{/if} Live transcript
            </div>
            <div class="scroll livet flex-1 overflow-y-auto">
              {#if rec.segments.length}
                <Transcript segments={rec.segments} speakers={rec.speakers} live showTimes={false} editable={false} />
              {:else}
                <p class="text-xs leading-relaxed text-muted-foreground">
                  {live ? "Listening… lines appear a few seconds after someone stops talking." : "No transcript yet."}
                </p>
              {/if}
            </div>
          {:else if hasAi && rec.segments.length}
            <Chat {id} bind:messages={rec.chat} recipes={s.meetings.recipes} llmName={app.llmName(s.meetings.llm_profile)} />
          {:else if !hasAi}
            {@render noAi(
              'Connect an AI in <a href="/settings?tab=ai">Settings → AI</a> to enhance notes, run recipes like “Write follow-up email”, and chat with your meeting.',
            )}
          {:else}
            <p class="p-1 text-xs text-muted-foreground">Record the meeting to ask questions about it here.</p>
          {/if}
        </aside>
      {/if}
    </div>
  </div>
{/if}

<style>
  .notes::placeholder {
    color: var(--muted-foreground);
    opacity: 0.7;
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 17px;
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
  .livet :global(.text) {
    font-size: 13px;
    line-height: 1.55;
  }
</style>

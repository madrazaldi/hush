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
  import Page from "#lib/components/Page.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import * as InputGroup from "#lib/components/ui/input-group/index.js";
  import { Spinner } from "#lib/components/ui/spinner/index.js";
  import { ArrowRight, ArrowUp, ChevronRight, FileAudio, Flame, Mic, Square, Users, Sparkles, X } from "@lucide/svelte";

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

  const actionClass =
    "group flex flex-col items-start gap-1 rounded-xl border bg-card p-4 text-left shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-ember/30 hover:shadow-md";

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

{#snippet action(icon: typeof Mic, title: string, live = false)}
  <div
    class="mb-3 grid size-9 place-items-center rounded-lg transition-colors {live
      ? 'bg-ember text-primary-foreground shadow-[0_6px_16px_-6px_var(--ember)]'
      : 'bg-ember-soft text-ember-text group-hover:bg-ember group-hover:text-primary-foreground'}"
  >
    {#if icon === Square}<Square class="size-3.5" fill="currentColor" />{:else}{@const Icon = icon}<Icon class="size-[18px]" />{/if}
  </div>
  <div class="flex items-center gap-1 font-semibold">
    {title}
    <ArrowRight class="size-3.5 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
  </div>
{/snippet}

{#snippet stat(num: string, label: string, flame = false)}
  <div class="flex flex-col gap-1 px-5 py-4">
    <span class="heading flex items-center gap-1.5 text-[28px] leading-none tabular-nums">
      {#if flame}<Flame class="size-5 {stats?.streak_days ? 'fill-ember/20 text-ember' : 'text-muted-foreground'}" />{/if}{num}
    </span>
    <span class="text-xs text-muted-foreground">{label}</span>
  </div>
{/snippet}

<Page>
  <header class="mb-8">
    <p class="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
      {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
    </p>
    <h1 class="heading text-[40px] leading-[1.1]">{greeting}{name ? `, ${name}` : ""}<span class="text-ember">.</span></h1>
  </header>


  <div class="grid grid-cols-3 gap-3">
    <button class={actionClass} onclick={() => api.dictationToggle()}>
      {@render action(Mic, "Dictate")}
      <span class="text-xs text-muted-foreground">
        {app.settings?.dictation.activation === "toggle" ? "Press" : "Hold"}
        <Keys combo={app.settings?.dictation.hotkey ?? "Fn"} class="[&_kbd]:h-[18px] [&_kbd]:text-[10px]" /> anywhere
      </span>
    </button>
    {#if app.meeting}
      <button class="{actionClass} border-ember/40 bg-ember-soft hover:border-ember/60" onclick={() => goto(`/meetings/${app.meeting!.id}`)}>
        {@render action(Square, "Meeting in progress", true)}
        <span class="flex items-center gap-1.5 text-xs text-ember-text">
          <span class="size-1.5 rounded-full bg-ember animate-pulse-ring"></span> Open live notes
        </span>
      </button>
    {:else}
      <button class={actionClass} onclick={newMeeting}>
        {@render action(Users, "Record a meeting")}
        <span class="text-xs text-muted-foreground">Mic and system audio, with notes</span>
      </button>
    {/if}
    <button class={actionClass} onclick={pickFiles}>
      {@render action(FileAudio, "Transcribe a file")}
      <span class="text-xs text-muted-foreground">Or drop audio, video or a link</span>
    </button>
  </div>

  {#if app.settings?.llm_profiles.length}
    <form class="mt-4" onsubmit={ask}>
      <InputGroup.Root class="h-11 rounded-xl bg-card shadow-xs has-disabled:bg-card has-disabled:opacity-100 dark:bg-card dark:has-disabled:bg-card">
        <InputGroup.Addon class="pl-3.5 text-ember-text"><Sparkles /></InputGroup.Addon>
        <InputGroup.Input class="selectable text-sm" placeholder="Ask across all your meetings and files…" bind:value={question} />
        <InputGroup.Addon align="inline-end" class="pr-2">
          {#if asking}
            <InputGroup.Button type="button" size="icon-sm" variant="ghost" class="size-7" aria-label="Stop" onclick={() => api.cancelLlm(askId)}><X /></InputGroup.Button>
          {:else}
            <InputGroup.Button type="submit" size="icon-sm" variant="default" class="size-7 rounded-lg" aria-label="Ask" disabled={!question.trim()}><ArrowUp /></InputGroup.Button>
          {/if}
        </InputGroup.Addon>
      </InputGroup.Root>
    </form>
    {#if answer || asking}
      <Card.Root class="mt-2 max-h-[360px] overflow-auto px-5 py-4">
        {#if answer}
          <Markdown source={answer} />
        {:else}
          <p class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner class="size-3.5" /> Reading your transcripts…</p>
        {/if}
      </Card.Root>
    {/if}
  {/if}

  {#if stats}
    <div class="mt-8 grid grid-cols-4 divide-x rounded-xl border bg-card shadow-xs">
      {@render stat(stats.dictation_words.toLocaleString(), "words dictated")}
      {@render stat(saved >= 60_000 ? duration(saved) : "—", "saved vs. typing")}
      {@render stat(String(stats.meeting_count + stats.file_count), `recordings · ${duration(stats.transcribed_ms)}`)}
      {@render stat(String(stats.streak_days), "day streak", true)}
    </div>
  {/if}


  <div class="mt-8 grid grid-cols-2 gap-4">
    <Card.Root class="gap-0 py-0">
      <Card.Header class="flex items-center justify-between border-b py-3!">
        <Card.Title class="text-[13px] font-semibold">Recent dictation</Card.Title>
        <Button variant="ghost" size="xs" href="/dictation" class="-mr-1.5 text-muted-foreground">See all <ChevronRight /></Button>
      </Card.Header>
      <div class="divide-y">
        {#each dictations as d}
          <div class="px-4 py-3">
            <p class="selectable line-clamp-2 text-[13.5px] leading-relaxed">{d.text || d.raw_text}</p>
            <span class="mt-1 block text-xs text-muted-foreground">{relDate(d.created_at)}{d.app ? ` · ${d.app}` : ""}</span>
          </div>
        {:else}
          <p class="px-4 py-8 text-center text-xs text-muted-foreground">Nothing yet. Your dictations will show up here.</p>
        {/each}
      </div>
    </Card.Root>

    <Card.Root class="gap-0 py-0">
      <Card.Header class="flex items-center justify-between border-b py-3!">
        <Card.Title class="text-[13px] font-semibold">Recent recordings</Card.Title>
        <Button variant="ghost" size="xs" href="/files" class="-mr-1.5 text-muted-foreground">Files <ChevronRight /></Button>
      </Card.Header>
      <div class="p-1.5">
        {#each recent as r}
          <a
            class="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted"
            href={r.kind === "meeting" ? `/meetings/${r.id}` : `/files/${r.id}`}
          >
            <div class="grid size-8 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground">
              {#if r.kind === "meeting"}<Users class="size-4" />{:else}<FileAudio class="size-4" />{/if}
            </div>
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-[13.5px] font-medium">{r.title}</span>
              <span class="text-xs text-muted-foreground">{relDate(r.created_at)}{r.duration_ms ? ` · ${duration(r.duration_ms)}` : ""}</span>
            </div>
            {#if r.status === "recording"}
              <span class="size-2 rounded-full bg-ember animate-pulse-ring"></span>
            {:else if r.status !== "ready"}
              <Badge variant="secondary" class="capitalize">{r.status}</Badge>
            {/if}
          </a>
        {:else}
          <p class="px-4 py-8 text-center text-xs text-muted-foreground">Meetings and files you transcribe appear here.</p>
        {/each}
      </div>
    </Card.Root>
  </div>
</Page>

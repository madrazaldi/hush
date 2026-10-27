<script lang="ts">
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { bytes } from "#lib/format.js";
  import type { CliStatus } from "#lib/types.js";
  import { LLM_KINDS } from "#lib/providers.js";
  import Keys from "./Keys.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Progress } from "#lib/components/ui/progress/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { cn } from "#lib/utils.js";
  import { Check, Download, Mic, Keyboard, Speaker, Sparkles, ArrowRight, ArrowLeft, FileAudio, Users } from "@lucide/svelte";
  import { fade, fly } from "svelte/transition";

  let step = $state(0);
  let clis = $state<CliStatus[] | null>(null);
  const steps = ["Welcome", "Permissions", "Speech", "AI", "Try it"];
  const FEATURES = [
    [Keyboard, "Dictation", "Hold a key, talk, release. Polished text appears where you type."],
    [FileAudio, "Files", "Drop audio, video or a link and get a searchable, timestamped transcript."],
    [Users, "Meetings", "Jot rough notes; Hush listens to both sides and writes them up."],
  ] as const;

  const s = $derived(app.settings!);
  const p = $derived(app.permissions);
  const localModel = $derived(s.stt_profiles.find((x) => x.id === "local")?.model ?? "parakeet-tdt-0.6b-v3");
  const recommended = $derived(app.models.filter((m) => m.recommended).sort((a, b) => a.rank - b.rank).slice(0, 4));
  const current = $derived(app.models.find((m) => m.id === localModel));

  $effect(() => {
    if (step === 3 && !clis) api.detectClis().then((c) => (clis = c));
  });

  function pickModel(id: string) {
    const prof = s.stt_profiles.find((x) => x.id === "local");
    if (prof) prof.model = id;
    app.save();
  }

  async function download(id: string) {
    pickModel(id);
    try {
      const m = app.models.find((m) => m.id === id);
      if (m) m.downloading = 0;
      await api.downloadModel(id);
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function micAccess() {
    try {
      await api.requestMicrophone();
    } catch (e) {
      api.openPrivacy("microphone");
    }
    app.refreshPermissions();
  }

  function finish() {
    s.general.onboarded = true;
    app.save(true);
  }
</script>

{#snippet granted(text: string)}<Badge class="bg-sage-soft text-sage"><Check /> {text}</Badge>{/snippet}

{#snippet row(Icon: typeof Mic, title: string, sub: string, ok: boolean, control: import("svelte").Snippet, mono = false)}
  <div class="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-xs">
    <div class={cn("grid size-10 shrink-0 place-items-center rounded-lg", ok ? "bg-sage-soft text-sage" : "bg-muted text-muted-foreground")}>
      <Icon class="size-5" />
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-sm font-medium">{title}</span>
      <span class={cn("text-[13px] leading-snug text-muted-foreground", mono && "truncate font-mono text-xs")}>{sub}</span>
    </div>
    <div class="shrink-0">{@render control()}</div>
  </div>
{/snippet}

<div class="fixed inset-0 z-[70] grid place-items-center bg-background/60 p-6 backdrop-blur-xl" transition:fade={{ duration: 200 }}>
  <div
    class="flex h-[600px] max-h-full w-[860px] max-w-full overflow-hidden rounded-2xl border bg-card shadow-2xl ring-1 ring-foreground/5"
    in:fly={{ y: 16, duration: 280 }}
  >
    <!-- Step rail -->
    <aside class="flex w-56 shrink-0 flex-col border-r bg-sidebar px-5 pt-7 pb-5">
      <div class="mb-8 flex items-center gap-2.5">
        <div class="flex h-7 items-center gap-[3px]" aria-hidden="true">
          {#each [8, 16, 24, 18, 10] as h, i}
            <i class={cn("w-[3px] rounded-full", i === 2 ? "bg-gradient-to-b from-ember-hi to-ember" : "bg-foreground/85")} style:height="{h}px"></i>
          {/each}
        </div>
        <span class="heading text-lg">Hush</span>
      </div>
      <ol class="flex flex-col gap-1">
        {#each steps as name, i}
          <li>
            <button
              class={cn(
                "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium transition-colors",
                i === step ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
                i < step && "hover:text-foreground",
              )}
              disabled={i > step}
              onclick={() => (step = i)}
            >
              <span
                class={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold tabular-nums transition-colors",
                  i === step && "border-transparent bg-primary text-primary-foreground",
                  i < step && "border-transparent bg-sage-soft text-sage",
                )}
              >
                {#if i < step}<Check class="size-3" strokeWidth={3} />{:else}{i + 1}{/if}
              </span>
              {name}
            </button>
          </li>
        {/each}
      </ol>
      <div class="mt-auto">
        <Progress value={((step + 1) / steps.length) * 100} class="h-1" />
        <p class="mt-2 text-xs text-muted-foreground">Step {step + 1} of {steps.length}</p>
      </div>
    </aside>

    <section class="flex min-w-0 flex-1 flex-col">
      {#key step}
        <div class="flex flex-1 flex-col gap-5 overflow-y-auto px-10 pt-10 pb-6" in:fly={{ x: 12, duration: 220 }}>
          {#if step === 0}
            <div class="flex h-12 items-center gap-1.5" aria-hidden="true">
              {#each [14, 28, 44, 34, 18] as h, i}
                <i class={cn("mark w-2 rounded-full", i === 2 ? "bg-gradient-to-b from-ember-hi to-ember" : "bg-foreground")} style:height="{h}px" style:animation-delay="{i * 90}ms"></i>
              {/each}
            </div>
            <div class="flex flex-col gap-3">
              <h1 class="heading text-[40px] leading-[1.05]">Speak, and it's <em class="text-ember-text italic">written.</em></h1>
              <p class="max-w-lg text-[15px] leading-relaxed text-muted-foreground">
                Hush is one quiet place for everything you say: dictation into any app, transcripts of your files, and notes from
                your meetings. It runs on your Mac by default, so your audio never has to leave it.
              </p>
            </div>
            <div class="mt-2 grid grid-cols-3 gap-3">
              {#each FEATURES as [Icon, title, text]}
                <div class="flex flex-col gap-2 rounded-xl border bg-background/60 p-4">
                  <div class="grid size-8 place-items-center rounded-lg bg-ember-soft text-ember-text"><Icon class="size-4" /></div>
                  <b class="text-sm font-semibold">{title}</b>
                  <span class="text-[13px] leading-snug text-muted-foreground">{text}</span>
                </div>
              {/each}
            </div>
          {:else if step === 1}
            {@render heading("A few permissions", "macOS asks for these once. You can change them later in System Settings.")}
            <div class="flex flex-col gap-2.5">
              {#snippet micCtl()}
                {#if p?.microphone === "granted"}{@render granted("Granted")}{:else}<Button size="sm" onclick={micAccess}>Allow</Button>{/if}
              {/snippet}
              {#snippet axCtl()}
                {#if p?.accessibility}{@render granted("Granted")}{:else}<Button size="sm" onclick={() => api.openPrivacy("accessibility")}>Open Settings</Button>{/if}
              {/snippet}
              {#snippet sysCtl()}
                {#if p?.system_audio_supported}<Badge variant="secondary">On first meeting</Badge>
                {:else}<Badge class="bg-amber-soft text-amber">Needs macOS 14.2+</Badge>{/if}
              {/snippet}
              {@render row(Mic, "Microphone", "To hear you dictate and to record your side of meetings.", p?.microphone === "granted", micCtl)}
              {@render row(Keyboard, "Accessibility", "For the global dictation hotkey and to paste text into other apps.", !!p?.accessibility, axCtl)}
              {@render row(Speaker, "System audio", "Lets meetings capture the other participants. macOS asks the first time you record a meeting.", false, sysCtl)}
            </div>
          {:else if step === 2}
            {@render heading("Choose a speech model", "These run entirely on your Mac. You can add cloud providers such as OpenAI, Groq, Deepgram or Muse later.")}
            <div class="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Speech model">
              {#each recommended as m}
                {@const sel = m.id === localModel}
                <button
                  role="radio"
                  aria-checked={sel}
                  class={cn(
                    "flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:border-foreground/20",
                    sel && "border-ember/60 ring-3 ring-ember/15 hover:border-ember/60",
                  )}
                  onclick={() => pickModel(m.id)}
                >
                  <div class="flex w-full items-start gap-2">
                    <span class={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", sel && "border-ember bg-ember")}>
                      {#if sel}<span class="size-1.5 rounded-full bg-primary-foreground"></span>{/if}
                    </span>
                    <b class="flex-1 text-sm font-semibold">{m.name}</b>
                    <span class="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{bytes(m.size_bytes)}</span>
                  </div>
                  <span class="pl-6 text-[13px] leading-snug text-muted-foreground">{m.description}</span>
                  {#if m.downloading != null && !m.downloaded}
                    <div class="mt-auto flex w-full items-center gap-2 pt-1 pl-6">
                      <Progress value={m.downloading * 100} class="h-1.5 flex-1" />
                      <span class="font-mono text-xs text-muted-foreground tabular-nums">{Math.round(m.downloading * 100)}%</span>
                    </div>
                  {:else if m.downloaded || m.id === "parakeet-tdt-0.6b-v3"}
                    <div class="mt-auto flex gap-1.5 pt-1 pl-6">
                      {#if m.id === "parakeet-tdt-0.6b-v3"}<Badge class="bg-ember-soft text-ember-text">Recommended</Badge>{/if}
                      {#if m.downloaded}<Badge class="bg-sage-soft text-sage"><Check /> Downloaded</Badge>{/if}
                    </div>
                  {/if}
                </button>
              {/each}
            </div>
            {#if current && !current.downloaded && current.downloading == null}
              <Button class="self-start" onclick={() => download(current.id)}><Download /> Download {current.name}</Button>
            {/if}
          {:else if step === 3}
            {@render heading(
              "AI polish",
              "Hush can use an AI to clean up dictation, write meeting notes and answer questions about transcripts. It works with the coding agents you already have signed in, or any API key.",
              "Optional",
            )}
            <div class="flex flex-col gap-2.5">
              {#if !clis}
                <p class="text-[13px] text-muted-foreground">Looking for installed tools…</p>
              {:else}
                {#snippet found()}{@render granted("Found")}{/snippet}
                {#each clis.filter((c) => c.path) as c}
                  {@render row(Sparkles, LLM_KINDS[c.kind].label, c.version ?? c.path ?? "", true, found, true)}
                {:else}
                  <div class="rounded-xl border border-dashed p-5 text-[13px] text-muted-foreground">
                    No agent CLIs found. You can add an OpenAI-compatible or Anthropic API key in Settings → AI.
                  </div>
                {/each}
              {/if}
            </div>
            {#if s.llm_profiles.length}
              <div class="flex flex-col divide-y rounded-xl border bg-card shadow-xs">
                <label class="flex items-start gap-3 p-4">
                  <Checkbox class="mt-0.5" bind:checked={s.dictation.llm_enabled} onCheckedChange={() => app.save()} />
                  <span class="text-sm leading-snug">
                    Polish dictation with <b class="font-semibold">{app.llmName(s.dictation.llm_profile)}</b>
                    <span class="block text-[13px] text-muted-foreground">Adds a second or two; plain rules are used otherwise.</span>
                  </span>
                </label>
                <label class="flex items-start gap-3 p-4">
                  <Checkbox class="mt-0.5" bind:checked={s.meetings.auto_enhance} onCheckedChange={() => app.save()} />
                  <span class="text-sm leading-snug">
                    Write meeting notes with <b class="font-semibold">{app.llmName(s.meetings.llm_profile)}</b> when a meeting ends
                    <span class="block text-[13px] text-muted-foreground">Sends the transcript and your notes to it.</span>
                  </span>
                </label>
              </div>
            {/if}
          {:else}
            <div class="flex flex-col gap-3">
              <h1 class="heading text-[40px] leading-[1.05]">Try it now.</h1>
              <p class="max-w-lg text-[15px] leading-relaxed text-muted-foreground">
                Click into any text field, {s.dictation.activation === "toggle" ? "press" : "hold"}
                <Keys combo={s.dictation.hotkey} /> and speak. Release to insert.
              </p>
            </div>
            <div class="flex flex-col divide-y rounded-xl border bg-card shadow-xs">
              {#each [[s.dictation.hotkey, "Quick tap locks hands-free mode; tap again to stop."], [s.dictation.command_hotkey, "Command mode: select text and say “make this friendlier”."], [s.dictation.paste_last_hotkey, "Paste your last dictation again."]] as [combo, text]}
                <div class="flex items-center gap-4 px-4 py-3">
                  <div class="w-24 shrink-0"><Keys {combo} /></div>
                  <span class="text-[13px] text-muted-foreground">{text}</span>
                </div>
              {/each}
            </div>
            <Textarea class="min-h-24 bg-background text-[15px] md:text-[15px]" rows={3} placeholder="Try dictating here…" />
          {/if}
        </div>
      {/key}

      <footer class="flex items-center gap-2 border-t px-10 py-4">
        {#if step > 0}<Button variant="ghost" onclick={() => step--}><ArrowLeft /> Back</Button>{/if}
        <span class="flex-1"></span>
        {#if step < steps.length - 1}
          <Button variant="ghost" class="text-muted-foreground" onclick={finish}>Skip setup</Button>
          <Button size="lg" class="px-4" onclick={() => step++}>Continue <ArrowRight /></Button>
        {:else}
          <Button size="lg" class="px-4" onclick={finish}>Start using Hush <ArrowRight /></Button>
        {/if}
      </footer>
    </section>
  </div>
</div>

{#snippet heading(title: string, sub: string, tag?: string)}
  <div class="flex flex-col gap-2">
    <h2 class="heading flex items-center gap-3 text-[28px] leading-tight">
      {title}
      {#if tag}<Badge variant="outline" class="font-sans text-muted-foreground">{tag}</Badge>{/if}
    </h2>
    <p class="max-w-xl text-[14px] leading-relaxed text-muted-foreground">{sub}</p>
  </div>
{/snippet}

<style>
  .mark {
    animation: breathe 2.4s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      transform: scaleY(0.6);
    }
  }
</style>

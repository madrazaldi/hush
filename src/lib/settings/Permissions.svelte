<script lang="ts">
  import { api } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import Section from "#lib/components/Section.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { cn } from "#lib/utils.js";
  import { Check, Keyboard, Lock, Mic, RefreshCw, Speaker } from "@lucide/svelte";

  const p = $derived(app.permissions);

  async function mic() {
    if (p?.microphone === "undetermined") {
      try {
        await api.requestMicrophone();
      } catch {}
    } else api.openPrivacy("microphone");
    app.refreshPermissions();
  }
</script>

{#snippet row(Icon: typeof Mic, label: string, hint: string, ok: boolean, control: import("svelte").Snippet)}
  <div class="flex items-center gap-4 px-4 py-3.5">
    <div class={cn("grid size-9 shrink-0 place-items-center rounded-lg", ok ? "bg-sage-soft text-sage" : "bg-muted text-muted-foreground")}>
      <Icon class="size-[18px]" />
    </div>
    <div class="min-w-0 flex-1">
      <div class="text-sm font-medium">{label}</div>
      <p class="mt-0.5 text-[13px] leading-snug text-pretty text-muted-foreground">{hint}</p>
    </div>
    <div class="shrink-0">{@render control()}</div>
  </div>
{/snippet}

{#snippet allowed()}<Badge class="bg-sage-soft text-sage"><Check /> Allowed</Badge>{/snippet}

{#snippet micCtl()}
  {#if p?.microphone === "granted"}{@render allowed()}
  {:else}<Button size="sm" onclick={mic}>{p?.microphone === "undetermined" ? "Allow" : "Open Settings"}</Button>{/if}
{/snippet}
{#snippet axCtl()}
  {#if p?.accessibility}{@render allowed()}
  {:else}<Button size="sm" onclick={() => api.openPrivacy("accessibility")}>Open Settings</Button>{/if}
{/snippet}
{#snippet sysCtl()}
  <Button variant="outline" size="sm" onclick={() => api.openPrivacy("system_audio")} disabled={!p?.system_audio_supported}>Open Settings</Button>
{/snippet}

<Section title="Access" description="Hush checks these whenever the window regains focus.">
  {#snippet actions()}
    <Button variant="ghost" size="sm" onclick={() => app.refreshPermissions()}><RefreshCw /> Recheck</Button>
  {/snippet}
  {@render row(Mic, "Microphone", "Needed for dictation and meetings.", p?.microphone === "granted", micCtl)}
  {@render row(Keyboard, "Accessibility", "For global hotkeys and pasting text. After enabling, the hotkey starts working within a few seconds.", !!p?.accessibility, axCtl)}
  {@render row(
    Speaker,
    "System audio recording",
    p?.system_audio_supported
      ? "Asked the first time a meeting records. Find it under Privacy & Security → Screen & System Audio Recording → System Audio Recording Only."
      : "Requires macOS 14.2 or later.",
    false,
    sysCtl,
  )}
</Section>

<Section title="Privacy">
  <div class="flex gap-4 p-4">
    <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-ember-soft text-ember-text"><Lock class="size-[18px]" /></div>
    <div class="flex flex-col gap-2 text-[13px] leading-relaxed text-muted-foreground">
      <p>
        With on-device models, your audio and transcripts never leave this Mac. Cloud speech providers receive audio only when you
        choose them. AI providers receive the transcript text and your notes for the task you ask for, and agent CLIs run with tools,
        file access and session history turned off.
      </p>
      <p class="text-xs text-muted-foreground/80">API keys are stored in your app data folder, readable only by your user account.</p>
    </div>
  </div>
</Section>

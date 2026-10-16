<script lang="ts">
  import { api } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import Section from "$lib/components/Section.svelte";
  import Field from "$lib/components/Field.svelte";
  import { Check, RefreshCw } from "@lucide/svelte";

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

<Section title="Permissions" description="Hush checks these whenever the window regains focus.">
  {#snippet actions()}
    <button class="btn sm ghost" onclick={() => app.refreshPermissions()}><RefreshCw size={13} /> Recheck</button>
  {/snippet}
  <Field label="Microphone" hint="Needed for dictation and meetings.">
    {#if p?.microphone === "granted"}<span class="chip sage"><Check size={12} /> Allowed</span>
    {:else}<button class="btn sm primary" onclick={mic}>{p?.microphone === "undetermined" ? "Allow" : "Open Settings"}</button>{/if}
  </Field>
  <Field label="Accessibility" hint="For global hotkeys and pasting text. After enabling, the hotkey starts working within a few seconds.">
    {#if p?.accessibility}<span class="chip sage"><Check size={12} /> Allowed</span>
    {:else}<button class="btn sm primary" onclick={() => api.openPrivacy("accessibility")}>Open Settings</button>{/if}
  </Field>
  <Field
    label="System audio recording"
    hint={p?.system_audio_supported
      ? "Asked the first time a meeting records. Find it under Privacy & Security → Screen & System Audio Recording → System Audio Recording Only."
      : "Requires macOS 14.2 or later."}
  >
    <button class="btn sm" onclick={() => api.openPrivacy("system_audio")} disabled={!p?.system_audio_supported}>Open Settings</button>
  </Field>
</Section>

<Section title="Privacy">
  <div class="note">
    <p>
      With on-device models, your audio and transcripts never leave this Mac. Cloud speech providers receive audio only when you
      choose them. AI providers receive the transcript text and your notes for the task you ask for, and agent CLIs run with tools,
      file access and session history turned off.
    </p>
    <p class="faint small">API keys are stored in your app data folder, readable only by your user account.</p>
  </div>
</Section>

<style>
  .note {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 18px;
    line-height: 1.6;
    color: var(--text-2);
  }
</style>

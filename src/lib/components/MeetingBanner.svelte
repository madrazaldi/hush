<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { Users, X } from "@lucide/svelte";
  import { slide } from "svelte/transition";

  async function record() {
    const name = app.detectedApp;
    app.detectedApp = null;
    try {
      const rec = await api.meetingStart(undefined, name ? `${name} meeting` : undefined);
      await app.refreshMeeting();
      goto(`/meetings/${rec.id}`);
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }
</script>

{#if app.detectedApp && !app.meeting}
  <div class="banner" transition:slide={{ duration: 200 }}>
    <Users size={15} />
    <span><b>{app.detectedApp}</b> is using your microphone. Take notes for this meeting?</span>
    <div class="spacer"></div>
    <button class="btn sm primary" onclick={record}>Start recording</button>
    <button class="btn sm ghost icon" aria-label="Dismiss" onclick={() => (app.detectedApp = null)}><X size={14} /></button>
  </div>
{/if}

<style>
  .banner {
    position: relative;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 40px 48px -24px;
    padding: 8px 8px 8px 14px;
    border-radius: var(--r);
    background: var(--ember-soft);
    color: var(--text);
    flex: none !important;
  }
  .banner :global(svg:first-child) {
    color: var(--ember-text);
  }
</style>

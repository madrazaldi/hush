<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { Button } from "#lib/components/ui/button/index.js";
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
  <div class="relative z-10 shrink-0 px-10 pt-10" transition:slide={{ duration: 200 }}>
    <div class="mx-auto flex max-w-5xl items-center gap-3 rounded-xl border border-ember/25 bg-ember-soft py-2 pr-2 pl-3.5 text-sm">
      <div class="grid size-7 place-items-center rounded-md bg-ember/15 text-ember-text"><Users class="size-4" /></div>
      <span class="flex-1"><b class="font-semibold">{app.detectedApp}</b> is using your microphone. Take notes for this meeting?</span>
      <Button size="sm" onclick={record}>Start recording</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onclick={() => (app.detectedApp = null)}><X /></Button>
    </div>
  </div>
{/if}

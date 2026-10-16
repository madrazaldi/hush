<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { api, errorText, on } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { MEDIA_EXTS } from "$lib/media";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import Onboarding from "$lib/components/Onboarding.svelte";
  import MeetingBanner from "$lib/components/MeetingBanner.svelte";
  import { FileAudio } from "@lucide/svelte";

  let { children } = $props();
  const overlay = $derived(page.url.pathname.startsWith("/overlay"));
  let dropping = $state(false);

  $effect(() => {
    if (overlay) return;
    app.init();
    const offNav = on<string>("navigate", (route) => goto(route));

    // Global drag & drop of media files onto the window.
    let unDrop: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") dropping = true;
        else if (p.type === "leave") dropping = false;
        else if (p.type === "drop") {
          dropping = false;
          const paths = p.paths.filter((x) => MEDIA_EXTS.includes(x.split(".").pop()?.toLowerCase() ?? ""));
          if (!paths.length) {
            if (p.paths.length) app.toast("error", "Those files aren't audio or video Hush can read.");
            return;
          }
          try {
            const recs = await api.addFiles(paths);
            app.recordingsVersion++;
            goto(recs.length === 1 ? `/files/${recs[0].id}` : "/files");
          } catch (err) {
            app.toast("error", errorText(err));
          }
        }
      })
      .then((u) => (unDrop = u));

    return () => {
      offNav();
      unDrop?.();
    };
  });
</script>

{#if overlay}
  {@render children()}
{:else}
  <div class="shell">
    <Sidebar />
    <main>
      <div class="drag" data-tauri-drag-region></div>
      {#if app.settings}
        <MeetingBanner />
        {@render children()}
      {/if}
    </main>
  </div>
  {#if dropping}
    <div class="dropzone">
      <div class="inner">
        <FileAudio size={34} strokeWidth={1.5} />
        <h2>Drop to transcribe</h2>
        <p class="muted">Audio and video files are added to your queue.</p>
      </div>
    </div>
  {/if}
  <Toasts />
  {#if app.settings && !app.settings.general.onboarded}
    <Onboarding />
  {/if}
{/if}

<style>
  .shell {
    display: flex;
    height: 100vh;
  }
  main {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  main > :global(:last-child) {
    flex: 1;
    min-height: 0;
  }
  .drag {
    position: absolute;
    inset: 0 0 auto 0;
    height: 36px;
    z-index: 5;
  }
  .dropzone {
    position: fixed;
    inset: 10px;
    z-index: 90;
    display: grid;
    place-items: center;
    border-radius: 18px;
    border: 2px dashed var(--ember);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(6px);
    pointer-events: none;
  }
  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--ember-text);
  }
  .inner h2 {
    color: var(--text);
  }
</style>

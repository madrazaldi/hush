<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { uploadFile } from "#lib/ipc.js";
  import { api, errorText, on } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { MEDIA_EXTS } from "#lib/media.js";
  import Sidebar from "#lib/components/Sidebar.svelte";
  import Toasts from "#lib/components/Toasts.svelte";
  import Onboarding from "#lib/components/Onboarding.svelte";
  import MeetingBanner from "#lib/components/MeetingBanner.svelte";
  import { FileAudio } from "@lucide/svelte";

  let { children } = $props();
  const overlay = $derived(page.url.pathname.startsWith("/overlay"));
  let dropping = $state(false);

  $effect(() => {
    if (overlay) return;
    app.init();
    const offNav = on<string>("navigate", (route) => goto(route));

    // Global drag & drop of media files onto the window. The embedded browser doesn't expose the paths of
    // dropped files, so each one is copied into Hush's media folder first and added from there.
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      dropping = true;
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) dropping = false;
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dropping = false;
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      const files = dropped.filter((f) => MEDIA_EXTS.includes(f.name.split(".").pop()?.toLowerCase() ?? ""));
      if (!files.length) {
        if (dropped.length) app.toast("error", "Those files aren't audio or video Hush can read.");
        return;
      }
      try {
        const paths: string[] = [];
        for (const f of files) paths.push(await uploadFile(f));
        const recs = await api.addFiles(paths);
        app.recordingsVersion++;
        goto(recs.length === 1 ? `/files/${recs[0].id}` : "/files");
      } catch (err) {
        app.toast("error", errorText(err));
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      offNav();
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  });
</script>

{#if overlay}
  {@render children()}
{:else}
  <div class="shell">
    <Sidebar />
    <main>
      <div class="drag" data-drag-region></div>
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

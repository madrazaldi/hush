<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { openUrl, uploadFile } from "#lib/ipc.js";
  import { api, errorText, on } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { MEDIA_EXTS } from "#lib/media.js";
  import Sidebar from "#lib/components/Sidebar.svelte";
  import { Toaster } from "#lib/components/ui/sonner/index.js";
  import * as SidebarUI from "#lib/components/ui/sidebar/index.js";
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
    // Links to other sites (AI notes, sources) open in the default browser, never in this window: a page
    // loaded here would get the same bridge to the backend as Hush itself.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      // Compared by protocol and host: views:// URLs have an opaque ("null") origin.
      const u = new URL(a.href, location.href);
      if (u.protocol === location.protocol && u.host === location.host) return;
      e.preventDefault();
      if (/^(https?:|mailto:)/i.test(a.href)) openUrl(a.href).catch((err) => app.toast("error", errorText(err)));
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      offNav();
      window.removeEventListener("click", onClick, true);
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
  <SidebarUI.Provider class="h-svh min-h-0 overflow-hidden">
    <Sidebar />
    <SidebarUI.Inset class="relative m-2 ml-0 flex min-h-0 flex-col overflow-hidden rounded-xl border shadow-sm [&>:last-child]:min-h-0 [&>:last-child]:flex-1">
      <div class="absolute inset-x-0 top-0 z-[5] h-9" data-drag-region></div>
      {#if app.settings}
        <MeetingBanner />
        {@render children()}
      {/if}
    </SidebarUI.Inset>
  </SidebarUI.Provider>
  {#if dropping}
    <div class="pointer-events-none fixed inset-2.5 z-[90] grid place-items-center rounded-2xl border-2 border-dashed border-ember bg-background/80 backdrop-blur-sm animate-in fade-in-0">
      <div class="flex flex-col items-center gap-2 text-ember-text">
        <div class="mb-2 grid size-16 place-items-center rounded-2xl bg-ember-soft"><FileAudio class="size-8" strokeWidth={1.5} /></div>
        <h2 class="heading text-2xl text-foreground">Drop to transcribe</h2>
        <p class="text-sm text-muted-foreground">Audio and video files are added to your queue.</p>
      </div>
    </div>
  {/if}
  <Toaster position="bottom-right" richColors={false} closeButton />
  {#if app.settings && !app.settings.general.onboarded}
    <Onboarding />
  {/if}
{/if}

<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { app } from "#lib/state.svelte.js";
  import { api, errorText } from "#lib/api.js";
  import { clock } from "#lib/format.js";
  import * as Sidebar from "#lib/components/ui/sidebar/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import Keys from "./Keys.svelte";
  import { AudioLines, FileAudio, House, Mic, Settings, Square, Users } from "@lucide/svelte";

  const items = [
    { href: "/", label: "Home", icon: House },
    { href: "/dictation", label: "Dictation", icon: Mic },
    { href: "/files", label: "Files", icon: FileAudio },
    { href: "/meetings", label: "Meetings", icon: Users },
  ];

  function active(href: string) {
    const p = page.url.pathname;
    return href === "/" ? p === "/" : p.startsWith(href);
  }

  async function stopMeeting() {
    try {
      const id = await api.meetingStop();
      goto(`/meetings/${id}`);
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }
</script>

{#snippet navLink(it: { href: string; label: string; icon: typeof House })}
  <Sidebar.MenuItem>
    <Sidebar.MenuButton isActive={active(it.href)} class="h-8 gap-2.5 px-2.5 text-[13px] text-sidebar-foreground/75 data-active:text-sidebar-accent-foreground [&_svg]:text-sidebar-foreground/55 data-active:[&_svg]:text-ember-text">
      {#snippet child({ props })}
        <a href={it.href} {...props}>
          <it.icon strokeWidth={1.8} />
          <span>{it.label}</span>
        </a>
      {/snippet}
    </Sidebar.MenuButton>
  </Sidebar.MenuItem>
{/snippet}

<Sidebar.Root collapsible="none" class="bg-transparent">
  <Sidebar.Header class="gap-0 px-3 pt-0 pb-2">
    <div class="h-11 shrink-0" data-drag-region></div>
    <div class="flex items-center gap-2.5 px-1.5 pb-3" data-drag-region>
      <div class="grid size-7 place-items-center rounded-lg bg-foreground text-background shadow-sm">
        <svg viewBox="0 0 32 32" class="size-[18px]" aria-hidden="true">
          <rect x="4" y="13" width="3" height="6" rx="1.5" fill="currentColor" opacity=".9" />
          <rect x="9.5" y="9" width="3" height="14" rx="1.5" fill="currentColor" opacity=".9" />
          <rect x="15" y="5" width="3" height="22" rx="1.5" fill="url(#eg)" />
          <rect x="20.5" y="8" width="3" height="16" rx="1.5" fill="currentColor" opacity=".9" />
          <rect x="26" y="12" width="3" height="8" rx="1.5" fill="currentColor" opacity=".9" />
          <defs>
            <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF8A5B" /><stop offset="1" stop-color="#E5533D" /></linearGradient>
          </defs>
        </svg>
      </div>
      <span class="heading text-lg">Hush</span>
    </div>

    {#if app.meeting}
      <div class="flex items-center gap-1 rounded-lg border border-ember/20 bg-ember-soft p-1 pl-0">
        <button
          class="flex flex-1 items-center gap-2 px-2.5 py-1 text-[13px] font-semibold text-ember-text"
          onclick={() => goto(`/meetings/${app.meeting!.id}`)}
        >
          <span class="size-1.5 rounded-full bg-ember {app.meeting.paused ? '' : 'animate-pulse-ring'}"></span>
          <span class="flex-1 text-left">{app.meeting.paused ? "Paused" : "Recording"}</span>
          <span class="font-mono text-xs tabular-nums">{clock(app.meeting.elapsed_ms)}</span>
        </button>
        <Button variant="ghost" size="icon-xs" class="text-ember-text hover:bg-ember/15 hover:text-ember-text" title="Stop recording" onclick={stopMeeting}>
          <Square class="size-2.5" fill="currentColor" />
        </Button>
      </div>
    {/if}
  </Sidebar.Header>

  <Sidebar.Content>
    <Sidebar.Group class="pt-0">
      <Sidebar.Menu class="gap-0.5">
        {#each items as it}{@render navLink(it)}{/each}
      </Sidebar.Menu>
    </Sidebar.Group>
  </Sidebar.Content>

  <Sidebar.Footer class="gap-1 px-3 pb-3">
    {#if app.settings}
      <button
        class="mb-1.5 flex items-center gap-2.5 rounded-lg border border-dashed border-sidebar-foreground/15 px-2.5 py-2 text-left text-xs text-sidebar-foreground/55 transition-colors hover:border-sidebar-foreground/30 hover:text-sidebar-foreground/80"
        onclick={() => api.dictationToggle()}
        title="Start dictation"
      >
        <AudioLines class="size-3.5 shrink-0" />
        <span class="leading-6">
          {app.settings.dictation.activation === "toggle" ? "Press" : "Hold"}
          <Keys combo={app.settings.dictation.hotkey} class="[&_kbd]:h-[18px] [&_kbd]:text-[10.5px]" /> to dictate
        </span>
      </button>
    {/if}
    <Sidebar.Menu>
      {@render navLink({ href: "/settings", label: "Settings", icon: Settings })}
    </Sidebar.Menu>
  </Sidebar.Footer>
</Sidebar.Root>

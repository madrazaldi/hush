<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { app } from "#lib/state.svelte.js";
  import { api, errorText } from "#lib/api.js";
  import { clock } from "#lib/format.js";
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

<aside>
  <div class="top" data-tauri-drag-region></div>

  <div class="brand" data-tauri-drag-region>
    <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
      <rect x="4" y="13" width="3" height="6" rx="1.5" fill="currentColor" opacity=".9" />
      <rect x="9.5" y="9" width="3" height="14" rx="1.5" fill="currentColor" opacity=".9" />
      <rect x="15" y="5" width="3" height="22" rx="1.5" fill="url(#eg)" />
      <rect x="20.5" y="8" width="3" height="16" rx="1.5" fill="currentColor" opacity=".9" />
      <rect x="26" y="12" width="3" height="8" rx="1.5" fill="currentColor" opacity=".9" />
      <defs>
        <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF8A5B" /><stop offset="1" stop-color="#E5533D" /></linearGradient>
      </defs>
    </svg>
    <span>Hush</span>
  </div>

  {#if app.meeting}
    <div class="live-pill">
      <button class="live-main" onclick={() => goto(`/meetings/${app.meeting!.id}`)}>
        <span class="dot live"></span>
        <span class="t">{app.meeting.paused ? "Paused" : "Recording"}</span>
        <span class="mono">{clock(app.meeting.elapsed_ms)}</span>
      </button>
      <button class="btn icon sm ghost" title="Stop recording" onclick={stopMeeting}><Square size={12} fill="currentColor" /></button>
    </div>
  {/if}

  <nav>
    {#each items as it}
      <a href={it.href} class:on={active(it.href)}>
        <it.icon size={16} strokeWidth={1.8} />
        <span>{it.label}</span>
      </a>
    {/each}
  </nav>

  <div class="spacer"></div>

  {#if app.settings}
    <button class="hint" onclick={() => api.dictationToggle()} title="Start dictation">
      <AudioLines size={14} />
      <span>
        {app.settings.dictation.activation === "toggle" ? "Press" : "Hold"}
        <Keys combo={app.settings.dictation.hotkey} /> to dictate
      </span>
    </button>
  {/if}

  <nav class="bottom">
    <a href="/settings" class:on={active("/settings")}>
      <Settings size={16} strokeWidth={1.8} />
      <span>Settings</span>
    </a>
  </nav>
</aside>

<style>
  aside {
    width: var(--sidebar);
    flex: none;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 0 12px 14px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--line);
  }
  .top {
    height: 44px;
    flex: none;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 8px 18px;
    font-family: var(--serif);
    font-size: 19px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .brand svg {
    color: var(--text);
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    color: var(--text-2);
    font-weight: 500;
    transition:
      background 0.12s,
      color 0.12s;
  }
  nav a:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  nav a.on {
    background: var(--surface-2);
    color: var(--text);
    box-shadow: inset 2px 0 0 var(--ember);
  }
  nav a.on :global(svg) {
    color: var(--ember-text);
  }
  .live-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 0 14px;
    padding: 3px 3px 3px 0;
    border-radius: var(--r);
    background: var(--ember-soft);
  }
  .live-main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border: 0;
    background: none;
    color: var(--ember-text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .live-main .t {
    flex: 1;
    text-align: left;
  }
  .live-pill .btn {
    color: var(--ember-text);
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    padding: 9px 10px;
    border-radius: var(--r-sm);
    border: 1px dashed var(--line-2);
    background: none;
    color: var(--text-3);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .hint:hover {
    color: var(--text-2);
    border-color: var(--text-3);
  }
  .hint :global(kbd) {
    height: 18px;
    font-size: 10.5px;
  }
</style>

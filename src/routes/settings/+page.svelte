<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import General from "$lib/settings/General.svelte";
  import Speech from "$lib/settings/Speech.svelte";
  import Ai from "$lib/settings/Ai.svelte";
  import DictationTab from "$lib/settings/Dictation.svelte";
  import Meetings from "$lib/settings/Meetings.svelte";
  import Permissions from "$lib/settings/Permissions.svelte";
  import { AudioLines, Cog, Keyboard, ShieldCheck, Sparkles, Users } from "@lucide/svelte";

  const TABS = [
    { id: "general", label: "General", icon: Cog },
    { id: "speech", label: "Speech", icon: AudioLines },
    { id: "ai", label: "AI", icon: Sparkles },
    { id: "dictation", label: "Dictation", icon: Keyboard },
    { id: "meetings", label: "Meetings", icon: Users },
    { id: "permissions", label: "Permissions", icon: ShieldCheck },
  ] as const;

  const tab = $derived(page.url.searchParams.get("tab") ?? "general");
</script>

<div class="settings">
  <nav>
    <h1>Settings</h1>
    {#each TABS as t}
      <button class:on={tab === t.id} onclick={() => goto(`/settings?tab=${t.id}`, { replaceState: true, noScroll: true })}>
        <t.icon size={15} strokeWidth={1.8} />
        {t.label}
      </button>
    {/each}
  </nav>
  <div class="content">
    <div class="inner">
      {#if tab === "speech"}<Speech />
      {:else if tab === "ai"}<Ai />
      {:else if tab === "dictation"}<DictationTab />
      {:else if tab === "meetings"}<Meetings />
      {:else if tab === "permissions"}<Permissions />
      {:else}<General />{/if}
    </div>
  </div>
</div>

<style>
  .settings {
    height: 100%;
    display: flex;
    min-height: 0;
  }
  nav {
    width: 200px;
    flex: none;
    padding: 44px 12px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  nav h1 {
    font-size: 24px;
    margin: 0 0 18px 8px;
  }
  nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--text-2);
    font: inherit;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  nav button:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  nav button.on {
    background: var(--surface-2);
    color: var(--text);
  }
  nav button.on :global(svg) {
    color: var(--ember-text);
  }
  .content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 48px 40px 60px 20px;
  }
  .inner {
    max-width: 720px;
  }
</style>

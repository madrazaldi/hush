<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import General from "#lib/settings/General.svelte";
  import Speech from "#lib/settings/Speech.svelte";
  import Ai from "#lib/settings/Ai.svelte";
  import DictationTab from "#lib/settings/Dictation.svelte";
  import Meetings from "#lib/settings/Meetings.svelte";
  import Permissions from "#lib/settings/Permissions.svelte";
  import Page from "#lib/components/Page.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { cn } from "#lib/utils.js";
  import { AudioLines, Cog, Keyboard, ShieldCheck, Sparkles, Users } from "@lucide/svelte";

  const TABS = [
    { id: "general", label: "General", icon: Cog, description: "Startup, appearance, history and media tools." },
    { id: "speech", label: "Speech", icon: AudioLines, description: "On-device models and cloud transcription providers." },
    { id: "ai", label: "AI", icon: Sparkles, description: "Agent CLIs and API providers for polish, notes and chat." },
    { id: "dictation", label: "Dictation", icon: Keyboard, description: "Hotkeys, recognition, output and feedback." },
    { id: "meetings", label: "Meetings", icon: Users, description: "Recording, notes, templates and recipes." },
    { id: "permissions", label: "Permissions", icon: ShieldCheck, description: "What Hush is allowed to do on this Mac." },
  ] as const;

  const tab = $derived(page.url.searchParams.get("tab") ?? "general");
  const current = $derived(TABS.find((t) => t.id === tab) ?? TABS[0]);
</script>

<Page>
  <div class="grid grid-cols-[176px_minmax(0,1fr)] gap-12">
    <nav class="sticky top-0 flex flex-col gap-0.5 self-start pt-1">
      <h1 class="heading mb-5 px-2.5 text-[26px] leading-none">Settings</h1>
      {#each TABS as t}
        <button
          class={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            current.id === t.id && "bg-accent text-foreground [&_svg]:text-ember-text",
          )}
          onclick={() => goto(`/settings?tab=${t.id}`, { replace: true, reset: false })}
        >
          <t.icon class="size-4" strokeWidth={1.8} />
          {t.label}
        </button>
      {/each}
    </nav>

    <div class="max-w-2xl min-w-0">
      <PageHeader title={current.label} description={current.description} class="mb-7" />
      {#if current.id === "speech"}<Speech />
      {:else if current.id === "ai"}<Ai />
      {:else if current.id === "dictation"}<DictationTab />
      {:else if current.id === "meetings"}<Meetings />
      {:else if current.id === "permissions"}<Permissions />
      {:else}<General />{/if}
    </div>
  </div>
</Page>

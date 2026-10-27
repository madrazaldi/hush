<script lang="ts">
  import { app } from "#lib/state.svelte.js";
  import { api } from "#lib/api.js";
  import Section from "#lib/components/Section.svelte";
  import Field from "#lib/components/Field.svelte";
  import { Switch } from "#lib/components/ui/switch/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import Choice from "./Choice.svelte";
  import { cn } from "#lib/utils.js";
  import { FolderOpen, Check, X, Monitor, Sun, Moon } from "@lucide/svelte";

  const s = $derived(app.settings!);
  const save = () => app.save();
  const THEMES = [
    ["system", "System", Monitor],
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
  ] as const;
  const tools = $derived([
    ["ffmpeg", "Decodes video and uncommon audio formats.", !!app.info?.ffmpeg],
    ["yt-dlp", "Transcribe YouTube, podcasts and other web media.", !!app.info?.ytdlp],
  ] as const);
</script>

<Section title="App">
  <Field label="Launch at login" hint="Keep dictation one keypress away.">
    <Switch bind:checked={s.general.launch_at_login} onCheckedChange={save} aria-label="Launch at login" />
  </Field>
  <Field label="Show in Dock" hint="Hush always lives in the menu bar.">
    <Switch bind:checked={s.general.show_in_dock} onCheckedChange={save} aria-label="Show in Dock" />
  </Field>
  <Field label="Appearance">
    <div class="inline-flex gap-0.5 rounded-lg bg-muted p-[3px]" role="radiogroup" aria-label="Appearance">
      {#each THEMES as [v, l, Icon]}
        <button
          role="radio"
          aria-checked={s.general.theme === v}
          class={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-all hover:text-foreground",
            s.general.theme === v && "bg-background text-foreground shadow-sm dark:bg-input/40",
          )}
          onclick={() => {
            s.general.theme = v;
            app.save(true);
          }}
        >
          <Icon class="size-3.5" />{l}
        </button>
      {/each}
    </div>
  </Field>
  <Field label="Your name" hint="Used to label you in meeting notes.">
    <Input class="w-60 bg-background" bind:value={s.meetings.your_name} oninput={save} placeholder="e.g. Alex" />
  </Field>
</Section>

<Section title="History">
  <Field label="Keep dictation history" hint="Older dictations and their audio are deleted automatically.">
    <Choice
      bind:value={s.general.history_days}
      onchange={save}
      options={[
        [0, "Forever"],
        [7, "1 week"],
        [30, "30 days"],
        [90, "90 days"],
        [365, "1 year"],
      ]}
    />
  </Field>
  <Field label="Data folder" hint={app.info?.data_dir}>
    <Button variant="outline" size="sm" onclick={() => app.info && api.reveal(app.info.data_dir + "/hush.db")}><FolderOpen /> Show in Finder</Button>
  </Field>
</Section>

<Section title="Media tools" description="Optional helpers for more file formats and web links.">
  {#each tools as [name, hint, ok]}
    <div class="flex items-center gap-6 px-4 py-3.5">
      <div class="min-w-0 flex-1">
        <div class="font-mono text-[13px] font-medium">{name}</div>
        <p class="mt-0.5 text-[13px] leading-snug text-muted-foreground">
          {hint}
          {#if !ok}Install with <code class="selectable rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">brew install {name}</code>{/if}
        </p>
      </div>
      {#if ok}
        <Badge class="bg-sage-soft text-sage"><Check /> Installed</Badge>
      {:else}
        <Badge variant="outline" class="text-muted-foreground"><X /> Not found</Badge>
      {/if}
    </div>
  {/each}
</Section>

<p class="px-0.5 text-xs text-muted-foreground">Hush {app.info?.version} · Made to stay out of your way.</p>

<script lang="ts">
  import { api } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { LANGUAGES } from "#lib/format.js";
  import { newId } from "#lib/providers.js";
  import type { InputDevice, NoteTemplate, Recipe } from "#lib/types.js";
  import Section from "#lib/components/Section.svelte";
  import Field from "#lib/components/Field.svelte";
  import { Switch } from "#lib/components/ui/switch/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import Choice from "./Choice.svelte";
  import { cn } from "#lib/utils.js";
  import { slide } from "svelte/transition";
  import { Plus, Trash2, ChevronRight, FileText, Wand } from "@lucide/svelte";

  const s = $derived(app.settings!);
  const m = $derived(s.meetings);
  const save = () => app.save();
  let devices = $state<InputDevice[]>([]);
  let openTpl = $state<string | null>(null);
  let openRecipe = $state<string | null>(null);

  $effect(() => {
    api.inputDevices().then((x) => (devices = x));
  });

  function addTemplate() {
    const t: NoteTemplate = {
      id: newId("tpl"),
      name: "New template",
      description: "",
      prompt: "## Summary\n\n## Key points\n\n## Action items",
      builtin: false,
    };
    m.templates.push(t);
    openTpl = t.id;
    save();
  }
  function addRecipe() {
    const r: Recipe = { id: newId("recipe"), name: "New recipe", prompt: "", builtin: false };
    m.recipes.push(r);
    openRecipe = r.id;
    save();
  }
</script>

<Section title="Recording">
  <Field label="Capture system audio" hint="Records the other participants from your speakers or headphones. Without it, only your mic is recorded.">
    <Switch bind:checked={m.capture_system_audio} onCheckedChange={save} disabled={!app.permissions?.system_audio_supported} />
  </Field>
  <Field label="Microphone">
    <Choice
      bind:value={m.mic_device}
      onchange={save}
      options={[[null, "System default"], ...devices.map((dev) => [dev.name, dev.name + (dev.is_default ? " (default)" : "")] as const)]}
    />
  </Field>
  <Field label="Speech model">
    <Choice bind:value={m.stt_profile} onchange={save} options={s.stt_profiles.map((p) => [p.id, app.sttName(p.id)] as const)} />
  </Field>
  <Field label="Language">
    <Choice bind:value={m.language} onchange={save} options={[[null, "Auto-detect"], ...LANGUAGES]} />
  </Field>
  <Field label="Keep audio" hint="Saves the meeting audio so you can replay any moment from the transcript.">
    <Switch bind:checked={m.keep_audio} onCheckedChange={save} />
  </Field>
  <Field label="Detect meetings" hint="Suggests recording when Zoom, Meet, Teams, Slack huddles, FaceTime and others use your mic.">
    <Switch bind:checked={m.detect_meetings} onCheckedChange={save} />
  </Field>
</Section>

<Section title="Notes">
  <Field label="Write notes when the meeting ends" hint={s.llm_profiles.length ? `Uses ${app.llmName(m.llm_profile)}.` : "Connect an AI first."}>
    <Switch bind:checked={m.auto_enhance} onCheckedChange={save} disabled={!s.llm_profiles.length} />
  </Field>
  <Field label="Default template">
    <Choice bind:value={m.default_template} onchange={save} options={m.templates.map((t) => [t.id, t.name] as const)} />
  </Field>
</Section>

{#snippet head(Icon: typeof FileText, name: string, sub: string, isDefault: boolean, isOpen: boolean, toggle: () => void)}
  <button class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50" onclick={toggle}>
    <ChevronRight class={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", isOpen && "rotate-90")} />
    <Icon class="size-4 shrink-0 text-muted-foreground" />
    <span class="shrink-0 text-sm font-medium">{name}</span>
    <span class="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{sub}</span>
    {#if isDefault}<Badge class="bg-ember-soft text-ember-text">Default</Badge>{/if}
  </button>
{/snippet}

<Section title="Templates" description="How enhanced notes are structured. Write headings and instructions; the AI fills them from the transcript.">
  {#snippet actions()}<Button variant="outline" size="sm" onclick={addTemplate}><Plus /> New</Button>{/snippet}
  {#each m.templates as t (t.id)}
    <div class={cn(openTpl === t.id && "bg-muted/30")}>
      {@render head(FileText, t.name, t.description, m.default_template === t.id, openTpl === t.id, () => (openTpl = openTpl === t.id ? null : t.id))}
      {#if openTpl === t.id}
        <div class="flex flex-col gap-3 px-4 pb-4 pl-11" transition:slide={{ duration: 180 }}>
          <div class="grid grid-cols-[1fr_2fr] gap-2">
            <Input class="bg-background" bind:value={t.name} oninput={save} placeholder="Name" />
            <Input class="bg-background" bind:value={t.description} oninput={save} placeholder="When to use it" />
          </div>
          <Textarea class="min-h-40 bg-background font-mono text-[12.5px] md:text-[12.5px] leading-relaxed" rows={8} bind:value={t.prompt} oninput={save} />
          <div class="flex items-center gap-2">
            {#if m.default_template !== t.id}<Button variant="outline" size="sm" onclick={() => { m.default_template = t.id; save(); }}>Make default</Button>{/if}
            <span class="flex-1"></span>
            {#if !t.builtin}
              <Button variant="ghost" size="sm" class="text-destructive hover:bg-destructive/10 hover:text-destructive" onclick={() => { m.templates = m.templates.filter((x) => x.id !== t.id); save(); }}><Trash2 /> Delete</Button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/each}
</Section>

<Section title="Recipes" description="One-click prompts in the meeting chat, like “Write follow-up email”.">
  {#snippet actions()}<Button variant="outline" size="sm" onclick={addRecipe}><Plus /> New</Button>{/snippet}
  {#each m.recipes as r (r.id)}
    <div class={cn(openRecipe === r.id && "bg-muted/30")}>
      {@render head(Wand, r.name, "", false, openRecipe === r.id, () => (openRecipe = openRecipe === r.id ? null : r.id))}
      {#if openRecipe === r.id}
        <div class="flex flex-col gap-3 px-4 pb-4 pl-11" transition:slide={{ duration: 180 }}>
          <Input class="bg-background" bind:value={r.name} oninput={save} placeholder="Name" />
          <Textarea class="bg-background" rows={4} bind:value={r.prompt} oninput={save} placeholder="What should the AI do with the meeting?" />
          {#if !r.builtin}
            <div class="flex justify-end">
              <Button variant="ghost" size="sm" class="text-destructive hover:bg-destructive/10 hover:text-destructive" onclick={() => { m.recipes = m.recipes.filter((x) => x.id !== r.id); save(); }}><Trash2 /> Delete</Button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</Section>

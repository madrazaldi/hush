<script lang="ts">
  import { api } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { LANGUAGES } from "$lib/format";
  import { newId } from "$lib/providers";
  import type { InputDevice, NoteTemplate, Recipe } from "$lib/types";
  import Section from "$lib/components/Section.svelte";
  import Field from "$lib/components/Field.svelte";
  import Toggle from "$lib/components/Toggle.svelte";
  import { Plus, Trash2, ChevronDown } from "@lucide/svelte";

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
    <Toggle bind:checked={m.capture_system_audio} onchange={save} disabled={!app.permissions?.system_audio_supported} />
  </Field>
  <Field label="Microphone">
    <select class="select" bind:value={m.mic_device} onchange={save}>
      <option value={null}>System default</option>
      {#each devices as dev}<option value={dev.name}>{dev.name}{dev.is_default ? " (default)" : ""}</option>{/each}
    </select>
  </Field>
  <Field label="Speech model">
    <select class="select" bind:value={m.stt_profile} onchange={save}>
      {#each s.stt_profiles as p}<option value={p.id}>{app.sttName(p.id)}</option>{/each}
    </select>
  </Field>
  <Field label="Language">
    <select class="select" bind:value={m.language} onchange={save}>
      <option value={null}>Auto-detect</option>
      {#each LANGUAGES as [c, n]}<option value={c}>{n}</option>{/each}
    </select>
  </Field>
  <Field label="Keep audio" hint="Saves the meeting audio so you can replay any moment from the transcript.">
    <Toggle bind:checked={m.keep_audio} onchange={save} />
  </Field>
  <Field label="Detect meetings" hint="Suggests recording when Zoom, Meet, Teams, Slack huddles, FaceTime and others use your mic.">
    <Toggle bind:checked={m.detect_meetings} onchange={save} />
  </Field>
</Section>

<Section title="Notes">
  <Field label="Write notes when the meeting ends" hint={s.llm_profiles.length ? `Uses ${app.llmName(m.llm_profile)}.` : "Connect an AI first."}>
    <Toggle bind:checked={m.auto_enhance} onchange={save} disabled={!s.llm_profiles.length} />
  </Field>
  <Field label="Default template">
    <select class="select" bind:value={m.default_template} onchange={save}>
      {#each m.templates as t}<option value={t.id}>{t.name}</option>{/each}
    </select>
  </Field>
</Section>

<Section title="Templates" description="How enhanced notes are structured. Write headings and instructions; the AI fills them from the transcript.">
  {#snippet actions()}<button class="btn sm" onclick={addTemplate}><Plus size={13} /> New</button>{/snippet}
  {#each m.templates as t (t.id)}
    <div class="item" class:open={openTpl === t.id}>
      <button class="head" onclick={() => (openTpl = openTpl === t.id ? null : t.id)}>
        <b>{t.name}</b>
        <span class="faint small">{t.description}</span>
        <span class="spacer"></span>
        {#if m.default_template === t.id}<span class="chip ember">Default</span>{/if}
        <ChevronDown size={14} class="chev" />
      </button>
      {#if openTpl === t.id}
        <div class="body">
          <div class="row">
            <input class="input" bind:value={t.name} oninput={save} placeholder="Name" />
            <input class="input" bind:value={t.description} oninput={save} placeholder="When to use it" />
          </div>
          <textarea class="textarea mono" rows="8" bind:value={t.prompt} oninput={save}></textarea>
          <div class="row">
            {#if m.default_template !== t.id}<button class="btn sm" onclick={() => { m.default_template = t.id; save(); }}>Make default</button>{/if}
            <span class="spacer"></span>
            {#if !t.builtin}
              <button class="btn sm ghost danger" onclick={() => { m.templates = m.templates.filter((x) => x.id !== t.id); save(); }}><Trash2 size={13} /> Delete</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/each}
</Section>

<Section title="Recipes" description="One-click prompts in the meeting chat, like “Write follow-up email”.">
  {#snippet actions()}<button class="btn sm" onclick={addRecipe}><Plus size={13} /> New</button>{/snippet}
  {#each m.recipes as r (r.id)}
    <div class="item" class:open={openRecipe === r.id}>
      <button class="head" onclick={() => (openRecipe = openRecipe === r.id ? null : r.id)}>
        <b>{r.name}</b>
        <span class="spacer"></span>
        <ChevronDown size={14} class="chev" />
      </button>
      {#if openRecipe === r.id}
        <div class="body">
          <input class="input" bind:value={r.name} oninput={save} placeholder="Name" />
          <textarea class="textarea" rows="4" bind:value={r.prompt} oninput={save} placeholder="What should the AI do with the meeting?"></textarea>
          {#if !r.builtin}
            <div class="row">
              <span class="spacer"></span>
              <button class="btn sm ghost danger" onclick={() => { m.recipes = m.recipes.filter((x) => x.id !== r.id); save(); }}><Trash2 size={13} /> Delete</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</Section>

<style>
  .item + .item {
    border-top: 1px solid var(--line);
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 18px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .head b {
    font-weight: 550;
  }
  .head :global(.chev) {
    color: var(--text-3);
    transition: transform 0.2s;
  }
  .open .head :global(.chev) {
    transform: rotate(180deg);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 18px 16px;
  }
  .textarea.mono {
    font-size: 12.5px;
  }
</style>

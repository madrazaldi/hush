<script lang="ts">
  import { api } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { LANGUAGES } from "$lib/format";
  import type { InputDevice } from "$lib/types";
  import Section from "$lib/components/Section.svelte";
  import Field from "$lib/components/Field.svelte";
  import Toggle from "$lib/components/Toggle.svelte";
  import HotkeyInput from "$lib/components/HotkeyInput.svelte";

  const s = $derived(app.settings!);
  const d = $derived(s.dictation);
  const save = () => app.save();
  let devices = $state<InputDevice[]>([]);
  $effect(() => {
    api.inputDevices().then((x) => (devices = x));
  });
</script>

<Section title="Shortcuts">
  <Field label="Enable dictation" hint="Turn off to free the hotkeys.">
    <Toggle bind:checked={d.enabled} onchange={save} />
  </Field>
  <Field label="Dictate" hint="Fn works best on Apple keyboards. If it opens the emoji picker, set System Settings → Keyboard → “Press 🌐 key to” Do Nothing.">
    <HotkeyInput bind:value={d.hotkey} onchange={save} />
  </Field>
  <Field label="Mode">
    <select class="select" bind:value={d.activation} onchange={save}>
      <option value="hybrid">Hold to talk, tap to lock</option>
      <option value="push_to_talk">Hold to talk</option>
      <option value="toggle">Press to start / stop</option>
    </select>
  </Field>
  {#if d.activation === "hybrid"}
    <Field label="Tap threshold" hint="Presses shorter than this lock recording on.">
      <div class="row">
        <input type="range" min="150" max="600" step="25" bind:value={d.hold_ms} onchange={save} />
        <span class="mono faint" style="width:52px">{d.hold_ms} ms</span>
      </div>
    </Field>
  {/if}
  <Field label="Command mode" hint="Select text, hold this and say how to change it. With nothing selected, it writes what you ask for.">
    <HotkeyInput bind:value={d.command_hotkey} allowEmpty presets={["Fn+Shift", "OptRight+Shift", "Ctrl+Opt+Space"]} onchange={save} />
  </Field>
  <Field label="Paste last dictation">
    <HotkeyInput bind:value={d.paste_last_hotkey} allowEmpty presets={["Cmd+Ctrl+V", "Cmd+Shift+Opt+V"]} onchange={save} />
  </Field>
</Section>

<Section title="Recognition">
  <Field label="Speech model">
    <select class="select" bind:value={d.stt_profile} onchange={save}>
      {#each s.stt_profiles as p}<option value={p.id}>{app.sttName(p.id)}</option>{/each}
    </select>
  </Field>
  <Field label="Language">
    <select class="select" bind:value={d.language} onchange={save}>
      <option value={null}>Auto-detect</option>
      {#each LANGUAGES as [c, n]}<option value={c}>{n}</option>{/each}
    </select>
  </Field>
  <Field label="Microphone">
    <select class="select" bind:value={d.mic_device} onchange={save}>
      <option value={null}>System default</option>
      {#each devices as dev}<option value={dev.name}>{dev.name}{dev.is_default ? " (default)" : ""}</option>{/each}
    </select>
  </Field>
  <Field label="Remove filler words" hint="Drops um, uh, you know… even without AI.">
    <Toggle bind:checked={d.remove_fillers} onchange={save} />
  </Field>
  <Field label="Use app context" hint="Picks a style based on the app you're typing in and tells the AI where the text goes.">
    <Toggle bind:checked={d.app_context} onchange={save} />
  </Field>
</Section>

<Section title="Output">
  <Field label="Insert text by">
    <select class="select" bind:value={d.paste_method} onchange={save}>
      <option value="paste">Pasting (fast, recommended)</option>
      <option value="type">Typing it out</option>
      <option value="copy_only">Copying to clipboard only</option>
    </select>
  </Field>
  {#if d.paste_method === "paste"}
    <Field label="Restore clipboard" hint="Puts back whatever you had copied before.">
      <Toggle bind:checked={d.restore_clipboard} onchange={save} />
    </Field>
  {/if}
  <Field label="Add a trailing space">
    <Toggle bind:checked={d.trailing_space} onchange={save} />
  </Field>
  <Field label="Press Enter after inserting" hint="Handy for chat apps and AI prompts.">
    <select class="select" bind:value={d.auto_submit} onchange={save}>
      <option value="off">Never</option>
      <option value="enter">Enter</option>
      <option value="cmd_enter">⌘ Enter</option>
    </select>
  </Field>
</Section>

<Section title="Feedback">
  <Field label="Indicator">
    <select class="select" bind:value={d.overlay} onchange={save}>
      <option value="bottom">Bottom of screen</option>
      <option value="top">Top of screen</option>
      <option value="hidden">Hidden</option>
    </select>
  </Field>
  <Field label="Sounds">
    <Toggle bind:checked={d.sounds} onchange={save} />
  </Field>
  <Field label="Mute other audio while dictating">
    <Toggle bind:checked={d.mute_system_audio} onchange={save} />
  </Field>
  <Field label="Keep recordings" hint="Saves the audio of each dictation alongside its history.">
    <Toggle bind:checked={d.keep_audio} onchange={save} />
  </Field>
</Section>
<p class="faint small">Styles, vocabulary and replacements live on the <a href="/dictation?tab=styles">Dictation</a> page.</p>

<style>
  input[type="range"] {
    width: 160px;
    accent-color: var(--ember);
  }
</style>

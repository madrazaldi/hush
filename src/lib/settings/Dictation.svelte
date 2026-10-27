<script lang="ts">
  import { api } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { LANGUAGES } from "#lib/format.js";
  import type { InputDevice } from "#lib/types.js";
  import Section from "#lib/components/Section.svelte";
  import Field from "#lib/components/Field.svelte";
  import HotkeyInput from "#lib/components/HotkeyInput.svelte";
  import { Switch } from "#lib/components/ui/switch/index.js";
  import { Slider } from "#lib/components/ui/slider/index.js";
  import Choice from "./Choice.svelte";

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
    <Switch bind:checked={d.enabled} onCheckedChange={save} />
  </Field>
  <Field label="Dictate" hint="Fn works best on Apple keyboards. If it opens the emoji picker, set System Settings → Keyboard → “Press 🌐 key to” Do Nothing.">
    <HotkeyInput bind:value={d.hotkey} onchange={save} />
  </Field>
  <Field label="Mode">
    <Choice bind:value={d.activation} onchange={save} options={[["hybrid", "Hold to talk, tap to lock"], ["push_to_talk", "Hold to talk"], ["toggle", "Press to start / stop"]]} />
  </Field>
  {#if d.activation === "hybrid"}
    <Field label="Tap threshold" hint="Presses shorter than this lock recording on.">
      <div class="flex w-60 items-center gap-3">
        <Slider type="single" min={150} max={600} step={25} bind:value={d.hold_ms} onValueCommit={save} class="flex-1" />
        <span class="w-14 text-right font-mono text-xs text-muted-foreground tabular-nums">{d.hold_ms} ms</span>
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
    <Choice bind:value={d.stt_profile} onchange={save} options={s.stt_profiles.map((p) => [p.id, app.sttName(p.id)] as const)} />
  </Field>
  <Field label="Language">
    <Choice bind:value={d.language} onchange={save} options={[[null, "Auto-detect"], ...LANGUAGES]} />
  </Field>
  <Field label="Microphone">
    <Choice
      bind:value={d.mic_device}
      onchange={save}
      options={[[null, "System default"], ...devices.map((dev) => [dev.name, dev.name + (dev.is_default ? " (default)" : "")] as const)]}
    />
  </Field>
  <Field label="Remove filler words" hint="Drops um, uh, you know… even without AI.">
    <Switch bind:checked={d.remove_fillers} onCheckedChange={save} />
  </Field>
  <Field label="Use app context" hint="Picks a style based on the app you're typing in and tells the AI where the text goes.">
    <Switch bind:checked={d.app_context} onCheckedChange={save} />
  </Field>
</Section>

<Section title="Output">
  <Field label="Insert text by">
    <Choice bind:value={d.paste_method} onchange={save} options={[["paste", "Pasting (fast, recommended)"], ["type", "Typing it out"], ["copy_only", "Copying to clipboard only"]]} />
  </Field>
  {#if d.paste_method === "paste"}
    <Field label="Restore clipboard" hint="Puts back whatever you had copied before.">
      <Switch bind:checked={d.restore_clipboard} onCheckedChange={save} />
    </Field>
  {/if}
  <Field label="Add a trailing space">
    <Switch bind:checked={d.trailing_space} onCheckedChange={save} />
  </Field>
  <Field label="Press Enter after inserting" hint="Handy for chat apps and AI prompts.">
    <Choice bind:value={d.auto_submit} onchange={save} options={[["off", "Never"], ["enter", "Enter"], ["cmd_enter", "⌘ Enter"]]} />
  </Field>
</Section>

<Section title="Feedback">
  <Field label="Indicator">
    <Choice bind:value={d.overlay} onchange={save} options={[["bottom", "Bottom of screen"], ["top", "Top of screen"], ["hidden", "Hidden"]]} />
  </Field>
  <Field label="Sounds">
    <Switch bind:checked={d.sounds} onCheckedChange={save} />
  </Field>
  <Field label="Mute other audio while dictating">
    <Switch bind:checked={d.mute_system_audio} onCheckedChange={save} />
  </Field>
  <Field label="Keep recordings" hint="Saves the audio of each dictation alongside its history.">
    <Switch bind:checked={d.keep_audio} onCheckedChange={save} />
  </Field>
</Section>
<p class="px-0.5 text-xs text-muted-foreground">
  Styles, vocabulary and replacements live on the <a href="/dictation?tab=styles" class="font-medium text-ember-text hover:underline">Dictation</a> page.
</p>

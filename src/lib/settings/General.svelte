<script lang="ts">
  import { app } from "$lib/state.svelte";
  import { api } from "$lib/api";
  import Section from "$lib/components/Section.svelte";
  import Field from "$lib/components/Field.svelte";
  import Toggle from "$lib/components/Toggle.svelte";
  import { FolderOpen, Check, X } from "@lucide/svelte";

  const s = $derived(app.settings!);
  const save = () => app.save();
</script>

<Section title="App">
  <Field label="Launch at login" hint="Keep dictation one keypress away.">
    <Toggle bind:checked={s.general.launch_at_login} onchange={save} />
  </Field>
  <Field label="Show in Dock" hint="Hush always lives in the menu bar.">
    <Toggle bind:checked={s.general.show_in_dock} onchange={save} />
  </Field>
  <Field label="Appearance">
    <div class="tabs">
      {#each [["system", "System"], ["light", "Light"], ["dark", "Dark"]] as [v, l]}
        <button class:on={s.general.theme === v} onclick={() => { s.general.theme = v as any; app.save(true); }}>{l}</button>
      {/each}
    </div>
  </Field>
  <Field label="Your name" hint="Used to label you in meeting notes.">
    <input class="input" bind:value={s.meetings.your_name} oninput={save} placeholder="e.g. Alex" />
  </Field>
</Section>

<Section title="History">
  <Field label="Keep dictation history" hint="Older dictations and their audio are deleted automatically.">
    <select class="select" bind:value={s.general.history_days} onchange={save}>
      <option value={0}>Forever</option>
      <option value={7}>1 week</option>
      <option value={30}>30 days</option>
      <option value={90}>90 days</option>
      <option value={365}>1 year</option>
    </select>
  </Field>
  <Field label="Data folder" hint={app.info?.data_dir}>
    <button class="btn sm" onclick={() => app.info && api.reveal(app.info.data_dir + "/hush.db")}><FolderOpen size={13} /> Show</button>
  </Field>
</Section>

<Section title="Media tools" description="Optional helpers for more file formats and web links.">
  <Field label="ffmpeg" hint="Decodes video and uncommon audio formats. Install with: brew install ffmpeg">
    {#if app.info?.ffmpeg}<span class="chip sage"><Check size={12} /> Installed</span>{:else}<span class="chip"><X size={12} /> Not found</span>{/if}
  </Field>
  <Field label="yt-dlp" hint="Transcribe YouTube, podcasts and other web media. Install with: brew install yt-dlp">
    {#if app.info?.ytdlp}<span class="chip sage"><Check size={12} /> Installed</span>{:else}<span class="chip"><X size={12} /> Not found</span>{/if}
  </Field>
</Section>

<p class="faint small">Hush {app.info?.version} · Made to stay out of your way.</p>

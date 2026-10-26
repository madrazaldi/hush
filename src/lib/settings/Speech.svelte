<script lang="ts">
  import { ask, openUrl } from "#lib/ipc.js";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { bytes } from "#lib/format.js";
  import { STT_KINDS, STT_PRESETS, blankStt } from "#lib/providers.js";
  import type { ModelStatus, SttProfile } from "#lib/types.js";
  import Section from "#lib/components/Section.svelte";
  import Field from "#lib/components/Field.svelte";
  import { Check, Download, Trash2, X, Plus, Cloud, Cpu, Globe, Zap, KeyRound, LoaderCircle, ExternalLink } from "@lucide/svelte";

  const s = $derived(app.settings!);
  let showAll = $state(false);
  let testing = $state<Record<string, boolean>>({});
  let results = $state<Record<string, { ok: boolean; text: string }>>({});
  let adding = $state(false);

  const local = $derived(s.stt_profiles.find((p) => p.id === "local")!);
  const models = $derived([...app.models].sort((a, b) => a.rank - b.rank));
  const shown = $derived(showAll ? models : models.filter((m) => m.recommended || m.downloaded || m.id === local?.model));
  const cloud = $derived(s.stt_profiles.filter((p) => p.kind !== "local"));
  const extraLocal = $derived(s.stt_profiles.filter((p) => p.kind === "local" && p.id !== "local"));

  const uses = $derived.by(() => {
    const out: Record<string, string[]> = {};
    const add = (id: string, what: string) => (out[id] ??= []).push(what);
    add(s.dictation.stt_profile, "Dictation");
    add(s.meetings.stt_profile, "Meetings");
    add(s.files.stt_profile, "Files");
    return out;
  });

  async function download(m: ModelStatus) {
    m.downloading = 0;
    try {
      await api.downloadModel(m.id);
    } catch (e) {
      const msg = errorText(e);
      if (!/cancel/i.test(msg)) app.toast("error", msg);
    }
    app.refreshModels();
  }

  async function del(m: ModelStatus) {
    if (!(await ask(`Delete ${m.name} (${bytes(m.size_bytes)}) from this Mac?`, { title: "Delete model", kind: "warning" }))) return;
    await api.deleteModel(m.id);
    app.refreshModels();
  }

  function use(m: ModelStatus) {
    local.model = m.id;
    app.save();
  }

  async function test(p: SttProfile) {
    testing[p.id] = true;
    delete results[p.id];
    try {
      results[p.id] = { ok: true, text: await api.testStt($state.snapshot(p) as SttProfile) };
    } catch (e) {
      results[p.id] = { ok: false, text: errorText(e) };
    } finally {
      testing[p.id] = false;
    }
  }

  function addPreset(pr: (typeof STT_PRESETS)[number]) {
    const p = blankStt(pr.kind, pr.name);
    p.base_url = pr.base_url;
    p.model = pr.model;
    s.stt_profiles.push(p);
    adding = false;
    app.save();
  }

  function addLocal() {
    const p = blankStt("local", "On-device (2nd model)");
    p.model = models.find((m) => m.downloaded && m.id !== local.model)?.id ?? local.model;
    s.stt_profiles.push(p);
    adding = false;
    app.save();
  }

  function remove(p: SttProfile) {
    s.stt_profiles = s.stt_profiles.filter((x) => x.id !== p.id);
    app.save();
  }

  // Catalog scores are 0–100; accuracy clusters high, so stretch its range.
  function meter(n: number, kind: "speed" | "accuracy") {
    const dots = kind === "speed" ? Math.round(n / 20) : Math.round((n - 66) / 5);
    return Array.from({ length: 5 }, (_, i) => i < Math.max(1, Math.min(5, dots)));
  }
</script>

<Section title="Use for" description="Pick a speech engine per feature. Dictation favors speed; files and meetings favor accuracy.">
  <Field label="Dictation">
    <select class="select" bind:value={s.dictation.stt_profile} onchange={() => app.save()}>
      {#each s.stt_profiles as p}<option value={p.id}>{app.sttName(p.id)}</option>{/each}
    </select>
  </Field>
  <Field label="Meetings">
    <select class="select" bind:value={s.meetings.stt_profile} onchange={() => app.save()}>
      {#each s.stt_profiles as p}<option value={p.id}>{app.sttName(p.id)}</option>{/each}
    </select>
  </Field>
  <Field label="Files">
    <select class="select" bind:value={s.files.stt_profile} onchange={() => app.save()}>
      {#each s.stt_profiles as p}<option value={p.id}>{app.sttName(p.id)}</option>{/each}
    </select>
  </Field>
</Section>

<div class="sechead">
  <div>
    <h3>On-device models</h3>
    <p class="muted small">Run privately on your Mac's GPU. Selected: <b>{app.sttName("local")}</b></p>
  </div>
  <button class="btn sm ghost" onclick={() => (showAll = !showAll)}>{showAll ? "Show recommended" : `Show all ${models.length}`}</button>
</div>

<div class="models">
  {#each shown as m (m.id)}
    <div class="model card" class:sel={local?.model === m.id}>
      <div class="row top">
        <b>{m.name}</b>
        {#if m.id === "parakeet-tdt-0.6b-v3"}<span class="chip ember">Best overall</span>{/if}
        {#if m.streaming}<span class="chip">Streaming</span>{/if}
        <span class="spacer"></span>
        <span class="faint small">{bytes(m.size_bytes)}</span>
      </div>
      <p class="muted small desc">{m.description}</p>
      <div class="row specs small">
        <span title="Languages"><Globe size={12} /> {m.languages.length > 1 ? `${m.languages.length} languages` : "English"}</span>
        <span class="meter" title="Speed"><Zap size={12} />{#each meter(m.speed, "speed") as on}<i class:on></i>{/each}</span>
        <span class="meter" title="Accuracy"><Check size={12} />{#each meter(m.accuracy, "accuracy") as on}<i class:on></i>{/each}</span>
        {#if m.translate}<span class="faint">Translate</span>{/if}
      </div>
      <div class="row acts">
        {#if m.downloading != null}
          <div class="progress spacer"><div style:width="{m.downloading * 100}%"></div></div>
          <span class="faint small mono">{Math.round(m.downloading * 100)}%</span>
          <button class="btn icon sm ghost" title="Cancel" onclick={() => api.cancelModelDownload(m.id)}><X size={13} /></button>
        {:else if m.downloaded}
          {#if local?.model === m.id}
            <span class="chip sage"><Check size={12} /> In use</span>
          {:else}
            <button class="btn sm" onclick={() => use(m)}>Use</button>
          {/if}
          <span class="spacer"></span>
          <button class="btn icon sm ghost" title="Delete" onclick={() => del(m)}><Trash2 size={13} /></button>
        {:else}
          <button class="btn sm" onclick={() => download(m)}><Download size={13} /> Download</button>
          <span class="spacer"></span>
          <span class="faint small">{m.license}</span>
        {/if}
      </div>
    </div>
  {/each}
</div>

<div class="sechead">
  <div>
    <h3>Providers</h3>
    <p class="muted small">Cloud transcription with your own API keys. Audio is sent to the provider you choose.</p>
  </div>
  <div class="addwrap">
    <button class="btn sm" onclick={() => (adding = !adding)}><Plus size={13} /> Add</button>
    {#if adding}
      <div class="menu card">
        {#each STT_PRESETS as pr}
          <button onclick={() => addPreset(pr)}><Cloud size={13} /> {pr.name}</button>
        {/each}
        <div class="sep"></div>
        <button onclick={addLocal}><Cpu size={13} /> Another on-device model</button>
      </div>
    {/if}
  </div>
</div>

{#each [...extraLocal, ...cloud] as p (p.id)}
  <div class="prov card">
    <div class="row">
      <input class="input name" bind:value={p.name} oninput={() => app.save()} />
      <span class="chip">{STT_KINDS[p.kind].label}</span>
      {#each uses[p.id] ?? [] as u}<span class="chip ember">{u}</span>{/each}
      <span class="spacer"></span>
      <button class="btn icon sm ghost" title="Remove" onclick={() => remove(p)}><Trash2 size={13} /></button>
    </div>
    {#if p.kind === "local"}
      <label>
        <span>Model</span>
        <select class="select" bind:value={p.model} onchange={() => app.save()}>
          {#each models.filter((m) => m.downloaded) as m}<option value={m.id}>{m.name}</option>{/each}
        </select>
      </label>
    {:else}
      <div class="grid">
        <label>
          <span>API key</span>
          <div class="row">
            <input class="input mono" type="password" placeholder="Paste key" bind:value={p.api_key} oninput={() => app.save()} />
            {#if STT_KINDS[p.kind].keyUrl}
              <button class="btn icon sm ghost" title="Get a key" onclick={() => openUrl(STT_KINDS[p.kind].keyUrl!)}><KeyRound size={13} /></button>
            {/if}
          </div>
        </label>
        <label><span>Model</span><input class="input mono" bind:value={p.model} oninput={() => app.save()} placeholder={STT_KINDS[p.kind].model} /></label>
        <label class="wide">
          <span>Base URL</span>
          <input class="input mono" bind:value={p.base_url} oninput={() => app.save()} placeholder={STT_KINDS[p.kind].baseUrl} />
        </label>
      </div>
    {/if}
    <div class="row">
      <button class="btn sm" onclick={() => test(p)} disabled={testing[p.id]}>
        {#if testing[p.id]}<LoaderCircle size={13} class="spin" />{/if} Test
      </button>
      {#if results[p.id]}
        <span class="small selectable" class:ok={results[p.id].ok} class:bad={!results[p.id].ok}>{results[p.id].text}</span>
      {/if}
    </div>
  </div>
{:else}
  <div class="none faint small">
    No cloud providers. Add OpenAI, Groq, xAI, Muse, Deepgram, ElevenLabs or AssemblyAI for speaker labels and long files.
    <button class="link" onclick={() => openUrl("https://platform.openai.com/docs/guides/speech-to-text")}>Learn more <ExternalLink size={11} /></button>
  </div>
{/each}

<style>
  .sechead {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    margin: 6px 4px 10px;
  }
  .sechead h3 {
    font-family: var(--sans);
    font-size: 13.5px;
    font-weight: 650;
  }
  .models {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 30px;
  }
  .model {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border-radius: var(--r);
  }
  .model.sel {
    border-color: color-mix(in srgb, var(--ember) 55%, transparent);
  }
  .top {
    gap: 6px;
  }
  .desc {
    flex: 1;
    line-height: 1.45;
  }
  .specs {
    gap: 12px;
    color: var(--text-3);
  }
  .specs span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .meter i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--surface-3);
  }
  .meter i.on {
    background: var(--ember);
  }
  .acts {
    min-height: 26px;
  }
  .addwrap {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 32px;
    z-index: 30;
    width: 230px;
    padding: 5px;
    border-radius: var(--r);
    box-shadow: var(--shadow-pop);
    display: flex;
    flex-direction: column;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .menu button:hover {
    background: var(--surface-2);
  }
  .sep {
    height: 1px;
    margin: 4px;
    background: var(--line);
  }
  .prov {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    margin-bottom: 10px;
    border-radius: var(--r);
  }
  .prov .name {
    width: 220px;
    font-weight: 600;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .grid .wide {
    grid-column: span 2;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  label > span {
    font-size: 11.5px;
    color: var(--text-3);
    font-weight: 600;
  }
  .ok {
    color: var(--sage);
  }
  .bad {
    color: var(--ember-text);
  }
  .none {
    padding: 14px 4px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    border: 0;
    background: none;
    color: var(--ember-text);
    font: inherit;
    cursor: pointer;
  }
</style>

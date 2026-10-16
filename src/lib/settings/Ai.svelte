<script lang="ts">
  import { api, errorText } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { LLM_KINDS, LLM_PRESETS, blankLlm } from "$lib/providers";
  import type { CliStatus, LlmKind, LlmProfile } from "$lib/types";
  import Section from "$lib/components/Section.svelte";
  import Field from "$lib/components/Field.svelte";
  import { Check, Plus, Trash2, Terminal, Cloud, LoaderCircle, RefreshCw, ChevronDown } from "@lucide/svelte";

  const s = $derived(app.settings!);
  let clis = $state<CliStatus[]>([]);
  let detecting = $state(false);
  let adding = $state(false);
  let open = $state<string | null>(null);
  let testing = $state<Record<string, boolean>>({});
  let results = $state<Record<string, { ok: boolean; text: string }>>({});
  let modelLists = $state<Record<string, string[]>>({});

  async function detect() {
    detecting = true;
    clis = await api.detectClis();
    detecting = false;
  }
  $effect(() => {
    detect();
  });

  function cliFor(kind: LlmKind) {
    return clis.find((c) => c.kind === kind);
  }

  function add(p: LlmProfile) {
    s.llm_profiles.push(p);
    open = p.id;
    adding = false;
    app.save();
  }
  function addCli(kind: LlmKind) {
    add(blankLlm(kind));
  }
  function addPreset(pr: (typeof LLM_PRESETS)[number]) {
    const p = blankLlm(pr.kind, pr.name);
    p.base_url = pr.base_url;
    p.model = pr.model;
    add(p);
  }
  function remove(p: LlmProfile) {
    s.llm_profiles = s.llm_profiles.filter((x) => x.id !== p.id);
    app.save();
  }

  async function test(p: LlmProfile) {
    testing[p.id] = true;
    delete results[p.id];
    try {
      results[p.id] = { ok: true, text: await api.testLlm($state.snapshot(p) as LlmProfile) };
    } catch (e) {
      results[p.id] = { ok: false, text: errorText(e) };
    } finally {
      testing[p.id] = false;
    }
  }

  async function fetchModels(p: LlmProfile) {
    try {
      modelLists[p.id] = await api.llmModels($state.snapshot(p) as LlmProfile);
      if (!modelLists[p.id].length) app.toast("info", "No models reported by this provider.");
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }
</script>

{#if s.llm_profiles.length}
  <Section title="Use for" description="Which AI handles each job. CLIs use your existing subscriptions; API keys bill per use.">
    <Field label="Dictation polish & commands">
      <select class="select" bind:value={s.dictation.llm_profile} onchange={() => app.save()}>
        {#each s.llm_profiles as p}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </Field>
    <Field label="Meeting notes & chat">
      <select class="select" bind:value={s.meetings.llm_profile} onchange={() => app.save()}>
        {#each s.llm_profiles as p}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </Field>
    <Field label="File summaries & chat">
      <select class="select" bind:value={s.files.llm_profile} onchange={() => app.save()}>
        {#each s.llm_profiles as p}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </Field>
  </Section>
{/if}

<div class="sechead">
  <div>
    <h3>Providers</h3>
    <p class="muted small">Hush sends transcripts and notes only to the provider you pick, with tools and file access disabled.</p>
  </div>
  <div class="addwrap">
    <button class="btn sm" onclick={() => (adding = !adding)}><Plus size={13} /> Add</button>
    {#if adding}
      <div class="menu card">
        <span class="eyebrow">Agent CLIs</span>
        {#each ["claude_code", "codex", "opencode", "gemini", "antigravity"] as LlmKind[] as k}
          <button onclick={() => addCli(k)}>
            <Terminal size={13} /> {LLM_KINDS[k].label}
            {#if cliFor(k)?.path}<span class="chip sage">Installed</span>{/if}
          </button>
        {/each}
        <div class="sep"></div>
        <span class="eyebrow">API (bring your own key)</span>
        {#each LLM_PRESETS as pr}
          <button onclick={() => addPreset(pr)}><Cloud size={13} /> {pr.name}</button>
        {/each}
        <button onclick={() => add(blankLlm("openai_chat", "Custom endpoint"))}><Cloud size={13} /> Custom Chat Completions</button>
        <button onclick={() => add(blankLlm("openai_responses", "Custom Responses"))}><Cloud size={13} /> Custom Responses</button>
      </div>
    {/if}
  </div>
</div>

{#each s.llm_profiles as p (p.id)}
  {@const info = LLM_KINDS[p.kind]}
  {@const cli = info.cli ? cliFor(p.kind) : undefined}
  <div class="prov card" class:open={open === p.id}>
    <button class="head" onclick={() => (open = open === p.id ? null : p.id)}>
      {#if info.cli}<Terminal size={15} />{:else}<Cloud size={15} />{/if}
      <b>{p.name}</b>
      {#if info.label !== p.name}<span class="chip">{info.label}</span>{/if}
      {#if p.model}<span class="faint small mono">{p.model}</span>{/if}
      <span class="spacer"></span>
      {#if info.cli}
        {#if cli?.path}<span class="chip sage"><Check size={11} /> {cli.version?.match(/\d+(\.\d+)+/)?.[0] ?? "Installed"}</span>
        {:else if !detecting}<span class="chip amber">Not installed</span>{/if}
      {/if}
      <ChevronDown size={14} class="chev" />
    </button>
    {#if open === p.id}
      <div class="body">
        <p class="muted small">{info.blurb}</p>
        <div class="grid">
          <label><span>Name</span><input class="input" bind:value={p.name} oninput={() => app.save()} /></label>
          <label>
            <span>Model</span>
            <div class="row">
              <input class="input mono" list={`models-${p.id}`} bind:value={p.model} oninput={() => app.save()} placeholder={info.modelHint} />
              {#if !info.cli || p.kind === "opencode"}
                <button class="btn icon sm ghost" title="Fetch available models" onclick={() => fetchModels(p)}><RefreshCw size={13} /></button>
              {/if}
            </div>
            <datalist id={`models-${p.id}`}>{#each modelLists[p.id] ?? [] as m}<option value={m}></option>{/each}</datalist>
          </label>
          {#if info.cli}
            <label class="wide">
              <span>Binary path <i class="faint">(optional)</i></span>
              <input class="input mono" bind:value={p.bin_path} oninput={() => app.save()} placeholder={cli?.path ?? "Found on your PATH"} />
            </label>
          {:else}
            <label class="wide">
              <span>Base URL</span>
              <input class="input mono" bind:value={p.base_url} oninput={() => app.save()} placeholder={info.baseUrl} />
            </label>
            <label class="wide">
              <span>API key</span>
              <input class="input mono" type="password" bind:value={p.api_key} oninput={() => app.save()} placeholder="Not needed for local servers" />
            </label>
          {/if}
          {#if info.efforts}
            <label>
              <span>Reasoning effort</span>
              <select class="select" bind:value={p.effort} onchange={() => app.save()}>
                <option value="">Default</option>
                {#each info.efforts as e}<option value={e}>{e}</option>{/each}
              </select>
            </label>
          {/if}
        </div>
        <div class="row">
          <button class="btn sm" onclick={() => test(p)} disabled={testing[p.id]}>
            {#if testing[p.id]}<LoaderCircle size={13} class="spin" />{/if} Test connection
          </button>
          {#if results[p.id]}
            <span class="small selectable" class:ok={results[p.id].ok} class:bad={!results[p.id].ok}>{results[p.id].text}</span>
          {/if}
          <span class="spacer"></span>
          <button class="btn sm ghost danger" onclick={() => remove(p)}><Trash2 size={13} /> Remove</button>
        </div>
      </div>
    {/if}
  </div>
{:else}
  <div class="none card">
    <p><b>No AI connected.</b></p>
    <p class="muted small">
      Hush works without AI, but with it you get polished dictation, voice commands, meeting notes, summaries and chat.
      {#if clis.some((c) => c.path)}We found {clis.filter((c) => c.path).map((c) => LLM_KINDS[c.kind].label).join(", ")} on this Mac.{/if}
    </p>
    <div class="row">
      {#each clis.filter((c) => c.path) as c}
        <button class="btn sm primary" onclick={() => addCli(c.kind)}><Plus size={13} /> {LLM_KINDS[c.kind].label}</button>
      {/each}
      <button class="btn sm" onclick={() => (adding = true)}>Add API key…</button>
    </div>
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
  .addwrap {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 32px;
    z-index: 30;
    width: 250px;
    padding: 8px 5px 5px;
    border-radius: var(--r);
    box-shadow: var(--shadow-pop);
    display: flex;
    flex-direction: column;
  }
  .menu .eyebrow {
    padding: 2px 8px 4px;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .menu button .chip {
    margin-left: auto;
    height: 18px;
    font-size: 10.5px;
  }
  .menu button:hover {
    background: var(--surface-2);
  }
  .sep {
    height: 1px;
    margin: 5px 4px 7px;
    background: var(--line);
  }
  .prov {
    margin-bottom: 8px;
    border-radius: var(--r);
    overflow: hidden;
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .head > :global(svg:first-child) {
    color: var(--text-3);
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
    gap: 14px;
    padding: 0 16px 16px;
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
  label i {
    font-style: normal;
    font-weight: 400;
  }
  .ok {
    color: var(--sage);
  }
  .bad {
    color: var(--ember-text);
    overflow-wrap: anywhere;
  }
  .none {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px;
    border-radius: var(--r);
  }
</style>

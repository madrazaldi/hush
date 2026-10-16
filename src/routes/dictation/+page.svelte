<script lang="ts">
  import { page } from "$app/state";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { api, errorText } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { dayGroup, groupBy, words } from "$lib/format";
  import { newId } from "$lib/providers";
  import type { Dictation, Style } from "$lib/types";
  import Keys from "$lib/components/Keys.svelte";
  import Toggle from "$lib/components/Toggle.svelte";
  import { Copy, Search, Trash2, Wand, Plus, X, ArrowRight, Terminal } from "@lucide/svelte";

  type Tab = "history" | "styles" | "vocabulary";
  let tab = $state<Tab>((page.url.searchParams.get("tab") as Tab) ?? "history");

  const s = $derived(app.settings!);

  // ---------- History ----------
  let query = $state("");
  let items = $state<Dictation[]>([]);
  let limit = $state(100);
  let showRaw = $state<Record<string, boolean>>({});

  $effect(() => {
    app.dictationsVersion;
    const q = query;
    const l = limit;
    const t = setTimeout(() => api.dictations(q, l).then((d) => (items = d)), q ? 180 : 0);
    return () => clearTimeout(t);
  });
  const groups = $derived(groupBy(items, (d) => dayGroup(d.created_at)));

  async function copy(text: string) {
    await writeText(text);
    app.toast("success", "Copied");
  }
  async function remove(id: string) {
    await api.deleteDictation(id);
    items = items.filter((d) => d.id !== id);
  }
  async function clearAll() {
    if (await ask("Delete all dictation history? This can't be undone.", { title: "Clear history", kind: "warning" })) {
      await api.clearDictations();
      items = [];
    }
  }

  // ---------- Styles ----------
  let selected = $state<string>("");
  const style = $derived(s.dictation.styles.find((x) => x.id === (selected || s.dictation.default_style)) ?? s.dictation.styles[0]);
  let sample = $state("um so basically i wanted to uh let you know that the the deploy is done and we can ship tomorrow");
  let preview = $state("");
  let previewing = $state(false);

  function addStyle() {
    const st: Style = { id: newId("style"), name: "New style", prompt: "Describe how the text should be written.", apps: [], builtin: false };
    s.dictation.styles.push(st);
    selected = st.id;
    app.save();
  }
  function deleteStyle(st: Style) {
    s.dictation.styles = s.dictation.styles.filter((x) => x.id !== st.id);
    if (s.dictation.default_style === st.id) s.dictation.default_style = "clean";
    selected = "";
    app.save();
  }
  async function runPreview() {
    previewing = true;
    preview = "";
    try {
      preview = await api.applyStyle(sample, style.id);
    } catch (e) {
      preview = `⚠ ${errorText(e)}`;
    } finally {
      previewing = false;
    }
  }

  // ---------- Vocabulary ----------
  let newWord = $state("");
  function addWord(e: Event) {
    e.preventDefault();
    const w = newWord.trim();
    if (!w) return;
    for (const part of w.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!s.vocabulary.includes(part)) s.vocabulary.push(part);
    }
    newWord = "";
    app.save();
  }
</script>

<div class="page">
  <div class="page-narrow">
    <div class="page-head">
      <div>
        <h1>Dictation</h1>
        <p class="sub">
          {s.dictation.activation === "toggle" ? "Press" : "Hold"} <Keys combo={s.dictation.hotkey} /> to talk in any app.
          <Keys combo={s.dictation.command_hotkey} /> edits selected text with your voice.
        </p>
      </div>
      <div class="tabs">
        <button class:on={tab === "history"} onclick={() => (tab = "history")}>History</button>
        <button class:on={tab === "styles"} onclick={() => (tab = "styles")}>Styles</button>
        <button class:on={tab === "vocabulary"} onclick={() => (tab = "vocabulary")}>Vocabulary</button>
      </div>
    </div>

    {#if tab === "history"}
      <div class="row tools">
        <div class="search spacer">
          <Search size={14} />
          <input class="input" placeholder="Search dictations" bind:value={query} />
        </div>
        {#if items.length}<button class="btn ghost danger" onclick={clearAll}><Trash2 size={14} /> Clear</button>{/if}
      </div>

      {#each groups as [day, list]}
        <h4 class="eyebrow day">{day}</h4>
        <div class="list">
          {#each list as d (d.id)}
            <article class="item">
              <div class="time faint mono">{new Date(d.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
              <div class="main">
                {#if d.error}
                  <p class="err">{d.error}</p>
                {/if}
                <p class="text selectable">{showRaw[d.id] ? d.raw_text : d.text || d.raw_text}</p>
                <div class="meta">
                  {#if d.kind === "command"}<span class="chip ember"><Terminal size={11} /> Command</span>{/if}
                  {#if d.app}<span class="chip">{d.app}</span>{/if}
                  {#if d.style && d.kind !== "command"}<span class="chip">{s.dictation.styles.find((x) => x.id === d.style)?.name ?? d.style}</span>{/if}
                  <span class="faint small">{words(d.text)} words · {(d.duration_ms / 1000).toFixed(1)}s</span>
                  {#if d.raw_text && d.raw_text !== d.text}
                    <button class="link small" onclick={() => (showRaw[d.id] = !showRaw[d.id])}>{showRaw[d.id] ? "Show final" : "Show original"}</button>
                  {/if}
                </div>
              </div>
              <div class="acts">
                <button class="btn icon sm ghost" title="Copy" onclick={() => copy(showRaw[d.id] ? d.raw_text : d.text)}><Copy size={14} /></button>
                <button class="btn icon sm ghost" title="Delete" onclick={() => remove(d.id)}><Trash2 size={14} /></button>
              </div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="empty">
          <h3>{query ? "No matches" : "Nothing dictated yet"}</h3>
          <p>{query ? "Try a different search." : "Put your cursor in any text field and hold your hotkey to start."}</p>
        </div>
      {/each}
      {#if items.length >= limit}
        <div class="row" style="justify-content:center;margin-top:16px"><button class="btn" onclick={() => (limit += 100)}>Load more</button></div>
      {/if}
    {:else if tab === "styles"}
      <div class="card ai-row">
        <div>
          <b>Polish with AI</b>
          <p class="muted small">
            {#if s.llm_profiles.length}
              Rewrite each dictation with {app.llmName(s.dictation.llm_profile)} using the style for the app you're in.
              Without it, Hush still removes filler words and applies your replacements.
            {:else}
              Add an AI provider in <a href="/settings?tab=ai">Settings → AI</a> to rewrite dictation in these styles.
            {/if}
          </p>
        </div>
        {#if s.llm_profiles.length}
          <select class="select" style="width:180px" bind:value={s.dictation.llm_profile} onchange={() => app.save()}>
            {#each s.llm_profiles as p}<option value={p.id}>{p.name}</option>{/each}
          </select>
        {/if}
        <Toggle bind:checked={s.dictation.llm_enabled} disabled={!s.llm_profiles.length} onchange={() => app.save()} />
      </div>

      <div class="styles">
        <div class="slist">
          {#each s.dictation.styles as st (st.id)}
            <button class:on={style?.id === st.id} onclick={() => { selected = st.id; preview = ""; }}>
              <span>{st.name}</span>
              {#if s.dictation.default_style === st.id}<span class="chip ember">Default</span>{/if}
            </button>
          {/each}
          <button class="add" onclick={addStyle}><Plus size={14} /> New style</button>
        </div>

        {#if style}
          <div class="card editor">
            <div class="row">
              <input class="input name" bind:value={style.name} oninput={() => app.save()} disabled={style.builtin} />
              {#if s.dictation.default_style !== style.id}
                <button class="btn sm" onclick={() => { s.dictation.default_style = style.id; app.save(); }}>Make default</button>
              {/if}
              {#if !style.builtin}
                <button class="btn sm ghost danger" onclick={() => deleteStyle(style)}><Trash2 size={13} /></button>
              {/if}
            </div>
            <label class="eyebrow" for="sp">Instructions</label>
            <textarea id="sp" class="textarea" rows="5" bind:value={style.prompt} oninput={() => app.save()}></textarea>

            <span class="eyebrow">Use automatically in</span>
            <div class="apps">
              {#each style.apps as a, i}
                <span class="chip">{a}<button aria-label="Remove" onclick={() => { style.apps.splice(i, 1); app.save(); }}><X size={11} /></button></span>
              {/each}
              <input
                class="input appin"
                placeholder="Add app name or bundle id…"
                onkeydown={(e) => {
                  const el = e.currentTarget;
                  if (e.key === "Enter" && el.value.trim()) {
                    style.apps.push(el.value.trim());
                    el.value = "";
                    app.save();
                  }
                }}
              />
            </div>

            <div class="try">
              <span class="eyebrow">Try it</span>
              <textarea class="textarea" rows="2" bind:value={sample}></textarea>
              <div class="row">
                <button class="btn sm" onclick={runPreview} disabled={previewing}>
                  <Wand size={13} class={previewing ? "spin" : ""} /> {previewing ? "Rewriting…" : "Preview"}
                </button>
                {#if !s.dictation.llm_enabled}<span class="faint small">AI polish is off: preview shows rule-based cleanup.</span>{/if}
              </div>
              {#if preview}
                <div class="out selectable"><ArrowRight size={13} /> {preview}</div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="vocab">
        <section>
          <h3>Vocabulary</h3>
          <p class="muted small">Names, jargon and acronyms you say often. Hush biases recognition toward them and the AI fixes near-misses.</p>
          <form class="row" onsubmit={addWord}>
            <input class="input" placeholder="e.g. Kubernetes, Anaïs, OKRs" bind:value={newWord} />
            <button class="btn" disabled={!newWord.trim()}>Add</button>
          </form>
          <div class="words">
            {#each s.vocabulary as w, i}
              <span class="chip">{w}<button aria-label="Remove" onclick={() => { s.vocabulary.splice(i, 1); app.save(); }}><X size={11} /></button></span>
            {:else}
              <span class="faint small">No words yet.</span>
            {/each}
          </div>
        </section>

        <section>
          <h3>Replacements</h3>
          <p class="muted small">Always swap a spoken phrase for exact text — great for emails, links and signatures.</p>
          <div class="repl">
            {#each s.replacements as r, i}
              <div class="row">
                <input class="input" placeholder="When I say…" bind:value={r.from} oninput={() => app.save()} />
                <ArrowRight size={14} class="faint" />
                <input class="input" placeholder="Write…" bind:value={r.to} oninput={() => app.save()} />
                <button class="btn icon sm ghost" aria-label="Remove" onclick={() => { s.replacements.splice(i, 1); app.save(); }}><X size={14} /></button>
              </div>
            {/each}
            <button class="btn sm" onclick={() => s.replacements.push({ from: "", to: "" })}><Plus size={13} /> Add replacement</button>
          </div>
        </section>

        <section>
          <h3>Spoken commands</h3>
          <p class="muted small">Say these while dictating:</p>
          <div class="cmds">
            <div><span class="chip">“new line”</span> line break</div>
            <div><span class="chip">“new paragraph”</span> blank line</div>
            <div><span class="chip">“scratch that”</span> drops the last phrase (with AI polish)</div>
          </div>
        </section>
      </div>
    {/if}
  </div>
</div>

<style>
  .tools {
    margin-bottom: 8px;
  }
  .day {
    margin: 22px 0 6px;
  }
  .list {
    border-top: 1px solid var(--line);
  }
  .item {
    display: flex;
    gap: 16px;
    padding: 13px 4px;
    border-bottom: 1px solid var(--line);
  }
  .item:hover .acts {
    opacity: 1;
  }
  .time {
    width: 62px;
    flex: none;
    padding-top: 2px;
    font-size: 11.5px;
  }
  .main {
    flex: 1;
    min-width: 0;
  }
  .text {
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
  }
  .err {
    color: var(--ember-text);
    font-size: 12.5px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .link {
    border: 0;
    background: none;
    color: var(--text-3);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .acts {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .ai-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 18px;
    border-radius: var(--r);
    margin-bottom: 18px;
  }
  .ai-row > div {
    flex: 1;
  }
  .styles {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 18px;
    align-items: start;
  }
  .slist {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .slist button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
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
  .slist button:hover,
  .slist button.on {
    background: var(--surface-2);
    color: var(--text);
  }
  .slist .add {
    justify-content: flex-start;
    gap: 6px;
    color: var(--text-3);
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px;
    border-radius: var(--r);
  }
  .editor .name {
    font-weight: 600;
    flex: 1;
  }
  .editor .eyebrow {
    margin-top: 6px;
  }
  .apps,
  .words {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip button {
    display: inline-grid;
    place-items: center;
    border: 0;
    padding: 0;
    margin-left: 2px;
    background: none;
    color: var(--text-3);
    cursor: pointer;
  }
  .appin {
    width: 210px !important;
    height: 26px;
    font-size: 12.5px;
  }
  .try {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
  }
  .out {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--r-sm);
    background: var(--surface-2);
    line-height: 1.55;
  }
  .out :global(svg) {
    flex: none;
    margin-top: 4px;
    color: var(--ember-text);
  }
  .vocab {
    display: flex;
    flex-direction: column;
    gap: 30px;
  }
  .vocab section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .vocab h3 {
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 650;
  }
  .repl {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .repl .row {
    width: 100%;
  }
  .cmds {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--text-2);
  }
  .cmds .chip {
    margin-right: 8px;
  }
</style>

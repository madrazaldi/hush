<script lang="ts">
  import { api, errorText } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { bytes } from "$lib/format";
  import type { CliStatus } from "$lib/types";
  import { LLM_KINDS } from "$lib/providers";
  import Keys from "./Keys.svelte";
  import { Check, Download, Mic, Keyboard, Speaker, Sparkles, ArrowRight } from "@lucide/svelte";
  import { fade, fly } from "svelte/transition";

  let step = $state(0);
  let clis = $state<CliStatus[] | null>(null);
  const steps = ["Welcome", "Permissions", "Speech", "AI", "Try it"];

  const s = $derived(app.settings!);
  const p = $derived(app.permissions);
  const localModel = $derived(s.stt_profiles.find((x) => x.id === "local")?.model ?? "parakeet-tdt-0.6b-v3");
  const recommended = $derived(app.models.filter((m) => m.recommended).sort((a, b) => a.rank - b.rank).slice(0, 4));
  const current = $derived(app.models.find((m) => m.id === localModel));

  $effect(() => {
    if (step === 3 && !clis) api.detectClis().then((c) => (clis = c));
  });

  function pickModel(id: string) {
    const prof = s.stt_profiles.find((x) => x.id === "local");
    if (prof) prof.model = id;
    app.save();
  }

  async function download(id: string) {
    pickModel(id);
    try {
      const m = app.models.find((m) => m.id === id);
      if (m) m.downloading = 0;
      await api.downloadModel(id);
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }

  async function micAccess() {
    try {
      await api.requestMicrophone();
    } catch (e) {
      api.openPrivacy("microphone");
    }
    app.refreshPermissions();
  }

  function finish() {
    s.general.onboarded = true;
    app.save(true);
  }
</script>

<div class="veil" transition:fade={{ duration: 200 }}>
  <div class="sheet card" in:fly={{ y: 16, duration: 280 }}>
    <div class="steps">
      {#each steps as name, i}
        <div class="st" class:on={i === step} class:done={i < step}><span>{i < step ? "✓" : i + 1}</span>{name}</div>
      {/each}
    </div>

    {#key step}
      <div class="body" in:fly={{ x: 12, duration: 220 }}>
        {#if step === 0}
          <div class="hero">
            <div class="mark">
              {#each [10, 22, 34, 26, 14] as h, i}
                <i style:height="{h}px" class:ember={i === 2} style:animation-delay="{i * 90}ms"></i>
              {/each}
            </div>
            <h1>Speak, and it's <em class="accent">written.</em></h1>
            <p class="muted lead">
              Hush is one quiet place for everything you say: dictation into any app, transcripts of your files, and notes from
              your meetings. It runs on your Mac by default, so your audio never has to leave it.
            </p>
            <div class="three">
              <div><Keyboard size={18} /><b>Dictation</b><span>Hold a key, talk, release. Polished text appears where you type.</span></div>
              <div><Download size={18} /><b>Files</b><span>Drop audio, video or a link and get a searchable, timestamped transcript.</span></div>
              <div><Speaker size={18} /><b>Meetings</b><span>Jot rough notes; Hush listens to both sides and writes them up.</span></div>
            </div>
          </div>
        {:else if step === 1}
          <h2>A few permissions</h2>
          <p class="muted">macOS asks for these once. You can change them later in System Settings.</p>
          <div class="perms">
            <div class="perm">
              <Mic size={18} />
              <div><b>Microphone</b><span>To hear you dictate and to record your side of meetings.</span></div>
              {#if p?.microphone === "granted"}<span class="chip sage"><Check size={12} /> Granted</span>
              {:else}<button class="btn sm primary" onclick={micAccess}>Allow</button>{/if}
            </div>
            <div class="perm">
              <Keyboard size={18} />
              <div><b>Accessibility</b><span>For the global dictation hotkey and to paste text into other apps.</span></div>
              {#if p?.accessibility}<span class="chip sage"><Check size={12} /> Granted</span>
              {:else}<button class="btn sm primary" onclick={() => api.openPrivacy("accessibility")}>Open Settings</button>{/if}
            </div>
            <div class="perm">
              <Speaker size={18} />
              <div>
                <b>System audio</b>
                <span>Lets meetings capture the other participants. macOS asks the first time you record a meeting.</span>
              </div>
              {#if p?.system_audio_supported}<span class="chip">On first meeting</span>
              {:else}<span class="chip amber">Needs macOS 14.2+</span>{/if}
            </div>
          </div>
        {:else if step === 2}
          <h2>Choose a speech model</h2>
          <p class="muted">These run entirely on your Mac. You can add cloud providers such as OpenAI, Groq, Deepgram or Muse later.</p>
          <div class="models">
            {#each recommended as m}
              <button class="model" class:sel={m.id === localModel} onclick={() => pickModel(m.id)}>
                <div class="row">
                  <b>{m.name}</b>
                  <span class="spacer"></span>
                  <span class="faint small nowrap">{bytes(m.size_bytes)}</span>
                </div>
                <span class="muted small">{m.description}</span>
                {#if m.downloading != null && !m.downloaded}
                  <div class="progress"><div style:width="{m.downloading * 100}%"></div></div>
                {:else if m.downloaded || m.id === "parakeet-tdt-0.6b-v3"}
                  <div class="row tags">
                    {#if m.id === "parakeet-tdt-0.6b-v3"}<span class="chip ember">Recommended</span>{/if}
                    {#if m.downloaded}<span class="chip sage"><Check size={12} /> Downloaded</span>{/if}
                  </div>
                {/if}
              </button>
            {/each}
          </div>
          {#if current && !current.downloaded && current.downloading == null}
            <button class="btn primary dl" onclick={() => download(current.id)}><Download size={15} /> Download {current.name}</button>
          {/if}
        {:else if step === 3}
          <h2>AI polish <span class="faint">(optional)</span></h2>
          <p class="muted">
            Hush can use an AI to clean up dictation, write meeting notes and answer questions about transcripts. It works with the
            coding agents you already have signed in, or any API key.
          </p>
          <div class="perms">
            {#if !clis}
              <p class="faint">Looking for installed tools…</p>
            {:else}
              {#each clis.filter((c) => c.path) as c}
                <div class="perm">
                  <Sparkles size={18} />
                  <div><b>{LLM_KINDS[c.kind].label}</b><span class="mono">{c.version ?? c.path}</span></div>
                  <span class="chip sage"><Check size={12} /> Found</span>
                </div>
              {:else}
                <p class="faint">No agent CLIs found. You can add an OpenAI-compatible or Anthropic API key in Settings → AI.</p>
              {/each}
            {/if}
          </div>
          {#if s.llm_profiles.length}
            <label class="row check">
              <input type="checkbox" bind:checked={s.dictation.llm_enabled} onchange={() => app.save()} />
              Polish dictation with <b>{app.llmName(s.dictation.llm_profile)}</b>
              <span class="faint small">(adds a second or two; plain rules are used otherwise)</span>
            </label>
          {/if}
        {:else}
          <div class="hero">
            <h1>Try it now.</h1>
            <p class="muted lead">
              Click into any text field, {s.dictation.activation === "toggle" ? "press" : "hold"}
              <Keys combo={s.dictation.hotkey} /> and speak. Release to insert.
            </p>
            <div class="tips">
              <div><Keys combo={s.dictation.hotkey} /> <span>Quick tap locks hands-free mode; tap again to stop.</span></div>
              <div><Keys combo={s.dictation.command_hotkey} /> <span>Command mode: select text and say “make this friendlier”.</span></div>
              <div><Keys combo={s.dictation.paste_last_hotkey} /> <span>Paste your last dictation again.</span></div>
            </div>
            <textarea class="textarea" rows="3" placeholder="Try dictating here…"></textarea>
          </div>
        {/if}
      </div>
    {/key}

    <div class="foot">
      {#if step > 0}<button class="btn ghost" onclick={() => step--}>Back</button>{/if}
      <span class="spacer"></span>
      {#if step < steps.length - 1}
        <button class="btn ghost" onclick={finish}>Skip setup</button>
        <button class="btn primary" onclick={() => step++}>Continue <ArrowRight size={14} /></button>
      {:else}
        <button class="btn primary" onclick={finish}>Start using Hush</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .veil {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(14px);
  }
  .sheet {
    width: 680px;
    max-width: calc(100vw - 48px);
    height: 580px;
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    padding: 22px 30px 20px;
    box-shadow: var(--shadow-pop);
  }
  .steps {
    display: flex;
    gap: 18px;
    font-size: 12px;
    color: var(--text-3);
    margin-bottom: 22px;
  }
  .st {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .st span {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid var(--line-2);
    font-size: 10px;
  }
  .st.on {
    color: var(--text);
  }
  .st.on span {
    background: var(--ember);
    border-color: transparent;
    color: #fff;
  }
  .st.done span {
    background: var(--surface-3);
  }
  .body {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .hero {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 8px;
  }
  .hero h1 {
    font-size: 38px;
  }
  .lead {
    font-size: 15px;
    line-height: 1.6;
    max-width: 560px;
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 40px;
  }
  .mark i {
    width: 6px;
    border-radius: 3px;
    background: var(--text);
    animation: breathe 2.4s ease-in-out infinite;
  }
  .mark i.ember {
    background: var(--ember-grad);
  }
  @keyframes breathe {
    50% {
      transform: scaleY(0.6);
    }
  }
  .three {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-top: 10px;
  }
  .three div {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px;
    border-radius: var(--r);
    background: var(--surface-2);
  }
  .three :global(svg) {
    color: var(--ember-text);
  }
  .three span {
    color: var(--text-2);
    font-size: 12.5px;
  }
  .perms {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
  }
  .perm {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-radius: var(--r);
    background: var(--surface-2);
  }
  .perm > div {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .perm > div span {
    color: var(--text-2);
    font-size: 12.5px;
  }
  .perm > :global(svg) {
    color: var(--text-2);
    flex: none;
  }
  .models {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 6px 0 4px;
  }
  .model {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 12px 14px;
    border-radius: var(--r);
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .model .row {
    width: 100%;
    align-items: flex-start;
  }
  .model .row.tags {
    gap: 6px;
    margin-top: auto;
  }
  .dl {
    align-self: flex-start;
  }
  .nowrap {
    white-space: nowrap;
  }
  .model.sel {
    border-color: var(--ember);
    box-shadow: 0 0 0 3px var(--ember-soft);
  }
  .model .progress {
    width: 100%;
  }
  .check {
    margin-top: 8px;
    gap: 8px;
    flex-wrap: wrap;
  }
  .check input {
    accent-color: var(--ember);
  }
  .tips {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tips div {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .tips :global(.keys) {
    min-width: 110px;
  }
  .tips span {
    color: var(--text-2);
  }
  .foot {
    display: flex;
    gap: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
</style>

<script lang="ts">
  import { api, errorText } from "$lib/api";
  import Keys from "./Keys.svelte";

  let {
    value = $bindable(""),
    presets = ["Fn", "OptRight", "CmdRight", "Fn+Shift", "Ctrl+Space", "Opt+Space", "F13"],
    allowEmpty = false,
    onchange,
  }: { value?: string; presets?: string[]; allowEmpty?: boolean; onchange?: (v: string) => void } = $props();

  let recording = $state(false);
  let error = $state("");
  let preview = $state("");
  let open = $state(false);

  // Modifiers held during the current capture, keyed by event.code.
  let held = new Set<string>();
  let peak = new Set<string>();
  let mainKey = "";

  const MOD: Record<string, [string, string]> = {
    MetaLeft: ["Cmd", "CmdLeft"],
    MetaRight: ["Cmd", "CmdRight"],
    AltLeft: ["Opt", "OptLeft"],
    AltRight: ["Opt", "OptRight"],
    ControlLeft: ["Ctrl", "CtrlLeft"],
    ControlRight: ["Ctrl", "CtrlRight"],
    ShiftLeft: ["Shift", "ShiftLeft"],
    ShiftRight: ["Shift", "ShiftRight"],
    Fn: ["Fn", "Fn"],
  };
  const ORDER = ["Fn", "Ctrl", "Opt", "Shift", "Cmd"];
  const NAMED: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "ForwardDelete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "LeftBracket",
    BracketRight: "RightBracket",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Backquote: "Grave",
    IntlBackslash: "Section",
  };

  function keyName(code: string): string | null {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    return NAMED[code] ?? null;
  }

  function combo(): string {
    const mods = [...peak].map((c) => MOD[c]);
    if (!mainKey && mods.length === 1) return mods[0][1]; // a lone modifier keeps its side
    const names = [...new Set(mods.map((m) => m[0]))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return [...names, ...(mainKey ? [mainKey] : [])].join("+");
  }

  function start() {
    recording = true;
    error = "";
    preview = "";
    held = new Set();
    peak = new Set();
    mainKey = "";
  }

  async function commit(v: string) {
    recording = false;
    open = false;
    if (!v) return;
    try {
      await api.validateHotkey(v);
      value = v;
      error = "";
      onchange?.(v);
    } catch (e) {
      error = errorText(e);
    }
  }

  function down(e: KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape" && !held.size) {
      recording = false;
      return;
    }
    if (MOD[e.code]) {
      held.add(e.code);
      peak.add(e.code);
    } else {
      const k = keyName(e.code);
      if (k) mainKey = k;
    }
    preview = combo();
    if (mainKey) commit(preview);
  }

  function up(e: KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    held.delete(e.code);
    if (!held.size && peak.size) commit(combo());
  }
</script>

<svelte:window onkeydowncapture={down} onkeyupcapture={up} />

<div class="hk">
  <button type="button" class="field" class:rec={recording} onclick={() => (recording ? (recording = false) : start())}>
    {#if recording}
      {#if preview}<Keys combo={preview} />{:else}<span class="faint">Press keys… (esc to cancel)</span>{/if}
    {:else if value}
      <Keys combo={value} />
    {:else}
      <span class="faint">Not set</span>
    {/if}
  </button>
  <button type="button" class="btn sm ghost" onclick={() => (open = !open)}>Presets</button>
  {#if open}
    <div class="menu card">
      {#each presets as p}
        <button type="button" onclick={() => commit(p)}><Keys combo={p} /></button>
      {/each}
      {#if allowEmpty}
        <button type="button" onclick={() => { value = ""; open = false; onchange?.(""); }}><span class="muted">Disable</span></button>
      {/if}
    </div>
  {/if}
</div>
{#if error}<div class="err small">{error}</div>{/if}

<style>
  .hk {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .field {
    min-width: 150px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-2);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .field.rec {
    border-color: var(--ember);
    box-shadow: 0 0 0 3px var(--ember-soft);
  }
  .menu {
    position: absolute;
    top: 38px;
    right: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    padding: 5px;
    border-radius: var(--r);
    box-shadow: var(--shadow-pop);
    min-width: 160px;
  }
  .menu button {
    display: flex;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .menu button:hover {
    background: var(--surface-2);
  }
  .err {
    color: var(--ember-text);
    margin-top: 4px;
  }
</style>

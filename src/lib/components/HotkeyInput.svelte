<script lang="ts">
  import { api, errorText } from "#lib/api.js";
  import Keys from "./Keys.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import { cn } from "#lib/utils.js";
  import { ChevronDown, CircleSlash, Keyboard } from "@lucide/svelte";

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

<div class="flex flex-col items-end gap-1">
  <div class="flex items-center gap-1.5">
    <button
      type="button"
      class={cn(
        "flex h-8 min-w-40 items-center justify-center gap-2 rounded-lg border border-input bg-background px-2.5 text-sm transition-all outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50",
        recording && "border-ember ring-3 ring-ember/25 hover:bg-background dark:hover:bg-input/30",
      )}
      onclick={() => (recording ? (recording = false) : start())}
    >
      {#if recording}
        {#if preview}<Keys combo={preview} />{:else}<span class="flex items-center gap-1.5 text-[13px] text-ember-text"><span class="size-1.5 rounded-full bg-ember animate-pulse-ring"></span>Press keys… <span class="text-muted-foreground">esc to cancel</span></span>{/if}
      {:else if value}
        <Keys combo={value} />
      {:else}
        <span class="flex items-center gap-1.5 text-[13px] text-muted-foreground"><Keyboard class="size-3.5" /> Not set</span>
      {/if}
    </button>
    <DropdownMenu.Root bind:open>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="sm" class="text-muted-foreground">Presets <ChevronDown /></Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-auto min-w-44">
        {#each presets as p}
          <DropdownMenu.Item onSelect={() => commit(p)} class="justify-between gap-6">
            <Keys combo={p} />
            {#if p === value}<span class="size-1.5 rounded-full bg-ember"></span>{/if}
          </DropdownMenu.Item>
        {/each}
        {#if allowEmpty}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => { value = ""; open = false; onchange?.(""); }} class="text-muted-foreground">
            <CircleSlash /> Disable
          </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
  {#if error}<p class="max-w-72 text-right text-xs text-destructive">{error}</p>{/if}
</div>

<script lang="ts">
  import { tick } from "svelte";
  import type { Segment } from "$lib/types";
  import { clock } from "$lib/format";

  let {
    segments,
    speakers = {},
    currentMs = -1,
    query = "",
    editable = true,
    live = false,
    showTimes = true,
    onseek,
    onedit,
    onrename,
    onreassign,
  }: {
    segments: Segment[];
    speakers?: Record<string, string>;
    currentMs?: number;
    query?: string;
    editable?: boolean;
    live?: boolean;
    showTimes?: boolean;
    onseek?: (ms: number) => void;
    onedit?: (index: number, text: string) => void;
    onrename?: (key: string, name: string) => void;
    onreassign?: (index: number, key: string) => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let editing = $state<number | null>(null);
  let draft = $state("");
  let menu = $state<{ index: number; key: string } | null>(null);
  let renameDraft = $state("");
  let follow = $state(true);

  const PALETTE = ["#E5533D", "#7FB685", "#6FA3D8", "#C38FD9", "#E8B04B", "#5FC1B5", "#D98BA6", "#9AA6B2"];
  const keys = $derived([...new Set(segments.map((s) => s.speaker).filter(Boolean))] as string[]);
  function color(key: string) {
    if (key === "Me") return PALETTE[0];
    if (key === "Them") return PALETTE[1];
    const i = keys.indexOf(key);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  }
  function label(key: string) {
    return speakers[key] || key;
  }

  const active = $derived.by(() => {
    if (currentMs < 0) return -1;
    let lo = 0,
      hi = segments.length - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].start_ms <= currentMs) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && currentMs <= segments[ans].end_ms + 1500 ? ans : -1;
  });

  // Follow playback.
  $effect(() => {
    const i = active;
    if (i < 0 || !follow || editing !== null || !root) return;
    const el = root.querySelector<HTMLElement>(`[data-i="${i}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  // Live transcripts stick to the bottom.
  $effect(() => {
    segments.length;
    if (!live || !root) return;
    tick().then(() => {
      const scroller = root?.closest(".scroll") as HTMLElement | null;
      if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
  });

  function esc(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  }
  function highlight(text: string) {
    const q = query.trim();
    if (!q) return esc(text);
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let out = "",
      last = 0;
    for (const m of text.matchAll(re)) {
      out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
      last = m.index! + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function startEdit(i: number) {
    if (!editable || !onedit) return;
    editing = i;
    draft = segments[i].text;
    tick().then(() => root?.querySelector<HTMLTextAreaElement>(".edit")?.focus());
  }
  function commit() {
    if (editing === null) return;
    const i = editing;
    editing = null;
    if (draft.trim() !== segments[i].text) onedit?.(i, draft.trim());
  }

  function openMenu(i: number, key: string) {
    if (!editable) return;
    menu = { index: i, key };
    renameDraft = label(key);
  }
  function rename(e: Event) {
    e.preventDefault();
    if (menu && renameDraft.trim()) onrename?.(menu.key, renameDraft.trim());
    menu = null;
  }

  export function scrollToFirstMatch() {
    tick().then(() => root?.querySelector("mark")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }
</script>

<svelte:window onclick={(e) => menu && !(e.target as HTMLElement).closest(".spk-wrap") && (menu = null)} />

<div class="transcript" bind:this={root} onwheel={() => (follow = false)}>
  {#each segments as seg, i (i)}
    {@const sp = seg.speaker}
    {@const first = i === 0 || segments[i - 1].speaker !== sp}
    <div class="seg" class:first class:active={i === active} data-i={i}>
      {#if showTimes}
        <button class="time mono" onclick={() => { follow = true; onseek?.(seg.start_ms); }}>{clock(seg.start_ms)}</button>
      {/if}
      <div class="body">
        {#if sp && first}
          <div class="spk-wrap">
            <button class="spk" style:--c={color(sp)} onclick={() => openMenu(i, sp)}>{label(sp)}</button>
            {#if menu && menu.index === i}
              <div class="menu card">
                <form onsubmit={rename}>
                  <span class="eyebrow">Rename “{menu.key}”</span>
                  <input class="input" bind:value={renameDraft} />
                </form>
                {#if onreassign && keys.length > 1}
                  <span class="eyebrow">This line is actually</span>
                  {#each keys.filter((k) => k !== sp) as k}
                    <button onclick={() => { onreassign?.(i, k); menu = null; }}><i style:background={color(k)}></i>{label(k)}</button>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/if}
        {#if editing === i}
          <textarea
            class="edit textarea"
            bind:value={draft}
            rows={Math.max(2, Math.ceil(draft.length / 90))}
            onblur={commit}
            onkeydown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") editing = null;
            }}
          ></textarea>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <p class="text selectable" onclick={() => window.getSelection()?.isCollapsed && onseek?.(seg.start_ms)} ondblclick={() => startEdit(i)}>
            {@html highlight(seg.text)}
          </p>
        {/if}
      </div>
    </div>
  {/each}
</div>

{#if !follow && active >= 0}
  <button class="follow btn sm" onclick={() => (follow = true)}>Follow playback</button>
{/if}

<style>
  .transcript {
    display: flex;
    flex-direction: column;
  }
  .seg {
    display: flex;
    gap: 14px;
    padding: 3px 0;
  }
  .seg.first {
    margin-top: 14px;
  }
  .seg:first-child {
    margin-top: 0;
  }
  .time {
    flex: none;
    width: 52px;
    height: 22px;
    margin-top: 1px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-3);
    font-size: 11px;
    text-align: right;
    cursor: pointer;
  }
  .time:hover {
    color: var(--ember-text);
    background: var(--surface-2);
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .text {
    padding: 1px 6px;
    margin: 0 -6px;
    border-radius: 6px;
    font-size: 14.5px;
    line-height: 1.65;
    transition: background 0.2s;
    cursor: text;
  }
  .text:hover {
    background: var(--surface-2);
  }
  .active .text {
    background: var(--ember-soft);
  }
  .text :global(mark) {
    background: var(--hl);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
  }
  .edit {
    font-size: 14.5px;
  }
  .spk-wrap {
    position: relative;
  }
  .spk {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--c);
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.02em;
    cursor: pointer;
  }
  .spk::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--c);
  }
  .menu {
    position: absolute;
    z-index: 30;
    top: 22px;
    left: 0;
    width: 240px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border-radius: var(--r);
    box-shadow: var(--shadow-pop);
  }
  .menu form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
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
  .menu i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .follow {
    position: sticky;
    bottom: 8px;
    align-self: center;
    margin: 8px auto 0;
    display: flex;
    box-shadow: var(--shadow-pop);
  }
</style>

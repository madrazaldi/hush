<script lang="ts">
  import { tick } from "svelte";
  import type { Segment } from "#lib/types.js";
  import { clock } from "#lib/format.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { ArrowDownToLine } from "@lucide/svelte";

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
    tick().then(() => root?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
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

<div class="flex flex-col" bind:this={root} onwheel={() => (follow = false)}>
  {#each segments as seg, i (i)}
    {@const sp = seg.speaker}
    {@const first = i === 0 || segments[i - 1].speaker !== sp}
    <div class="group/seg flex gap-3 py-0.5 {first && i > 0 ? 'mt-4' : ''}" data-i={i}>
      {#if showTimes}
        <button
          class="mt-[3px] h-[22px] w-13 shrink-0 rounded-md text-right font-mono text-[11px] text-muted-foreground/70 tabular-nums transition-colors hover:bg-muted hover:text-ember-text {i === active ? 'text-ember-text' : ''}"
          onclick={() => {
            follow = true;
            onseek?.(seg.start_ms);
          }}>{clock(seg.start_ms)}</button
        >
      {/if}
      <div class="min-w-0 flex-1">
        {#if sp && first}
          <Popover.Root bind:open={() => menu?.index === i, (v) => (v ? openMenu(i, sp) : (menu = null))}>
            <Popover.Trigger
              class="mb-0.5 inline-flex items-center gap-1.5 rounded px-0 text-xs font-semibold tracking-wide"
              style="color: {color(sp)}"
            >
              <span class="size-1.5 rounded-full" style:background={color(sp)}></span>{label(sp)}
            </Popover.Trigger>
            {#if menu && menu.index === i}
              <Popover.Content align="start" class="w-64 gap-2">
                <form class="flex flex-col gap-1.5" onsubmit={rename}>
                  <span class="text-xs font-medium text-muted-foreground">Rename “{menu.key}”</span>
                  <Input bind:value={renameDraft} class="h-8" />
                </form>
                {#if onreassign && keys.length > 1}
                  <span class="mt-1 text-xs font-medium text-muted-foreground">This line is actually</span>
                  <div class="-mx-1 flex flex-col">
                    {#each keys.filter((k) => k !== sp) as k}
                      <button
                        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                        onclick={() => {
                          onreassign?.(i, k);
                          menu = null;
                        }}><span class="size-2 rounded-full" style:background={color(k)}></span>{label(k)}</button
                      >
                    {/each}
                  </div>
                {/if}
              </Popover.Content>
            {/if}
          </Popover.Root>
        {/if}
        {#if editing === i}
          <Textarea
            class="text-[14.5px] leading-relaxed"
            bind:value={draft}
            rows={Math.max(2, Math.ceil(draft.length / 90))}
            onblur={commit}
            onkeydown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") editing = null;
            }}
          />
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <p
            class="text selectable -mx-1.5 cursor-text rounded-md px-1.5 py-px text-[14.5px] leading-[1.7] transition-colors duration-200 {i === active
              ? 'bg-ember-soft'
              : 'hover:bg-muted/70'}"
            onclick={() => window.getSelection()?.isCollapsed && onseek?.(seg.start_ms)}
            ondblclick={() => startEdit(i)}
          >
            {@html highlight(seg.text)}
          </p>
        {/if}
      </div>
    </div>
  {/each}
</div>

{#if !follow && active >= 0}
  <Button variant="outline" size="sm" class="sticky bottom-2 mx-auto mt-2 flex self-center shadow-md" onclick={() => (follow = true)}>
    <ArrowDownToLine /> Follow playback
  </Button>
{/if}

<style>
  .text :global(mark) {
    background: var(--hl);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
  }
</style>

<script lang="ts">
  import { assetUrl, isVideo } from "#lib/media.js";
  import { clock } from "#lib/format.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Pause, Play, RotateCcw, RotateCw } from "@lucide/svelte";

  let {
    path,
    fallback = null,
    currentMs = $bindable(0),
    durationMs = 0,
  }: { path: string | null; fallback?: string | null; currentMs?: number; durationMs?: number } = $props();

  let el = $state<HTMLMediaElement | null>(null);
  let failed = $state(false);
  let useFallback = $state(false);
  let playing = $state(false);
  let total = $state(0);
  let rate = $state(1);
  let scrubbing = $state(false);

  const src = $derived(assetUrl(useFallback ? fallback : path));
  const video = $derived(!useFallback && isVideo(path));
  const totalMs = $derived(total ? total * 1000 : durationMs);

  export function seek(ms: number, play = true) {
    if (!el) return;
    el.currentTime = ms / 1000;
    currentMs = ms;
    if (play) el.play();
  }
  export function toggle() {
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  }

  function onerror() {
    if (!useFallback && fallback && fallback !== path) useFallback = true;
    else failed = true;
  }

  function skip(s: number) {
    if (el) el.currentTime = Math.max(0, el.currentTime + s);
  }

  function setRate() {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    rate = rates[(rates.indexOf(rate) + 1) % rates.length];
    if (el) el.playbackRate = rate;
  }

  function scrub(e: Event) {
    const v = +(e.currentTarget as HTMLInputElement).value;
    if (el) el.currentTime = v / 1000;
    currentMs = v;
  }

  function key(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable=true], select")) return;
    if (e.code === "Space") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowLeft" && e.altKey) skip(-5);
    else if (e.key === "ArrowRight" && e.altKey) skip(5);
  }
</script>

<svelte:window onkeydown={key} />

{#if src && !failed}
  <div class="overflow-hidden rounded-xl border bg-card shadow-sm">
    {#if video}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={el}
        {src}
        preload="metadata"
        class="block max-h-[300px] w-full cursor-pointer bg-black"
        onplay={() => (playing = true)}
        onpause={() => (playing = false)}
        ontimeupdate={() => !scrubbing && el && (currentMs = el.currentTime * 1000)}
        onloadedmetadata={() => el && (total = el.duration)}
        {onerror}
        onclick={toggle}
      ></video>
    {:else}
      <audio
        bind:this={el}
        {src}
        preload="metadata"
        onplay={() => (playing = true)}
        onpause={() => (playing = false)}
        ontimeupdate={() => !scrubbing && el && (currentMs = el.currentTime * 1000)}
        onloadedmetadata={() => el && isFinite(el.duration) && (total = el.duration)}
        {onerror}
      ></audio>
    {/if}
    <div class="flex items-center gap-1.5 px-2.5 py-2">
      <Button variant="ghost" size="icon-sm" class="text-muted-foreground" title="Back 10s" onclick={() => skip(-10)}><RotateCcw /></Button>
      <button
        class="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background shadow-sm transition-transform active:scale-95"
        title="Play/pause (space)"
        onclick={toggle}
      >
        {#if playing}<Pause class="size-3.5" fill="currentColor" />{:else}<Play class="ml-px size-3.5" fill="currentColor" />{/if}
      </button>
      <Button variant="ghost" size="icon-sm" class="text-muted-foreground" title="Forward 10s" onclick={() => skip(10)}><RotateCw /></Button>
      <span class="min-w-11 text-center font-mono text-[11.5px] tabular-nums">{clock(currentMs)}</span>
      <input
        type="range"
        class="scrub"
        min="0"
        max={Math.max(1, totalMs)}
        value={currentMs}
        style:--p="{totalMs ? (currentMs / totalMs) * 100 : 0}%"
        oninput={scrub}
        onpointerdown={() => (scrubbing = true)}
        onpointerup={() => (scrubbing = false)}
      />
      <span class="min-w-11 text-center font-mono text-[11.5px] text-muted-foreground tabular-nums">{clock(totalMs)}</span>
      <Button variant="ghost" size="sm" class="min-w-11 font-mono text-xs text-muted-foreground" title="Playback speed" onclick={setRate}>{rate}×</Button>
    </div>
  </div>
{:else if path}
  <div class="rounded-xl border border-dashed px-3.5 py-2.5 text-xs text-muted-foreground">Playback isn't available for this file.</div>
{/if}

<style>
  .scrub {
    flex: 1;
    appearance: none;
    height: 4px;
    border-radius: 4px;
    background: linear-gradient(to right, var(--ember) var(--p), var(--muted) var(--p));
    outline: none;
    cursor: pointer;
  }
  .scrub::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--background);
    border: 2px solid var(--ember);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
  }
</style>

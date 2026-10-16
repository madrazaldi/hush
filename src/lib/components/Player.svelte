<script lang="ts">
  import { assetUrl, isVideo } from "$lib/media";
  import { clock } from "$lib/format";
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
  <div class="player" class:video>
    {#if video}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={el}
        {src}
        preload="metadata"
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
    <div class="bar">
      <button class="btn icon sm ghost" title="Back 10s" onclick={() => skip(-10)}><RotateCcw size={14} /></button>
      <button class="play" title="Play/pause (space)" onclick={toggle}>
        {#if playing}<Pause size={15} fill="currentColor" />{:else}<Play size={15} fill="currentColor" />{/if}
      </button>
      <button class="btn icon sm ghost" title="Forward 10s" onclick={() => skip(10)}><RotateCw size={14} /></button>
      <span class="t mono">{clock(currentMs)}</span>
      <input
        type="range"
        min="0"
        max={Math.max(1, totalMs)}
        value={currentMs}
        style:--p="{totalMs ? (currentMs / totalMs) * 100 : 0}%"
        oninput={scrub}
        onpointerdown={() => (scrubbing = true)}
        onpointerup={() => (scrubbing = false)}
      />
      <span class="t mono faint">{clock(totalMs)}</span>
      <button class="btn sm ghost rate mono" onclick={setRate}>{rate}×</button>
    </div>
  </div>
{:else if path}
  <div class="player unavailable faint small">Playback isn't available for this file.</div>
{/if}

<style>
  .player {
    border-radius: var(--r);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  video {
    display: block;
    width: 100%;
    max-height: 300px;
    background: #000;
    cursor: pointer;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
  }
  .play {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 0;
    background: var(--text);
    color: var(--bg);
    cursor: pointer;
    flex: none;
  }
  .play :global(svg) {
    margin-left: 1px;
  }
  .t {
    min-width: 44px;
    text-align: center;
    font-size: 11.5px;
  }
  input[type="range"] {
    flex: 1;
    appearance: none;
    height: 4px;
    border-radius: 4px;
    background: linear-gradient(to right, var(--ember) var(--p), var(--surface-3) var(--p));
    outline: none;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }
  .rate {
    min-width: 44px;
  }
  .unavailable {
    padding: 10px 14px;
  }
</style>

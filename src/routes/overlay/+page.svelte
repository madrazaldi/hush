<script lang="ts">
  import { on } from "#lib/api.js";
  import type { OverlayState } from "#lib/types.js";
  import { Check, Lock, TriangleAlert, Wand } from "@lucide/svelte";

  const BARS = 22;
  let st = $state<OverlayState>({ phase: "idle", mode: "dictate", latched: false, message: null, style: null, app: null });
  let bars = $state<number[]>(Array(BARS).fill(0));
  let started = $state(0);
  let now = $state(Date.now());

  $effect(() => {
    document.documentElement.classList.add("overlay");
    const offs = [
      on<OverlayState>("dictation:state", (s) => {
        if (s.phase === "recording" && st.phase !== "recording") {
          started = Date.now();
          bars = Array(BARS).fill(0);
        }
        st = s;
      }),
      // ~20 Hz level samples scroll through the bars right-to-left.
      on<number>("dictation:level", (l) => {
        bars = [...bars.slice(1), Math.min(1, l * 1.25)];
      }),
    ];
    const t = setInterval(() => (now = Date.now()), 250);
    return () => {
      offs.forEach((f) => f());
      clearInterval(t);
    };
  });

  const secs = $derived(Math.max(0, Math.floor((now - started) / 1000)));
</script>

<div class="wrap">
  <div class="pill {st.phase}" class:command={st.mode === "command"}>
    {#if st.phase === "recording"}
      <span class="rec"></span>
      <div class="wave">
        {#each bars as b, i}
          <i style:height="{3 + b * 22}px" style:opacity={0.35 + (i / BARS) * 0.65}></i>
        {/each}
      </div>
      <span class="meta">
        {#if st.latched}<Lock size={11} />{/if}
        {#if st.mode === "command"}<Wand size={11} /> Command{:else}{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}{/if}
      </span>
    {:else if st.phase === "processing"}
      <div class="dots"><i></i><i></i><i></i></div>
      <span class="label">{st.mode === "command" ? "Editing" : "Writing"}…</span>
    {:else if st.phase === "done"}
      <Check size={15} />
      <span class="label">{st.mode === "command" ? "Replaced" : "Inserted"}</span>
    {:else if st.phase === "error"}
      <TriangleAlert size={14} />
      <span class="label err">{st.message ?? "Something went wrong"}</span>
    {/if}
  </div>
</div>

<style>
  :global(html.overlay),
  :global(html.overlay body) {
    background: transparent !important;
    overflow: hidden;
  }
  .wrap {
    width: 100vw;
    height: 100vh;
    display: grid;
    place-items: center;
  }
  .pill {
    height: 40px;
    min-width: 132px;
    max-width: 244px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 0 14px;
    border-radius: 999px;
    background: rgba(21, 20, 19, 0.92);
    border: 1px solid rgba(243, 237, 228, 0.1);
    box-shadow:
      0 8px 24px -8px rgba(0, 0, 0, 0.6),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
    color: #f3ede4;
    font-family: var(--sans);
    font-size: 12.5px;
    font-weight: 500;
    backdrop-filter: blur(20px) saturate(1.4);
    transition:
      min-width 0.25s var(--ease),
      opacity 0.2s;
    animation: pop 0.22s var(--ease);
  }
  .pill.idle {
    opacity: 0;
  }
  @keyframes pop {
    from {
      transform: scale(0.92);
      opacity: 0;
    }
  }
  .pill.recording {
    min-width: 210px;
  }
  .pill.command {
    border-color: rgba(255, 138, 91, 0.45);
  }
  .rec {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #e5533d;
    box-shadow: 0 0 8px #e5533d;
    flex: none;
  }
  .wave {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: 26px;
  }
  .wave i {
    width: 3px;
    border-radius: 2px;
    background: linear-gradient(180deg, #ff8a5b, #e5533d);
    transition: height 0.06s linear;
  }
  .meta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 30px;
    justify-content: flex-end;
    color: rgba(243, 237, 228, 0.6);
    font-family: var(--mono);
    font-size: 11px;
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .label.err {
    color: #ffb4a3;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    font-size: 12px;
    line-height: 1.35;
  }
  /* Errors may wrap to two lines inside the 72px panel */
  .pill.error {
    height: auto;
    min-height: 40px;
    padding: 8px 16px;
    border-radius: 18px;
  }
  .done :global(svg) {
    color: #7fb685;
  }
  .error :global(svg) {
    color: #ff8a6b;
    flex: none;
  }
  .dots {
    display: flex;
    gap: 4px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #ff8a5b;
    animation: wave 1s ease-in-out infinite;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.12s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.24s;
  }
  @keyframes wave {
    50% {
      transform: translateY(-4px);
      opacity: 0.5;
    }
  }
</style>

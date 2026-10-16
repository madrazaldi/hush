<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade, scale } from "svelte/transition";

  let { open = $bindable(false), title, width = 520, children, footer }: {
    open?: boolean;
    title?: string;
    width?: number;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  function onkey(e: KeyboardEvent) {
    if (open && e.key === "Escape") open = false;
  }
</script>

<svelte:window onkeydown={onkey} />

{#if open}
  <div class="backdrop" transition:fade={{ duration: 140 }} onclick={() => (open = false)} role="presentation"></div>
  <div class="modal card" style:width="{width}px" role="dialog" aria-modal="true" transition:scale={{ start: 0.97, duration: 180 }}>
    {#if title}<h2>{title}</h2>{/if}
    <div class="content">{@render children()}</div>
    {#if footer}<div class="footer">{@render footer()}</div>{/if}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(10, 9, 8, 0.45);
    backdrop-filter: blur(2px);
  }
  .modal {
    position: fixed;
    z-index: 81;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 80px);
    overflow: auto;
    padding: 22px 24px;
    box-shadow: var(--shadow-pop);
  }
  h2 {
    margin-bottom: 14px;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
</style>

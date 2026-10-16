<script lang="ts">
  import { app } from "#lib/state.svelte.js";
  import { CircleAlert, CircleCheck, Info, X } from "@lucide/svelte";
  import { fly } from "svelte/transition";
</script>

<div class="toasts">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}" transition:fly={{ y: 12, duration: 220 }}>
      {#if t.kind === "error"}<CircleAlert size={16} />{:else if t.kind === "success"}<CircleCheck size={16} />{:else}<Info size={16} />{/if}
      <span class="text selectable">{t.text}</span>
      {#if t.action}
        <button class="btn sm" onclick={() => { t.action!.run(); app.dismiss(t.id); }}>{t.action.label}</button>
      {/if}
      <button class="btn ghost icon sm" aria-label="Dismiss" onclick={() => app.dismiss(t.id)}><X size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 420px;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 8px 9px 14px;
    border-radius: var(--r);
    background: var(--surface-2);
    box-shadow: var(--shadow-pop);
    font-size: 13px;
  }
  .toast.error :global(svg:first-child) {
    color: var(--ember);
    flex: none;
  }
  .toast.success :global(svg:first-child) {
    color: var(--sage);
    flex: none;
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>

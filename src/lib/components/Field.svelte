<script lang="ts">
  import type { Snippet } from "svelte";
  let { label, hint, stacked = false, children }: { label: string; hint?: string; stacked?: boolean; children: Snippet } = $props();
</script>

<div class="field" class:stacked>
  <div class="text">
    <div class="label">{label}</div>
    {#if hint}<div class="hint">{hint}</div>{/if}
  </div>
  <div class="control">{@render children()}</div>
</div>

<style>
  .field {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 14px 18px;
    border-top: 1px solid var(--line);
  }
  .field:first-child {
    border-top: 0;
  }
  .field.stacked {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .label {
    font-weight: 500;
  }
  .hint {
    margin-top: 2px;
    color: var(--text-3);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .control {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .field:not(.stacked) .control :global(.select),
  .field:not(.stacked) .control :global(.input) {
    width: 240px;
  }
  .stacked .control {
    flex-direction: column;
    align-items: stretch;
  }
</style>

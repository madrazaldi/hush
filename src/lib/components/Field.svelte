<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "#lib/utils.js";

  let {
    label,
    hint,
    stacked = false,
    children,
  }: { label: string; hint?: string; stacked?: boolean; children: Snippet } = $props();
</script>

<div class={cn("flex gap-6 px-4 py-3.5", stacked ? "flex-col items-stretch gap-3" : "items-center")}>
  <div class="min-w-0 flex-1">
    <div class="text-sm font-medium">{label}</div>
    {#if hint}<p class="mt-0.5 text-[13px] leading-snug text-pretty text-muted-foreground">{hint}</p>{/if}
  </div>
  <div class={cn("flex shrink-0 gap-2", stacked ? "flex-col items-stretch" : "items-center")}>{@render children()}</div>
</div>

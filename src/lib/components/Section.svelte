<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "#lib/utils.js";

  let {
    title,
    description,
    actions,
    flush = false,
    children,
  }: { title?: string; description?: string; actions?: Snippet; flush?: boolean; children: Snippet } = $props();
</script>

<section class="mb-9 last:mb-0">
  {#if title || actions}
    <header class="mb-3 flex items-end justify-between gap-4 px-0.5">
      <div class="min-w-0">
        {#if title}<h2 class="text-[15px] font-semibold tracking-tight">{title}</h2>{/if}
        {#if description}<p class="mt-0.5 text-[13px] leading-snug text-muted-foreground">{description}</p>{/if}
      </div>
      {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class={cn(!flush && "divide-y overflow-hidden rounded-xl border bg-card shadow-xs")}>{@render children()}</div>
</section>

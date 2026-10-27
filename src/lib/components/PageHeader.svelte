<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "#lib/utils.js";

  let {
    title,
    description,
    eyebrow,
    actions,
    class: className,
  }: { title: string; description?: string; eyebrow?: string; actions?: Snippet; class?: string } = $props();
</script>

<header class={cn("mb-8 flex items-end justify-between gap-6", className)}>
  <div class="min-w-0">
    {#if eyebrow}<p class="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</p>{/if}
    <h1 class="heading text-3xl leading-tight">{title}</h1>
    {#if description}<p class="mt-1.5 text-sm text-muted-foreground">{description}</p>{/if}
  </div>
  {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</header>

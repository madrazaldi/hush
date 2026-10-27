<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "#lib/utils.js";

  // The scrolling body of a route. `narrow` for reading pages, `wide` for lists and dashboards.
  let { size = "wide", class: className, children }: { size?: "narrow" | "wide"; class?: string; children: Snippet } = $props();
</script>

<div class="h-full overflow-y-auto">
  <div class={cn("mx-auto px-10 pt-12 pb-16", size === "narrow" ? "max-w-3xl" : "max-w-5xl", className)}>
    {@render children()}
  </div>
</div>

<script lang="ts">
  import { keyGlyphs } from "#lib/format.js";
  import { Kbd, KbdGroup } from "#lib/components/ui/kbd/index.js";
  import { cn } from "#lib/utils.js";
  let { combo, class: className }: { combo: string; class?: string } = $props();
</script>

<KbdGroup class={cn("align-middle", className)}>
  {#each keyGlyphs(combo) as k}<Kbd class="border-b-2 border border-border bg-background shadow-xs">{k}</Kbd>{/each}
</KbdGroup>

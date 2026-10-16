<script lang="ts">
  import { keyGlyphs } from "#lib/format.js";
  let { combo }: { combo: string } = $props();
</script>

<span class="keys">
  {#each keyGlyphs(combo) as k}<kbd>{k}</kbd>{/each}
</span>

<style>
  .keys {
    display: inline-flex;
    gap: 3px;
    vertical-align: middle;
  }
</style>

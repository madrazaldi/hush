<script lang="ts">
  import { Switch } from "#lib/components/ui/switch/index.js";

  let {
    checked = $bindable(false),
    disabled = false,
    label = "Toggle",
    onchange,
  }: { checked?: boolean; disabled?: boolean; label?: string; onchange?: (v: boolean) => void } = $props();
</script>

<Switch bind:checked {disabled} aria-label={label} onCheckedChange={(v) => onchange?.(v)} />

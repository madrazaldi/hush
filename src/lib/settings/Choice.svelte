<script lang="ts" generics="T">
  import * as Select from "#lib/components/ui/select/index.js";
  import { cn } from "#lib/utils.js";

  // A shadcn Select over arbitrary values (null, numbers, ids): options are keyed by index, so the bound
  // value keeps its type.
  let {
    value = $bindable(),
    options,
    onchange,
    placeholder = "Choose…",
    size = "default",
    class: className,
  }: {
    value: T;
    options: readonly (readonly [NoInfer<T>, string])[];
    onchange?: (v: T) => void;
    placeholder?: string;
    size?: "sm" | "default";
    class?: string;
  } = $props();

  const idx = $derived(options.findIndex(([v]) => v === value));
</script>

<Select.Root
  type="single"
  value={idx >= 0 ? String(idx) : ""}
  onValueChange={(v) => {
    const o = options[Number(v)];
    if (!o) return;
    value = o[0];
    onchange?.(o[0]);
  }}
>
  <Select.Trigger {size} class={cn("w-60 justify-between bg-background", className)}>
    <span class={cn("truncate", idx < 0 && "text-muted-foreground")}>{idx >= 0 ? options[idx][1] : placeholder}</span>
  </Select.Trigger>
  <Select.Content class="max-h-80 p-1">
    {#each options as [, label], i}
      <Select.Item value={String(i)} {label} />
    {/each}
  </Select.Content>
</Select.Root>

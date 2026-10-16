<script lang="ts">
  let { label, level, active = true, tone = "ember" }: { label: string; level: number; active?: boolean; tone?: "ember" | "sage" } = $props();
  const BARS = 7;
</script>

<div class="lv" class:off={!active} title={active ? label : `${label}: not capturing`}>
  <span class="bars" data-tone={tone}>
    {#each Array(BARS) as _, i}
      <i class:on={active && level * BARS > i + 0.15} style:height="{5 + Math.sin(((i + 0.5) / BARS) * Math.PI) * 9}px"></i>
    {/each}
  </span>
  <span class="small">{label}</span>
</div>

<style>
  .lv {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--text-2);
  }
  .lv.off {
    opacity: 0.45;
  }
  .bars {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 16px;
  }
  i {
    width: 3px;
    border-radius: 2px;
    background: var(--line-2);
    transition: background 0.08s;
  }
  [data-tone="ember"] i.on {
    background: var(--ember);
  }
  [data-tone="sage"] i.on {
    background: var(--sage);
  }
</style>

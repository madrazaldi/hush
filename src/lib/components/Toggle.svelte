<script lang="ts">
  let {
    checked = $bindable(false),
    disabled = false,
    label = "Toggle",
    onchange,
  }: { checked?: boolean; disabled?: boolean; label?: string; onchange?: (v: boolean) => void } = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  class="toggle"
  class:on={checked}
  {disabled}
  onclick={() => {
    checked = !checked;
    onchange?.(checked);
  }}
>
  <span></span>
</button>

<style>
  .toggle {
    position: relative;
    width: 34px;
    height: 20px;
    flex: none;
    border-radius: 999px;
    border: 0;
    padding: 0;
    background: var(--surface-3);
    cursor: pointer;
    transition: background 0.2s var(--ease);
    box-shadow: inset 0 0 0 1px var(--line-2);
  }
  .toggle span {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fbf8f3;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform 0.22s var(--ease);
  }
  .toggle.on {
    background: var(--ember);
    box-shadow: none;
  }
  .toggle.on span {
    transform: translateX(14px);
  }
  .toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>

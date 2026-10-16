<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, description, actions, children }: { title?: string; description?: string; actions?: Snippet; children: Snippet } = $props();
</script>

<section>
  {#if title}
    <header>
      <div>
        <h3>{title}</h3>
        {#if description}<p class="muted small">{description}</p>{/if}
      </div>
      {#if actions}<div class="row">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="card body">{@render children()}</div>
</section>

<style>
  section {
    margin-bottom: 28px;
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    margin: 0 4px 10px;
  }
  h3 {
    font-family: var(--sans);
    font-size: 13.5px;
    font-weight: 650;
  }
  header p {
    margin-top: 2px;
  }
  .body {
    border-radius: var(--r);
    overflow: hidden;
  }
</style>

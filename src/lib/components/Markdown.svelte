<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "dompurify";

  let { source, class: klass = "" }: { source: string; class?: string } = $props();
  const html = $derived(DOMPurify.sanitize(marked.parse(source ?? "", { async: false, gfm: true, breaks: false }) as string));
</script>

<div class="prose {klass}">{@html html}</div>

<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "dompurify";

  let { source, class: klass = "" }: { source: string; class?: string } = $props();
  // Content comes from AI output and transcripts, so nothing in it may load a
  // resource on its own (an image URL could carry private notes to a server).
  const html = $derived(
    DOMPurify.sanitize(marked.parse(source ?? "", { async: false, gfm: true, breaks: true }) as string, {
      FORBID_TAGS: ["img", "picture", "video", "audio", "source", "track", "iframe", "object", "embed", "style", "link", "form"],
      FORBID_ATTR: ["style", "srcset", "background", "poster"],
    }),
  );
</script>

<div class="prose {klass}">{@html html}</div>

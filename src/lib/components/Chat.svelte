<script lang="ts">
  import { tick } from "svelte";
  import { writeText } from "#lib/ipc.js";
  import { api, errorText, streamLlm } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import type { ChatMessage, Recipe } from "#lib/types.js";
  import Markdown from "./Markdown.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { ArrowUp, Copy, Eraser, Square, Sparkles } from "@lucide/svelte";

  let {
    id,
    messages = $bindable([]),
    recipes = [],
    suggestions = [],
    llmName,
  }: { id: string; messages?: ChatMessage[]; recipes?: Recipe[]; suggestions?: string[]; llmName: string } = $props();

  let input = $state("");
  let streaming = $state<string | null>(null);
  let pending = $state<string | null>(null);
  let requestId = "";
  let scroller = $state<HTMLDivElement | null>(null);

  const recipeByPrompt = $derived(new Map(recipes.map((r) => [r.prompt, r.name])));

  async function scroll() {
    await tick();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  // Bumped when the component is reused for another recording, so a reply
  // still streaming for the previous one is dropped instead of shown here.
  let run = 0;
  $effect(() => {
    id;
    run++;
    streaming = null;
    pending = null;
    input = "";
  });

  async function send(question: string, recipeId?: string) {
    if (!question.trim() || streaming !== null) return;
    const mine = run;
    const forId = id;
    pending = question;
    streaming = "";
    input = "";
    scroll();
    try {
      const { requestId: rid, result } = await streamLlm(
        (r) => (recipeId ? api.runRecipe(forId, recipeId, r) : api.chat(forId, question, r)),
        (d) => {
          if (mine !== run) return;
          streaming += d;
          scroll();
        },
      );
      requestId = rid;
      const answer = await result;
      if (mine !== run) return;
      messages = [...messages, { role: "user", content: question }, { role: "assistant", content: answer }];
    } catch (e) {
      const msg = errorText(e);
      if (mine === run && !/cancel/i.test(msg)) app.toast("error", msg);
    } finally {
      if (mine === run) {
        streaming = null;
        pending = null;
        scroll();
      }
    }
  }

  async function clear() {
    await api.clearChat(id);
    messages = [];
  }

  $effect(() => {
    messages.length;
    scroll();
  });
</script>

{#snippet chip(text: string, run: () => void)}
  <button
    class="rounded-full border bg-background px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-ember/40 hover:bg-ember-soft hover:text-ember-text"
    onclick={run}>{text}</button
  >
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <div class="flex flex-1 flex-col gap-4 overflow-y-auto px-0.5 pt-1 pb-3" bind:this={scroller}>
    {#if !messages.length && pending === null}
      <div class="flex flex-col gap-3 py-2">
        <div class="grid size-9 place-items-center rounded-lg bg-ember-soft text-ember-text"><Sparkles class="size-4" /></div>
        <div>
          <p class="text-sm font-medium">Ask about this transcript</p>
          <p class="mt-0.5 text-xs text-muted-foreground">Answers come from {llmName}.</p>
        </div>
        {#if recipes.length}
          <div class="flex flex-wrap gap-1.5">
            {#each recipes as r}{@render chip(r.name, () => send(r.prompt, r.id))}{/each}
          </div>
        {/if}
        {#if suggestions.length}
          <div class="flex flex-wrap gap-1.5">
            {#each suggestions as q}{@render chip(q, () => send(q))}{/each}
          </div>
        {/if}
      </div>
    {/if}

    {#each messages as m}
      {#if m.role === "user"}
        <div class="selectable max-w-[88%] self-end rounded-2xl rounded-br-md bg-muted px-3 py-2 text-[13px] whitespace-pre-wrap">
          {recipeByPrompt.get(m.content) ?? m.content}
        </div>
      {:else}
        <div class="group/a relative">
          <Markdown source={m.content} class="text-[13.5px]" />
          <Button
            variant="ghost"
            size="icon-xs"
            class="absolute -right-1 -bottom-2 text-muted-foreground opacity-0 group-hover/a:opacity-100"
            title="Copy"
            onclick={() => writeText(m.content).then(() => app.toast("success", "Copied"))}
          >
            <Copy />
          </Button>
        </div>
      {/if}
    {/each}
    {#if pending !== null}
      <div class="selectable max-w-[88%] self-end rounded-2xl rounded-br-md bg-muted px-3 py-2 text-[13px] whitespace-pre-wrap">
        {recipeByPrompt.get(pending) ?? pending}
      </div>
      <div>
        {#if streaming}<Markdown source={streaming} class="text-[13.5px]" />{:else}<span class="typing inline-flex gap-1 py-1.5"><i></i><i></i><i></i></span>{/if}
      </div>
    {/if}
  </div>

  {#if messages.length && recipes.length && streaming === null}
    <div class="flex flex-wrap gap-1.5 py-2">
      {#each recipes.slice(0, 4) as r}{@render chip(r.name, () => send(r.prompt, r.id))}{/each}
    </div>
  {/if}

  <form
    class="flex items-end gap-1 rounded-xl border bg-background p-1.5 pl-3 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20"
    onsubmit={(e) => {
      e.preventDefault();
      send(input);
    }}
  >
    <textarea
      class="selectable field-sizing-content max-h-36 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
      rows="1"
      placeholder="Ask about this transcript…"
      bind:value={input}
      onkeydown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send(input);
        }
      }}
    ></textarea>
    {#if streaming !== null}
      <Button type="button" variant="secondary" size="icon-sm" title="Stop" onclick={() => api.cancelLlm(requestId)}><Square class="size-3" fill="currentColor" /></Button>
    {:else}
      {#if messages.length}
        <Button type="button" variant="ghost" size="icon-sm" class="text-muted-foreground" title="Clear chat" onclick={clear}><Eraser /></Button>
      {/if}
      <Button type="submit" size="icon-sm" title="Send" disabled={!input.trim()}><ArrowUp /></Button>
    {/if}
  </form>
</div>

<style>
  .typing i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted-foreground);
    animation: bounce 1.2s infinite;
  }
  .typing i:nth-child(2) {
    animation-delay: 0.15s;
  }
  .typing i:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes bounce {
    30% {
      transform: translateY(-4px);
      background: var(--ember);
    }
  }
</style>

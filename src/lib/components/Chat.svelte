<script lang="ts">
  import { tick } from "svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { api, errorText, streamLlm } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import type { ChatMessage, Recipe } from "#lib/types.js";
  import Markdown from "./Markdown.svelte";
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

<div class="chat">
  <div class="scroll" bind:this={scroller}>
    {#if !messages.length && pending === null}
      <div class="intro">
        <Sparkles size={18} />
        <p class="muted small">Ask anything about this transcript. Answers come from {llmName}.</p>
        {#if recipes.length}
          <div class="chips">
            {#each recipes as r}
              <button class="chip" onclick={() => send(r.prompt, r.id)}>{r.name}</button>
            {/each}
          </div>
        {/if}
        {#if suggestions.length}
          <div class="chips">
            {#each suggestions as q}
              <button class="chip" onclick={() => send(q)}>{q}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#each messages as m}
      {#if m.role === "user"}
        <div class="q">{recipeByPrompt.get(m.content) ?? m.content}</div>
      {:else}
        <div class="a">
          <Markdown source={m.content} />
          <button class="btn icon sm ghost copy" title="Copy" onclick={() => writeText(m.content).then(() => app.toast("success", "Copied"))}>
            <Copy size={12} />
          </button>
        </div>
      {/if}
    {/each}
    {#if pending !== null}
      <div class="q">{recipeByPrompt.get(pending) ?? pending}</div>
      <div class="a">
        {#if streaming}<Markdown source={streaming} />{:else}<span class="typing"><i></i><i></i><i></i></span>{/if}
      </div>
    {/if}
  </div>

  {#if messages.length && recipes.length && streaming === null}
    <div class="chips more">
      {#each recipes.slice(0, 4) as r}
        <button class="chip" onclick={() => send(r.prompt, r.id)}>{r.name}</button>
      {/each}
    </div>
  {/if}

  <form
    class="box"
    onsubmit={(e) => {
      e.preventDefault();
      send(input);
    }}
  >
    <textarea
      class="selectable"
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
      <button type="button" class="btn icon sm" title="Stop" onclick={() => api.cancelLlm(requestId)}><Square size={11} fill="currentColor" /></button>
    {:else}
      {#if messages.length}
        <button type="button" class="btn icon sm ghost" title="Clear chat" onclick={clear}><Eraser size={14} /></button>
      {/if}
      <button class="btn icon sm primary" title="Send" disabled={!input.trim()}><ArrowUp size={14} /></button>
    {/if}
  </form>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px 2px 12px;
  }
  .intro {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 2px;
  }
  .intro > :global(svg) {
    color: var(--ember-text);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chips .chip {
    height: 26px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .chips .chip:hover {
    color: var(--text);
    border-color: var(--line-2);
  }
  .more {
    padding: 6px 0;
  }
  .q {
    align-self: flex-end;
    max-width: 88%;
    padding: 8px 12px;
    border-radius: 14px 14px 4px 14px;
    background: var(--surface-3);
    font-size: 13px;
    white-space: pre-wrap;
    user-select: text;
    -webkit-user-select: text;
  }
  .a {
    position: relative;
  }
  .a :global(.prose) {
    font-size: 13.5px;
  }
  .copy {
    position: absolute;
    right: -4px;
    bottom: -6px;
    opacity: 0;
  }
  .a:hover .copy {
    opacity: 1;
  }
  .typing {
    display: inline-flex;
    gap: 4px;
    padding: 6px 0;
  }
  .typing i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
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
  .box {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 6px 6px 6px 12px;
    border-radius: var(--r);
    border: 1px solid var(--line-2);
    background: var(--surface);
  }
  .box:focus-within {
    border-color: color-mix(in srgb, var(--ember) 55%, transparent);
  }
  .box textarea {
    flex: 1;
    min-height: 26px;
    max-height: 140px;
    padding: 4px 0;
    border: 0;
    outline: 0;
    resize: none;
    background: none;
    color: var(--text);
    font: inherit;
    field-sizing: content;
  }
  .box textarea::placeholder {
    color: var(--text-3);
  }
</style>

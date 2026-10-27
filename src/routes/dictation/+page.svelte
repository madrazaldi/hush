<script lang="ts">
  import { page } from "$app/state";
  import { writeText, ask } from "#lib/ipc.js";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { dayGroup, groupBy, words } from "#lib/format.js";
  import { newId } from "#lib/providers.js";
  import type { Dictation, Style } from "#lib/types.js";
  import Keys from "#lib/components/Keys.svelte";
  import Toggle from "#lib/components/Toggle.svelte";
  import Page from "#lib/components/Page.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as Empty from "#lib/components/ui/empty/index.js";
  import * as InputGroup from "#lib/components/ui/input-group/index.js";
  import * as Tooltip from "#lib/components/ui/tooltip/index.js";
  import { Spinner } from "#lib/components/ui/spinner/index.js";
  import { Copy, Search, Trash2, Wand, Plus, X, ArrowRight, Terminal, Sparkles, MicOff, BookA, Replace, MessageSquareQuote } from "@lucide/svelte";

  type Tab = "history" | "styles" | "vocabulary";
  let tab = $state<Tab>((page.url.searchParams.get("tab") as Tab) ?? "history");

  const s = $derived(app.settings!);

  // ---------- History ----------
  let query = $state("");
  let items = $state<Dictation[]>([]);
  let limit = $state(100);
  let showRaw = $state<Record<string, boolean>>({});

  $effect(() => {
    app.dictationsVersion;
    const q = query;
    const l = limit;
    const t = setTimeout(() => api.dictations(q, l).then((d) => (items = d)), q ? 180 : 0);
    return () => clearTimeout(t);
  });
  const groups = $derived(groupBy(items, (d) => dayGroup(d.created_at)));

  async function copy(text: string) {
    await writeText(text);
    app.toast("success", "Copied");
  }
  async function remove(id: string) {
    await api.deleteDictation(id);
    items = items.filter((d) => d.id !== id);
  }
  async function clearAll() {
    if (await ask("Delete all dictation history? This can't be undone.", { title: "Clear history", kind: "warning" })) {
      await api.clearDictations();
      items = [];
    }
  }

  // ---------- Styles ----------
  let selected = $state<string>("");
  const style = $derived(s.dictation.styles.find((x) => x.id === (selected || s.dictation.default_style)) ?? s.dictation.styles[0]);
  let sample = $state("um so basically i wanted to uh let you know that the the deploy is done and we can ship tomorrow");
  let preview = $state("");
  let previewing = $state(false);

  function addStyle() {
    const st: Style = { id: newId("style"), name: "New style", prompt: "Describe how the text should be written.", apps: [], builtin: false };
    s.dictation.styles.push(st);
    selected = st.id;
    app.save();
  }
  function deleteStyle(st: Style) {
    s.dictation.styles = s.dictation.styles.filter((x) => x.id !== st.id);
    if (s.dictation.default_style === st.id) s.dictation.default_style = "clean";
    selected = "";
    app.save();
  }
  async function runPreview() {
    previewing = true;
    preview = "";
    try {
      preview = await api.applyStyle(sample, style.id);
    } catch (e) {
      preview = `⚠ ${errorText(e)}`;
    } finally {
      previewing = false;
    }
  }

  // ---------- Vocabulary ----------
  let newWord = $state("");
  function addWord(e: Event) {
    e.preventDefault();
    const w = newWord.trim();
    if (!w) return;
    for (const part of w.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!s.vocabulary.includes(part)) s.vocabulary.push(part);
    }
    newWord = "";
    app.save();
  }
</script>

{#snippet removable(label: string, onremove: () => void)}
  <Badge variant="secondary" class="h-6 gap-1 rounded-md pr-1 pl-2 text-xs font-medium">
    {label}
    <button
      class="grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      aria-label="Remove"
      onclick={onremove}><X class="size-3" /></button
    >
  </Badge>
{/snippet}

{#snippet iconButton(label: string, onclick: () => void, Icon: typeof Copy, cls = "")}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm" class={cls} aria-label={label} {onclick}><Icon /></Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip.Root>
{/snippet}

{#snippet section(Icon: typeof BookA, title: string, description: string)}
  <div class="flex items-start gap-3">
    <div class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon class="size-4" /></div>
    <div>
      <h3 class="font-semibold">{title}</h3>
      <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  </div>
{/snippet}

<Page size="narrow">
  <Tabs.Root bind:value={tab} class="flex-col gap-0">
    <header class="mb-8">
      <div class="flex items-center justify-between gap-6">
        <h1 class="heading text-3xl leading-tight">Dictation</h1>
        <Tabs.List class="shrink-0">
          <Tabs.Trigger value="history" class="px-3">History</Tabs.Trigger>
          <Tabs.Trigger value="styles" class="px-3">Styles</Tabs.Trigger>
          <Tabs.Trigger value="vocabulary" class="px-3">Vocabulary</Tabs.Trigger>
        </Tabs.List>
      </div>
      <p class="mt-2 text-sm leading-6 text-muted-foreground">
        {s.dictation.activation === "toggle" ? "Press" : "Hold"} <Keys combo={s.dictation.hotkey} /> to talk in any app.
        <Keys combo={s.dictation.command_hotkey} /> edits selected text with your voice.
      </p>
    </header>

    <Tabs.Content value="history">
      <div class="flex items-center gap-2">
        <InputGroup.Root class="h-9 flex-1 bg-card dark:bg-card">
          <InputGroup.Addon class="pl-3"><Search /></InputGroup.Addon>
          <InputGroup.Input placeholder="Search dictations" bind:value={query} />
        </InputGroup.Root>
        {#if items.length}
          <Button variant="ghost" class="h-9 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onclick={clearAll}><Trash2 /> Clear</Button>
        {/if}
      </div>

      {#each groups as [day, list]}
        <h4 class="mt-7 mb-2 px-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">{day}</h4>
        <Card.Root class="gap-0 divide-y py-0">
          {#each list as d (d.id)}
            <article class="group/row flex gap-4 px-4 py-3.5 transition-colors hover:bg-muted/40">
              <time class="w-16 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                {new Date(d.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </time>
              <div class="min-w-0 flex-1">
                {#if d.error}
                  <p class="mb-1 text-xs text-destructive">{d.error}</p>
                {/if}
                <p class="selectable text-sm leading-relaxed whitespace-pre-wrap">{showRaw[d.id] ? d.raw_text : d.text || d.raw_text}</p>
                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                  {#if d.kind === "command"}<Badge class="border-transparent bg-ember-soft text-ember-text"><Terminal /> Command</Badge>{/if}
                  {#if d.app}<Badge variant="outline" class="text-muted-foreground">{d.app}</Badge>{/if}
                  {#if d.style && d.kind !== "command"}
                    <Badge variant="outline" class="text-muted-foreground">{s.dictation.styles.find((x) => x.id === d.style)?.name ?? d.style}</Badge>
                  {/if}
                  <span class="ml-0.5 text-xs text-muted-foreground">{words(d.text)} words · {(d.duration_ms / 1000).toFixed(1)}s</span>
                  {#if d.raw_text && d.raw_text !== d.text}
                    <button
                      class="text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                      onclick={() => (showRaw[d.id] = !showRaw[d.id])}>{showRaw[d.id] ? "Show final" : "Show original"}</button
                    >
                  {/if}
                </div>
              </div>
              <div class="-my-1 flex gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                {@render iconButton("Copy", () => copy(showRaw[d.id] ? d.raw_text : d.text), Copy)}
                {@render iconButton("Delete", () => remove(d.id), Trash2, "hover:bg-destructive/10 hover:text-destructive")}
              </div>
            </article>
          {/each}
        </Card.Root>
      {:else}
        <Empty.Root class="mt-6 border border-dashed py-14">
          <Empty.Header>
            <Empty.Media variant="icon">{#if query}<Search />{:else}<MicOff />{/if}</Empty.Media>
            <Empty.Title class="heading text-lg">{query ? "No matches" : "Nothing dictated yet"}</Empty.Title>
            <Empty.Description>{query ? "Try a different search." : "Put your cursor in any text field and hold your hotkey to start."}</Empty.Description>
          </Empty.Header>
        </Empty.Root>
      {/each}
      {#if items.length >= limit}
        <div class="mt-5 flex justify-center"><Button variant="outline" onclick={() => (limit += 100)}>Load more</Button></div>
      {/if}
    </Tabs.Content>

    <Tabs.Content value="styles">
      <Card.Root class="mb-6 flex-row items-center gap-4 px-4 py-3.5">
        <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-ember-soft text-ember-text"><Sparkles class="size-4" /></div>
        <div class="min-w-0 flex-1">
          <p class="font-semibold">Polish with AI</p>
          <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {#if s.llm_profiles.length}
              Rewrite each dictation with {app.llmName(s.dictation.llm_profile)} using the style for the app you're in.
              Without it, Hush still removes filler words and applies your replacements.
            {:else}
              Add an AI provider in <a class="text-ember-text underline underline-offset-2" href="/settings?tab=ai">Settings → AI</a> to rewrite dictation in these styles.
            {/if}
          </p>
        </div>
        {#if s.llm_profiles.length}
          <Select.Root type="single" bind:value={s.dictation.llm_profile} onValueChange={() => app.save()}>
            <Select.Trigger class="w-44">{app.llmName(s.dictation.llm_profile)}</Select.Trigger>
            <Select.Content>
              {#each s.llm_profiles as p}<Select.Item value={p.id} label={p.name}>{p.name}</Select.Item>{/each}
            </Select.Content>
          </Select.Root>
        {/if}
        <Toggle bind:checked={s.dictation.llm_enabled} disabled={!s.llm_profiles.length} onchange={() => app.save()} />
      </Card.Root>

      <div class="grid grid-cols-[180px_1fr] items-start gap-5">
        <nav class="flex flex-col gap-0.5">
          {#each s.dictation.styles as st (st.id)}
            <button
              class="flex h-8 items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors {style?.id === st.id
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
              onclick={() => {
                selected = st.id;
                preview = "";
              }}
            >
              <span class="truncate">{st.name}</span>
              {#if s.dictation.default_style === st.id}<span class="size-1.5 shrink-0 rounded-full bg-ember" title="Default"></span>{/if}
            </button>
          {/each}
          <button
            class="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onclick={addStyle}><Plus class="size-3.5" /> New style</button
          >
        </nav>

        {#if style}
          <Card.Root class="gap-5 px-5 py-5">
            <div class="flex items-center gap-2">
              <Input class="h-9 flex-1 text-[15px] font-semibold" bind:value={style.name} oninput={() => app.save()} disabled={style.builtin} />
              {#if s.dictation.default_style === style.id}
                <Badge class="h-6 border-transparent bg-ember-soft text-ember-text">Default</Badge>
              {:else}
                <Button variant="outline" size="sm" onclick={() => { s.dictation.default_style = style.id; app.save(); }}>Make default</Button>
              {/if}
              {#if !style.builtin}
                {@render iconButton("Delete style", () => deleteStyle(style), Trash2, "hover:bg-destructive/10 hover:text-destructive")}
              {/if}
            </div>

            <div class="flex flex-col gap-2">
              <Label for="sp" class="text-xs text-muted-foreground">Instructions</Label>
              <Textarea id="sp" class="min-h-28 leading-relaxed" bind:value={style.prompt} oninput={() => app.save()} />
            </div>

            <div class="flex flex-col gap-2">
              <Label class="text-xs text-muted-foreground">Use automatically in</Label>
              <div class="flex flex-wrap items-center gap-1.5">
                {#each style.apps as a, i}
                  {@render removable(a, () => { style.apps.splice(i, 1); app.save(); })}
                {/each}
                <Input
                  class="h-7 w-56 text-xs"
                  placeholder="Add app name or bundle id…"
                  onkeydown={(e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
                    const el = e.currentTarget;
                    if (e.key === "Enter" && el.value.trim()) {
                      style.apps.push(el.value.trim());
                      el.value = "";
                      app.save();
                    }
                  }}
                />
              </div>
            </div>

            <div class="-mx-5 -mb-5 flex flex-col gap-2.5 border-t bg-muted/40 px-5 pt-4 pb-5">
              <Label class="text-xs text-muted-foreground">Try it</Label>
              <Textarea class="min-h-14 bg-background dark:bg-background" bind:value={sample} />
              <div class="flex items-center gap-3">
                <Button variant="outline" size="sm" class="bg-background" onclick={runPreview} disabled={previewing}>
                  {#if previewing}<Spinner />{:else}<Wand />{/if}
                  {previewing ? "Rewriting…" : "Preview"}
                </Button>
                {#if !s.dictation.llm_enabled}<span class="text-xs text-muted-foreground">AI polish is off: preview shows rule-based cleanup.</span>{/if}
              </div>
              {#if preview}
                <div class="selectable flex gap-2.5 rounded-lg border border-ember/20 bg-ember-soft px-3.5 py-2.5 text-sm leading-relaxed">
                  <ArrowRight class="mt-1 size-3.5 shrink-0 text-ember-text" />
                  {preview}
                </div>
              {/if}
            </div>
          </Card.Root>
        {/if}
      </div>
    </Tabs.Content>

    <Tabs.Content value="vocabulary" class="flex flex-col gap-4">

      <Card.Root class="gap-4 px-5 py-5">
        {@render section(BookA, "Vocabulary", "Names, jargon and acronyms you say often. Hush biases recognition toward them and the AI fixes near-misses.")}
        <form class="flex gap-2" onsubmit={addWord}>
          <Input class="h-9" placeholder="e.g. Kubernetes, Anaïs, OKRs" bind:value={newWord} />
          <Button type="submit" class="h-9 px-4" disabled={!newWord.trim()}>Add</Button>
        </form>
        <div class="flex flex-wrap items-center gap-1.5">
          {#each s.vocabulary as w, i}
            {@render removable(w, () => { s.vocabulary.splice(i, 1); app.save(); })}
          {:else}
            <span class="text-xs text-muted-foreground">No words yet.</span>
          {/each}
        </div>
      </Card.Root>

      <Card.Root class="gap-4 px-5 py-5">
        {@render section(Replace, "Replacements", "Always swap a spoken phrase for exact text — great for emails, links and signatures.")}
        {#if s.replacements.length}
          <div class="flex flex-col gap-2">
            {#each s.replacements as r, i}
              <div class="flex items-center gap-2">
                <Input placeholder="When I say…" bind:value={r.from} oninput={() => app.save()} />
                <ArrowRight class="size-3.5 shrink-0 text-muted-foreground" />
                <Input placeholder="Write…" bind:value={r.to} oninput={() => app.save()} />
                <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground" aria-label="Remove" onclick={() => { s.replacements.splice(i, 1); app.save(); }}><X /></Button>
              </div>
            {/each}
          </div>
        {/if}
        <div><Button variant="outline" size="sm" onclick={() => s.replacements.push({ from: "", to: "" })}><Plus /> Add replacement</Button></div>
      </Card.Root>

      <Card.Root class="gap-4 px-5 py-5">
        {@render section(MessageSquareQuote, "Spoken commands", "Say these while dictating:")}
        <div class="divide-y rounded-lg border">
          {#each [["new line", "line break"], ["new paragraph", "blank line"], ["scratch that", "drops the last phrase (with AI polish)"]] as [cmd, what]}
            <div class="flex items-center gap-3 px-3 py-2 text-sm">
              <code class="w-36 shrink-0 font-mono text-xs text-ember-text">“{cmd}”</code>
              <span class="text-muted-foreground">{what}</span>
            </div>
          {/each}
        </div>
      </Card.Root>
    </Tabs.Content>
  </Tabs.Root>
</Page>

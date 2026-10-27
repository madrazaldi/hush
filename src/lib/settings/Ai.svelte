<script lang="ts">
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { LLM_KINDS, LLM_PRESETS, blankLlm } from "#lib/providers.js";
  import type { CliStatus, LlmKind, LlmProfile } from "#lib/types.js";
  import Section from "#lib/components/Section.svelte";
  import Field from "#lib/components/Field.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Spinner } from "#lib/components/ui/spinner/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import Choice from "./Choice.svelte";
  import { cn } from "#lib/utils.js";
  import { slide } from "svelte/transition";
  import { Check, Plus, Trash2, Terminal, Cloud, RefreshCw, ChevronRight, CircleCheck, CircleX, Sparkles } from "@lucide/svelte";

  const s = $derived(app.settings!);
  const JOBS = [
    ["Dictation polish & commands", "dictation"],
    ["Meeting notes & chat", "meetings"],
    ["File summaries & chat", "files"],
  ] as const;
  const CLI_KINDS: LlmKind[] = ["claude_code", "codex", "opencode", "gemini", "antigravity"];
  let clis = $state<CliStatus[]>([]);
  let detecting = $state(false);
  let adding = $state(false);
  let open = $state<string | null>(null);
  let testing = $state<Record<string, boolean>>({});
  let results = $state<Record<string, { ok: boolean; text: string }>>({});
  let modelLists = $state<Record<string, string[]>>({});

  async function detect() {
    detecting = true;
    clis = await api.detectClis();
    detecting = false;
  }
  $effect(() => {
    detect();
  });

  function cliFor(kind: LlmKind) {
    return clis.find((c) => c.kind === kind);
  }

  function add(p: LlmProfile) {
    s.llm_profiles.push(p);
    open = p.id;
    adding = false;
    app.save();
  }
  function addCli(kind: LlmKind) {
    add(blankLlm(kind));
  }
  function addPreset(pr: (typeof LLM_PRESETS)[number]) {
    const p = blankLlm(pr.kind, pr.name);
    p.base_url = pr.base_url;
    p.model = pr.model;
    add(p);
  }
  function remove(p: LlmProfile) {
    s.llm_profiles = s.llm_profiles.filter((x) => x.id !== p.id);
    app.save();
  }

  async function test(p: LlmProfile) {
    testing[p.id] = true;
    delete results[p.id];
    try {
      results[p.id] = { ok: true, text: await api.testLlm($state.snapshot(p) as LlmProfile) };
    } catch (e) {
      results[p.id] = { ok: false, text: errorText(e) };
    } finally {
      testing[p.id] = false;
    }
  }

  async function fetchModels(p: LlmProfile) {
    try {
      modelLists[p.id] = await api.llmModels($state.snapshot(p) as LlmProfile);
      if (!modelLists[p.id].length) app.toast("info", "No models reported by this provider.");
    } catch (e) {
      app.toast("error", errorText(e));
    }
  }
</script>

{#if s.llm_profiles.length}
  <Section title="Use for" description="Which AI handles each job. CLIs use your existing subscriptions; API keys bill per use.">
    {#each JOBS as [label, key]}
      <Field {label}>
        <Choice bind:value={s[key].llm_profile} onchange={() => app.save()} options={s.llm_profiles.map((p) => [p.id, p.name] as const)} />
      </Field>
    {/each}
  </Section>
{/if}

{#snippet field(label: string, wide: boolean, body: import("svelte").Snippet)}
  <div class={cn("flex flex-col gap-1.5", wide && "col-span-2")}>
    <Label class="text-xs text-muted-foreground">{label}</Label>
    {@render body()}
  </div>
{/snippet}

<Section title="Providers" description="Hush sends transcripts and notes only to the provider you pick, with tools and file access disabled." flush>
  {#snippet actions()}
    <DropdownMenu.Root bind:open={adding}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}<Button {...props} variant="outline" size="sm"><Plus /> Add provider</Button>{/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-64">
        <DropdownMenu.Label class="text-xs text-muted-foreground">Agent CLIs</DropdownMenu.Label>
        {#each CLI_KINDS as k}
          <DropdownMenu.Item onSelect={() => addCli(k)}>
            <Terminal /> {LLM_KINDS[k].label}
            {#if cliFor(k)?.path}<Badge class="ml-auto h-4 bg-sage-soft px-1.5 text-[10px] text-sage">Installed</Badge>{/if}
          </DropdownMenu.Item>
        {/each}
        <DropdownMenu.Separator />
        <DropdownMenu.Label class="text-xs text-muted-foreground">API (bring your own key)</DropdownMenu.Label>
        {#each LLM_PRESETS as pr}
          <DropdownMenu.Item onSelect={() => addPreset(pr)}><Cloud /> {pr.name}</DropdownMenu.Item>
        {/each}
        <DropdownMenu.Item onSelect={() => add(blankLlm("openai_chat", "Custom endpoint"))}><Cloud /> Custom Chat Completions</DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => add(blankLlm("openai_responses", "Custom Responses"))}><Cloud /> Custom Responses</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}

  <div class="flex flex-col gap-2.5">
    {#each s.llm_profiles as p (p.id)}
      {@const info = LLM_KINDS[p.kind]}
      {@const cli = info.cli ? cliFor(p.kind) : undefined}
      {@const isOpen = open === p.id}
      <div class={cn("overflow-hidden rounded-xl border bg-card shadow-xs transition-shadow", isOpen && "shadow-sm")}>
        <button class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40" onclick={() => (open = isOpen ? null : p.id)}>
          <div class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            {#if info.cli}<Terminal class="size-4" />{:else}<Cloud class="size-4" />{/if}
          </div>
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="flex items-center gap-2 text-sm font-medium">
              {p.name}
              {#if info.label !== p.name}<Badge variant="secondary" class="font-normal">{info.label}</Badge>{/if}
            </span>
            {#if p.model}<span class="truncate font-mono text-xs text-muted-foreground">{p.model}</span>{/if}
          </div>
          {#if info.cli}
            {#if cli?.path}<Badge class="bg-sage-soft text-sage"><Check /> {cli.version?.match(/\d+(\.\d+)+/)?.[0] ?? "Installed"}</Badge>
            {:else if !detecting}<Badge class="bg-amber-soft text-amber">Not installed</Badge>{/if}
          {/if}
          <ChevronRight class={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", isOpen && "rotate-90")} />
        </button>
        {#if isOpen}
          <div class="flex flex-col gap-4 border-t bg-muted/20 px-4 pt-3.5 pb-4" transition:slide={{ duration: 180 }}>
            <p class="text-[13px] leading-snug text-muted-foreground">{info.blurb}</p>
            <div class="grid grid-cols-2 gap-3">
              {#snippet nameBody()}<Input class="bg-background" bind:value={p.name} oninput={() => app.save()} />{/snippet}
              {@render field("Name", false, nameBody)}
              {#snippet modelBody()}
                <div class="flex items-center gap-1">
                  <Input class="bg-background font-mono text-xs md:text-xs" list={`models-${p.id}`} bind:value={p.model} oninput={() => app.save()} placeholder={info.modelHint} />
                  {#if !info.cli || p.kind === "opencode"}
                    <Button variant="ghost" size="icon-sm" title="Fetch available models" onclick={() => fetchModels(p)}><RefreshCw /></Button>
                  {/if}
                </div>
                <datalist id={`models-${p.id}`}>{#each modelLists[p.id] ?? [] as m}<option value={m}></option>{/each}</datalist>
              {/snippet}
              {@render field("Model", false, modelBody)}
              {#if info.cli}
                {#snippet binBody()}<Input class="bg-background font-mono text-xs md:text-xs" bind:value={p.bin_path} oninput={() => app.save()} placeholder={cli?.path ?? "Found on your PATH"} />{/snippet}
                {@render field("Binary path (optional)", true, binBody)}
              {:else}
                {#snippet urlBody()}<Input class="bg-background font-mono text-xs md:text-xs" bind:value={p.base_url} oninput={() => app.save()} placeholder={info.baseUrl} />{/snippet}
                {@render field("Base URL", true, urlBody)}
                {#snippet keyBody()}<Input class="bg-background font-mono text-xs md:text-xs" type="password" bind:value={p.api_key} oninput={() => app.save()} placeholder="Not needed for local servers" />{/snippet}
                {@render field("API key", true, keyBody)}
              {/if}
              {#if info.efforts}
                {#snippet effortBody()}
                  <Choice class="w-full" bind:value={p.effort} onchange={() => app.save()} options={[["", "Default"], ...info.efforts!.map((e) => [e, e] as const)]} />
                {/snippet}
                {@render field("Reasoning effort", false, effortBody)}
              {/if}
            </div>
            <div class="flex items-center gap-3">
              <Button variant="outline" size="sm" onclick={() => test(p)} disabled={testing[p.id]}>
                {#if testing[p.id]}<Spinner />{/if} Test connection
              </Button>
              {#if results[p.id]}
                <span class={cn("selectable flex min-w-0 items-center gap-1.5 text-[13px]", results[p.id].ok ? "text-sage" : "text-destructive")}>
                  {#if results[p.id].ok}<CircleCheck class="size-3.5 shrink-0" />{:else}<CircleX class="size-3.5 shrink-0" />{/if}
                  <span class="break-words [overflow-wrap:anywhere]">{results[p.id].text}</span>
                </span>
              {/if}
              <span class="flex-1"></span>
              <Button variant="ghost" size="sm" class="text-destructive hover:bg-destructive/10 hover:text-destructive" onclick={() => remove(p)}><Trash2 /> Remove</Button>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-9 text-center">
        <div class="grid size-11 place-items-center rounded-full bg-ember-soft text-ember-text"><Sparkles class="size-5" /></div>
        <div>
          <p class="text-sm font-semibold">No AI connected</p>
          <p class="mx-auto mt-1 max-w-md text-[13px] leading-snug text-muted-foreground">
            Hush works without AI, but with it you get polished dictation, voice commands, meeting notes, summaries and chat.
            {#if clis.some((c) => c.path)}We found {clis.filter((c) => c.path).map((c) => LLM_KINDS[c.kind].label).join(", ")} on this Mac.{/if}
          </p>
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          {#each clis.filter((c) => c.path) as c}
            <Button size="sm" onclick={() => addCli(c.kind)}><Plus /> {LLM_KINDS[c.kind].label}</Button>
          {/each}
          <Button variant="outline" size="sm" onclick={() => (adding = true)}>Add API key…</Button>
        </div>
      </div>
    {/each}
  </div>
</Section>

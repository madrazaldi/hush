<script lang="ts">
  import { ask, openUrl } from "#lib/ipc.js";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { bytes } from "#lib/format.js";
  import { STT_KINDS, STT_PRESETS, blankStt } from "#lib/providers.js";
  import type { ModelStatus, SttProfile } from "#lib/types.js";
  import Section from "#lib/components/Section.svelte";
  import Field from "#lib/components/Field.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Progress } from "#lib/components/ui/progress/index.js";
  import { Spinner } from "#lib/components/ui/spinner/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import Choice from "./Choice.svelte";
  import { cn } from "#lib/utils.js";
  import { Check, Download, Trash2, X, Plus, Cloud, Cpu, Globe, Zap, KeyRound, ExternalLink, Target, CircleCheck, CircleX } from "@lucide/svelte";

  const s = $derived(app.settings!);
  const FEATURES = [
    ["Dictation", "dictation"],
    ["Meetings", "meetings"],
    ["Files", "files"],
  ] as const;
  let showAll = $state(false);
  let testing = $state<Record<string, boolean>>({});
  let results = $state<Record<string, { ok: boolean; text: string }>>({});
  let adding = $state(false);

  const local = $derived(s.stt_profiles.find((p) => p.id === "local")!);
  const models = $derived([...app.models].sort((a, b) => a.rank - b.rank));
  const shown = $derived(showAll ? models : models.filter((m) => m.recommended || m.downloaded || m.id === local?.model));
  const cloud = $derived(s.stt_profiles.filter((p) => p.kind !== "local"));
  const extraLocal = $derived(s.stt_profiles.filter((p) => p.kind === "local" && p.id !== "local"));

  const uses = $derived.by(() => {
    const out: Record<string, string[]> = {};
    const add = (id: string, what: string) => (out[id] ??= []).push(what);
    add(s.dictation.stt_profile, "Dictation");
    add(s.meetings.stt_profile, "Meetings");
    add(s.files.stt_profile, "Files");
    return out;
  });

  async function download(m: ModelStatus) {
    m.downloading = 0;
    try {
      await api.downloadModel(m.id);
    } catch (e) {
      const msg = errorText(e);
      if (!/cancel/i.test(msg)) app.toast("error", msg);
    }
    app.refreshModels();
  }

  async function del(m: ModelStatus) {
    if (!(await ask(`Delete ${m.name} (${bytes(m.size_bytes)}) from this Mac?`, { title: "Delete model", kind: "warning" }))) return;
    await api.deleteModel(m.id);
    app.refreshModels();
  }

  function use(m: ModelStatus) {
    local.model = m.id;
    app.save();
  }

  async function test(p: SttProfile) {
    testing[p.id] = true;
    delete results[p.id];
    try {
      results[p.id] = { ok: true, text: await api.testStt($state.snapshot(p) as SttProfile) };
    } catch (e) {
      results[p.id] = { ok: false, text: errorText(e) };
    } finally {
      testing[p.id] = false;
    }
  }

  function addPreset(pr: (typeof STT_PRESETS)[number]) {
    const p = blankStt(pr.kind, pr.name);
    p.base_url = pr.base_url;
    p.model = pr.model;
    s.stt_profiles.push(p);
    adding = false;
    app.save();
  }

  function addLocal() {
    const p = blankStt("local", "On-device (2nd model)");
    p.model = models.find((m) => m.downloaded && m.id !== local.model)?.id ?? local.model;
    s.stt_profiles.push(p);
    adding = false;
    app.save();
  }

  function remove(p: SttProfile) {
    s.stt_profiles = s.stt_profiles.filter((x) => x.id !== p.id);
    app.save();
  }

  // Catalog scores are 0–100; accuracy clusters high, so stretch its range.
  function meter(n: number, kind: "speed" | "accuracy") {
    const dots = kind === "speed" ? Math.round(n / 20) : Math.round((n - 66) / 5);
    return Array.from({ length: 5 }, (_, i) => i < Math.max(1, Math.min(5, dots)));
  }
</script>

<Section title="Use for" description="Pick a speech engine per feature. Dictation favors speed; files and meetings favor accuracy.">
  {#each FEATURES as [label, key]}
    <Field {label}>
      <Choice bind:value={s[key].stt_profile} onchange={() => app.save()} options={s.stt_profiles.map((p) => [p.id, app.sttName(p.id)] as const)} />
    </Field>
  {/each}
</Section>

{#snippet meterDots(Icon: typeof Zap, title: string, dots: boolean[])}
  <span class="inline-flex items-center gap-1" {title}>
    <Icon class="mr-0.5 size-3" />
    {#each dots as on}<i class={cn("size-[5px] rounded-full", on ? "bg-ember" : "bg-foreground/15")}></i>{/each}
  </span>
{/snippet}

<Section title="On-device models" description={`Run privately on your Mac's GPU. Selected: ${app.sttName("local")}`} flush>
  {#snippet actions()}
    <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={() => (showAll = !showAll)}>{showAll ? "Show recommended" : `Show all ${models.length}`}</Button>
  {/snippet}
  <div class="grid grid-cols-2 gap-3">
    {#each shown as m (m.id)}
      {@const inUse = local?.model === m.id}
      <div class={cn("flex flex-col gap-2.5 rounded-xl border bg-card p-4 shadow-xs transition-shadow", inUse && "border-ember/50 ring-3 ring-ember/10")}>
        <div class="flex items-start gap-2">
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <span class="mr-0.5 text-sm font-semibold">{m.name}</span>
            {#if m.id === "parakeet-tdt-0.6b-v3"}<Badge class="bg-ember-soft text-ember-text">Best overall</Badge>{/if}
            {#if m.streaming}<Badge variant="secondary">Streaming</Badge>{/if}
          </div>
          <span class="shrink-0 pt-px text-xs text-muted-foreground tabular-nums">{bytes(m.size_bytes)}</span>
        </div>
        <p class="flex-1 text-[13px] leading-snug text-muted-foreground">{m.description}</p>
        <div class="flex items-center gap-3.5 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-1" title="Languages"><Globe class="size-3" /> {m.languages.length > 1 ? `${m.languages.length} languages` : "English"}</span>
          {@render meterDots(Zap, "Speed", meter(m.speed, "speed"))}
          {@render meterDots(Target, "Accuracy", meter(m.accuracy, "accuracy"))}
          {#if m.translate}<span>Translate</span>{/if}
        </div>
        <div class="mt-1 flex min-h-7 items-center gap-2 border-t pt-3">
          {#if m.downloading != null}
            <Progress value={m.downloading * 100} class="h-1.5 flex-1" />
            <span class="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">{Math.round(m.downloading * 100)}%</span>
            <Button variant="ghost" size="icon-xs" title="Cancel" onclick={() => api.cancelModelDownload(m.id)}><X /></Button>
          {:else if m.downloaded}
            {#if inUse}
              <Badge class="bg-sage-soft text-sage"><Check /> In use</Badge>
            {:else}
              <Button variant="outline" size="xs" onclick={() => use(m)}>Use this model</Button>
            {/if}
            <span class="flex-1"></span>
            <Button variant="ghost" size="icon-xs" class="text-muted-foreground hover:text-destructive" title="Delete" onclick={() => del(m)}><Trash2 /></Button>
          {:else}
            <Button variant="outline" size="xs" onclick={() => download(m)}><Download /> Download</Button>
            <span class="flex-1"></span>
            <span class="text-xs text-muted-foreground">{m.license}</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</Section>

<Section title="Providers" description="Cloud transcription with your own API keys. Audio is sent to the provider you choose." flush>
  {#snippet actions()}
    <DropdownMenu.Root bind:open={adding}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}<Button {...props} variant="outline" size="sm"><Plus /> Add provider</Button>{/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-60">
        <DropdownMenu.Label class="text-xs text-muted-foreground">Cloud</DropdownMenu.Label>
        {#each STT_PRESETS as pr}
          <DropdownMenu.Item onSelect={() => addPreset(pr)}><Cloud /> {pr.name}</DropdownMenu.Item>
        {/each}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={addLocal}><Cpu /> Another on-device model</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}

  <div class="flex flex-col gap-3">
    {#each [...extraLocal, ...cloud] as p (p.id)}
      <div class="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs">
        <div class="flex items-center gap-2">
          <div class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            {#if p.kind === "local"}<Cpu class="size-4" />{:else}<Cloud class="size-4" />{/if}
          </div>
          <Input class="h-8 w-56 border-transparent bg-transparent px-1.5 font-semibold shadow-none hover:border-input focus-visible:border-ring dark:bg-transparent" bind:value={p.name} oninput={() => app.save()} />
          <Badge variant="secondary">{STT_KINDS[p.kind].label}</Badge>
          {#each uses[p.id] ?? [] as u}<Badge class="bg-ember-soft text-ember-text">{u}</Badge>{/each}
          <span class="flex-1"></span>
          <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive" title="Remove" onclick={() => remove(p)}><Trash2 /></Button>
        </div>
        {#if p.kind === "local"}
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs text-muted-foreground">Model</Label>
            <Choice class="w-full" bind:value={p.model} onchange={() => app.save()} options={models.filter((m) => m.downloaded).map((m) => [m.id, m.name] as const)} />
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label class="text-xs text-muted-foreground">API key</Label>
              <div class="flex items-center gap-1">
                <Input class="bg-background font-mono text-xs md:text-xs" type="password" placeholder="Paste key" bind:value={p.api_key} oninput={() => app.save()} />
                {#if STT_KINDS[p.kind].keyUrl}
                  <Button variant="ghost" size="icon-sm" title="Get a key" onclick={() => openUrl(STT_KINDS[p.kind].keyUrl!)}><KeyRound /></Button>
                {/if}
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <Label class="text-xs text-muted-foreground">Model</Label>
              <Input class="bg-background font-mono text-xs md:text-xs" bind:value={p.model} oninput={() => app.save()} placeholder={STT_KINDS[p.kind].model} />
            </div>
            <div class="col-span-2 flex flex-col gap-1.5">
              <Label class="text-xs text-muted-foreground">Base URL</Label>
              <Input class="bg-background font-mono text-xs md:text-xs" bind:value={p.base_url} oninput={() => app.save()} placeholder={STT_KINDS[p.kind].baseUrl} />
            </div>
          </div>
        {/if}
        <div class="flex items-center gap-3">
          <Button variant="outline" size="sm" onclick={() => test(p)} disabled={testing[p.id]}>
            {#if testing[p.id]}<Spinner />{/if} Test
          </Button>
          {#if results[p.id]}
            <span class={cn("selectable flex min-w-0 items-center gap-1.5 text-[13px]", results[p.id].ok ? "text-sage" : "text-destructive")}>
              {#if results[p.id].ok}<CircleCheck class="size-3.5 shrink-0" />{:else}<CircleX class="size-3.5 shrink-0" />{/if}
              <span class="break-words">{results[p.id].text}</span>
            </span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center">
        <div class="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><Cloud class="size-5" /></div>
        <p class="text-sm font-medium">No cloud providers</p>
        <p class="max-w-md text-[13px] text-muted-foreground">
          Add OpenAI, Groq, xAI, Muse, Deepgram, ElevenLabs or AssemblyAI for speaker labels and long files.
        </p>
        <Button variant="link" size="sm" class="h-auto text-ember-text" onclick={() => openUrl("https://platform.openai.com/docs/guides/speech-to-text")}>
          Learn more <ExternalLink />
        </Button>
      </div>
    {/each}
  </div>
</Section>

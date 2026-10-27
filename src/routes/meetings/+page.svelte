<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, errorText } from "#lib/api.js";
  import { app } from "#lib/state.svelte.js";
  import { dayGroup, duration, groupBy } from "#lib/format.js";
  import type { RecordingSummary } from "#lib/types.js";
  import Page from "#lib/components/Page.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as InputGroup from "#lib/components/ui/input-group/index.js";
  import * as Item from "#lib/components/ui/item/index.js";
  import * as Empty from "#lib/components/ui/empty/index.js";
  import { Mic, NotebookPen, Search, Star, Radar, Users, ArrowRight } from "@lucide/svelte";

  let items = $state<RecordingSummary[]>([]);
  let query = $state("");
  let starting = $state(false);

  $effect(() => {
    app.recordingsVersion;
    const q = query;
    const t = setTimeout(() => api.recordings("meeting", q).then((r) => (items = r)), q ? 180 : 0);
    return () => clearTimeout(t);
  });

  const groups = $derived(groupBy(items, (r) => dayGroup(r.created_at)));
  const s = $derived(app.settings!);

  async function record() {
    starting = true;
    try {
      const rec = await api.meetingStart();
      await app.refreshMeeting();
      goto(`/meetings/${rec.id}`);
    } catch (e) {
      app.toast("error", errorText(e));
    } finally {
      starting = false;
    }
  }

  async function note() {
    const rec = await api.meetingCreate();
    goto(`/meetings/${rec.id}`);
  }
</script>

<Page>
  <PageHeader title="Meetings" description="Jot what matters; Hush listens to both sides and turns it into clean notes. No bot joins your call.">
    {#snippet actions()}
      <Button variant="outline" onclick={note}><NotebookPen /> New note</Button>
      {#if app.meeting}
        <Button onclick={() => goto(`/meetings/${app.meeting!.id}`)}>
          <span class="size-1.5 animate-pulse-ring rounded-full bg-primary-foreground"></span> Recording…
        </Button>
      {:else}
        <Button onclick={record} disabled={starting}><Mic /> Record now</Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if !s.meetings.detect_meetings}
    <button
      class="group mb-8 flex w-full items-center gap-3 rounded-xl border border-dashed bg-muted/30 py-3 pr-3 pl-3.5 text-left text-sm text-muted-foreground transition-colors hover:border-ember/40 hover:bg-ember-soft/50"
      onclick={() => {
        s.meetings.detect_meetings = true;
        app.save();
      }}
    >
      <div class="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-ember-text shadow-xs ring-1 ring-border"><Radar class="size-4" /></div>
      <span class="flex-1">Turn on meeting detection to get a nudge when Zoom, Meet, Teams or FaceTime starts using your mic.</span>
      <span class="flex items-center gap-1 text-xs font-semibold text-ember-text">Enable <ArrowRight class="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
    </button>
  {/if}

  <InputGroup.Root class="mb-2 h-9">
    <InputGroup.Addon><Search /></InputGroup.Addon>
    <InputGroup.Input placeholder="Search meetings, notes and transcripts" bind:value={query} />
  </InputGroup.Root>

  {#each groups as [day, list]}
    <h4 class="mt-7 mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{day}</h4>
    <Item.Group class="gap-0 overflow-hidden rounded-xl border bg-card">
      {#each list as r, i (r.id)}
        <Item.Root class="gap-4 rounded-none border-0 px-4 py-3 {i ? 'border-t border-border' : ''} hover:bg-muted/50">
          {#snippet child({ props })}
            <a href={`/meetings/${r.id}`} {...props}>
              <span class="w-16 shrink-0 font-mono text-[11.5px] text-muted-foreground tabular-nums">
                {new Date(r.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              <Item.Content class="min-w-0 gap-0.5">
                <Item.Title class="w-full">
                  <span class="truncate">{r.title}</span>
                  {#if r.starred}<Star class="size-3 shrink-0 text-amber" fill="currentColor" />{/if}
                  {#if r.status === "recording"}
                    <Badge class="bg-ember-soft text-ember-text"><span class="size-1.5 animate-pulse-ring rounded-full bg-ember"></span> Live</Badge>
                  {/if}
                  {#if r.status === "processing"}<Badge variant="secondary">Finishing…</Badge>{/if}
                </Item.Title>
                <span class="truncate text-xs text-muted-foreground">{r.preview || (r.status === "recording" ? "Listening…" : "No transcript")}</span>
              </Item.Content>
              {#if r.duration_ms}<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{duration(r.duration_ms)}</span>{/if}
            </a>
          {/snippet}
        </Item.Root>
      {/each}
    </Item.Group>
  {:else}
    <Empty.Root class="mt-6 rounded-xl border border-dashed py-14">
      <Empty.Header>
        <Empty.Media variant="icon">{#if query}<Search />{:else}<Users />{/if}</Empty.Media>
        <Empty.Title>{query ? "No matches" : "No meetings yet"}</Empty.Title>
        <Empty.Description>{query ? "Try a different search." : "Hit Record when your next call starts, and type notes as you go."}</Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {/each}
</Page>

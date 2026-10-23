<script lang="ts">
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fetchTestFlightBridgeDiagnostics, type TestFlightBridgeDiagnostics } from '#lib/api';

  let open = $state(false);
  let loading = $state(false);
  let diagnostics = $state<TestFlightBridgeDiagnostics | null>(null);
  let error = $state('');

  async function inspect(): Promise<void> {
    open = true;
    loading = true;
    error = '';
    try {
      diagnostics = await fetchTestFlightBridgeDiagnostics();
    } catch (cause) {
      diagnostics = null;
      error = cause instanceof Error ? cause.message : 'Could not load bridge diagnostics.';
    } finally {
      loading = false;
    }
  }
</script>

<Button size="sm" variant="secondary" loading={loading} onclick={() => void inspect()}>Inspect Autoinstall bridge</Button>

<Dialog bind:open class="max-w-lg">
  <div class="mb-1 text-sm font-medium">Autoinstall bridge diagnostics</div>
  <div class="mb-3 text-xs text-muted">Current bridge capabilities and recent protocol activity.</div>
  {#if loading}
    <div class="text-sm text-muted">Checking the bridge…</div>
  {:else if error}
    <div class="text-sm text-err" role="alert">{error}</div>
  {:else if diagnostics}
    <div class="grid grid-cols-2 gap-2 text-xs">
      <div class="rounded-md border border-border p-2">Version <span class="text-muted">{diagnostics.bridge.bridgeVersion ?? 'unknown'}</span></div>
      <div class="rounded-md border border-border p-2">Catalog <span class={diagnostics.bridge.hasCatalogManager ? 'text-ok' : 'text-err'}>{diagnostics.bridge.hasCatalogManager ? 'ready' : 'missing'}</span></div>
      <div class="rounded-md border border-border p-2">Installer <span class={diagnostics.bridge.hasInstaller ? 'text-ok' : 'text-err'}>{diagnostics.bridge.hasInstaller ? 'ready' : 'missing'}</span></div>
      <div class="rounded-md border border-border p-2">Install <span class="text-muted">{String(diagnostics.install?.state ?? 'idle')}</span></div>
    </div>
    <div class="mt-3 flex flex-wrap gap-1.5">
      {#each diagnostics.bridge.capabilities ?? [] as capability (capability)}<Badge variant="secondary">{capability}</Badge>{/each}
      {#if !diagnostics.bridge.capabilities?.length}<span class="text-xs text-muted">No capabilities reported.</span>{/if}
    </div>
    {#if diagnostics.recentLog?.length}<pre class="mt-3 max-h-64 overflow-auto rounded-md bg-panel-muted p-2 text-[10px] whitespace-pre-wrap">{diagnostics.recentLog.join('\n')}</pre>{/if}
  {:else}
    <div class="text-sm text-muted">No diagnostics available.</div>
  {/if}
</Dialog>

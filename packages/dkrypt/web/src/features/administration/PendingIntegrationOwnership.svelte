<script lang="ts">
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { acceptIntegrationOwnership, fetchPendingIntegrationOwnership, type IntegrationOwnershipRequest } from '#lib/api';
  import { showToast } from '#lib/ui.svelte';

  let requests = $state<IntegrationOwnershipRequest[]>([]);
  let loading = $state(false);
  let acceptingId = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    try {
      requests = (await fetchPendingIntegrationOwnership()).requests;
    } catch {
      requests = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  async function accept(request: IntegrationOwnershipRequest): Promise<void> {
    acceptingId = request.id;
    try {
      await acceptIntegrationOwnership(request.id);
      showToast('Automation ownership accepted', 'success');
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not accept ownership', 'error');
    } finally {
      acceptingId = null;
    }
  }
</script>

{#if requests.length > 0}
  <Card title="Pending automation ownership">
    <p class="mb-2 text-xs text-muted">Accepting assigns future decrypt usage to your plan and daily allowance.</p>
    <div class="divide-y divide-border/70">
      {#each requests as request (request.id)}
        <div class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
          <div class="min-w-0"><div class="font-medium">{request.label}</div><div class="text-muted">Requested by {request.billingOwnerTransferRequestorDisplayName ?? request.billingOwnerTransfer.requestedBy}</div></div>
          <Button size="sm" loading={acceptingId === request.id} disabled={loading} onclick={() => void accept(request)}>Accept</Button>
        </div>
      {/each}
    </div>
  </Card>
{/if}

<script lang="ts">
  import { TriangleAlert } from 'lucide-svelte';
  import { liveState } from '#lib/live.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { setActiveTab, setSettingsSubtab } from '#lib/ui.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';

  const issues = $derived((liveState.overview?.watches ?? []).flatMap((w) => w.configIssues));

  function goToScheduler(): void {
    setActiveTab('settings');
    setSettingsSubtab('scheduler');
  }
</script>

{#if sessionHasPermission(PermissionFlag.manageAutomation) && issues.length > 0}
  <Alert variant="warning" class="mb-4 flex items-start gap-2.5 py-3 text-[13px]">
    <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
    <div class="min-w-0 flex-1">
      {#each issues as issue (issue)}
        <div>{issue}</div>
      {/each}
      <Button variant="link" size="sm" class="mt-1.5 h-auto p-0 text-warn" onclick={goToScheduler}>Go to Automation settings</Button>
    </div>
  </Alert>
{/if}

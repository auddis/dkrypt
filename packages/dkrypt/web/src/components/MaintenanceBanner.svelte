<script lang="ts">
  import { Wrench } from 'lucide-svelte';
  import { liveState } from '#lib/live.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { setActiveTab, setSettingsSubtab } from '#lib/ui.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';

  const maintenance = $derived(liveState.overview?.maintenance);
  const canManage = $derived(sessionHasPermission(PermissionFlag.manageAutomation));

  function goToDevices(): void {
    setActiveTab('settings');
    setSettingsSubtab('devices');
  }
</script>

{#if maintenance?.active}
  <Alert variant="warning" class="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-none border-x-0 border-t-0 px-4 py-2.5 text-center text-[13px] font-semibold">
    <span class="inline-flex items-center gap-1.5">
      <Wrench class="h-4 w-4 shrink-0" />
      Maintenance mode is active — all decrypts and the API are paused.
    </span>
    {#if maintenance.reason}
      <span class="font-normal opacity-90">{maintenance.reason}{maintenance.auto && !maintenance.manual ? ' · engaged automatically' : ''}</span>
    {/if}
    {#if canManage}
      <Button variant="link" size="sm" class="h-auto p-0 font-semibold text-warn hover:text-warn/80" onclick={goToDevices}>Manage</Button>
    {/if}
  </Alert>
{/if}

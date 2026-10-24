<script lang="ts">
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Label from '#lib/components/ui/Label.svelte';
  import { authenticateOfflineAppStoreAccount, fetchDevices, fetchOfflineAppStoreStatus, reauthenticate, retrieveOfflineAppStoreCredential, saveOfflineAppStoreAccount, type DeviceRecord, type OfflineAppStoreStatus } from '#lib/api';
  import { retryAfterReauthentication } from '#lib/reauthenticatedRequest.js';
  import { withRequestTimeout } from '#lib/apiRequestTimeout.js';
  import { sessionState } from '#lib/session.svelte';
  import { promptDialog } from '#lib/ui.svelte';

  let status = $state<OfflineAppStoreStatus | null>(null);
  let appleId = $state('');
  let password = $state('');
  let verificationCode = $state('');
  let devices = $state<DeviceRecord[]>([]);
  let selectedDeviceId = $state('');
  let verificationRequested = $state(false);
  let loading = $state(false);
  let savingAccount = $state(false);
  let authenticating = $state(false);
  let retrievingCredential = $state(false);
  let error = $state('');
  let notice = $state('');
  let statusRefresh: Promise<void> | undefined;

  const STATUS_REQUEST_TIMEOUT_MS = 10_000;
  const STATUS_TIMEOUT_MESSAGE = 'Checking App Store processing status timed out. Refresh status to try again.';
  const DEVICE_LIST_TIMEOUT_MESSAGE = 'Loading the device list timed out. Refresh status to try again.';

  function refreshStatus(): Promise<void> {
    if (statusRefresh) return statusRefresh;
    statusRefresh = (async () => {
      try {
        status = await withRequestTimeout(
          (signal) => fetchOfflineAppStoreStatus({ signal }),
          STATUS_REQUEST_TIMEOUT_MS,
          STATUS_TIMEOUT_MESSAGE,
        );
        if (error.startsWith('Could not refresh App Store processing status:')) error = '';
      } catch (cause) {
        error = `Could not refresh App Store processing status: ${cause instanceof Error ? cause.message : 'request failed'}`;
      } finally {
        statusRefresh = undefined;
      }
    })();
    return statusRefresh;
  }

  async function confirmRecentAuthentication(): Promise<void> {
    const isRootAdministrator = sessionState.sub === 'root';
    if (!isRootAdministrator && !sessionState.mfa?.enabled) {
      throw new Error('Sign out and sign in again to confirm this action.');
    }
    const proof = await promptDialog(
      isRootAdministrator ? 'Enter the administrator password to continue.' : 'Enter your authenticator or recovery code to continue.',
      { type: 'password', confirmLabel: 'Continue' },
    );
    if (!proof) throw new Error('Reauthentication was canceled.');
    const result = await reauthenticate(isRootAdministrator ? { password: proof } : { mfaToken: proof });
    if (!result.ok) throw new Error(result.error ?? 'Reauthentication failed.');
  }

  async function refresh(): Promise<void> {
    loading = true;
    if (!error.startsWith('Could not refresh App Store processing status:')) error = '';
    try {
      const [, deviceResponse] = await Promise.all([
        refreshStatus(),
        withRequestTimeout((signal) => fetchDevices({ signal }), STATUS_REQUEST_TIMEOUT_MS, DEVICE_LIST_TIMEOUT_MESSAGE),
      ]);
      devices = deviceResponse.devices;
      const availableIpads = devices.filter((device) => device.enabled && !device.draining && device.transport === 'usb' && device.productType?.startsWith('iPad'));
      if (!availableIpads.some((device) => device.id === selectedDeviceId)) selectedDeviceId = availableIpads[0]?.id ?? '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load available iPads.';
    } finally {
      loading = false;
    }
  }

  async function saveAccount(): Promise<void> {
    savingAccount = true;
    error = '';
    notice = '';
    try {
      status = await retryAfterReauthentication(
        () => saveOfflineAppStoreAccount(appleId, password),
        confirmRecentAuthentication,
      );
      password = '';
      verificationCode = '';
      verificationRequested = false;
      notice = 'Apple Account details were encrypted and saved.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save Apple Account details.';
      if (error.includes('sign out and sign in again')) password = '';
      if (error.includes('timed out')) {
        password = '';
      }
    } finally {
      savingAccount = false;
    }
  }

  async function authenticate(): Promise<void> {
    authenticating = true;
    error = '';
    notice = '';
    try {
      status = await retryAfterReauthentication(
        () => authenticateOfflineAppStoreAccount(verificationCode || undefined),
        confirmRecentAuthentication,
      );
      verificationCode = '';
      verificationRequested = false;
      notice = 'Apple Account sign-in was verified.';
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Apple Account authentication failed.';
      if (message.toLowerCase().includes('verification code')) verificationRequested = true;
      error = message;
    } finally {
      authenticating = false;
    }
  }

  async function retrieveCredential(): Promise<void> {
    retrievingCredential = true;
    error = '';
    notice = '';
    try {
      status = await retryAfterReauthentication(
        () => retrieveOfflineAppStoreCredential(selectedDeviceId),
        confirmRecentAuthentication,
      );
      notice = 'Credential retrieval started. The selected iPad is temporarily reserved while Apple’s FairPlay service restarts.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not retrieve the FairPlay credential.';
      if (error.includes('timed out')) await refreshStatus();
    } finally {
      retrievingCredential = false;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      if (status?.credentialRetrieval.state === 'running') void refreshStatus();
    }, 3000);
    return () => clearInterval(timer);
  });
</script>

<Card class="mt-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold">Server-side App Store processing</h3>
        <Badge variant={status?.ready ? 'success' : 'warning'}>{status?.ready ? 'Ready' : 'Not ready'}</Badge>
      </div>
      <p class="mt-1 max-w-3xl text-xs text-muted">App Store jobs can try a server-side download and decrypt first; failures return to the existing device queue. TestFlight remains device-based. This feature is disabled unless an operator explicitly configures it.</p>
    </div>
    <Button size="sm" variant="secondary" loading={loading} onclick={() => void refresh()}>Refresh</Button>
  </div>

  {#if error}<div class="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-err" role="alert">{error}</div>{/if}
  {#if notice}<div class="mt-3 rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-ok" role="status">{notice}</div>{/if}

  {#if status}
    <div class="mt-4 grid gap-2 sm:grid-cols-2">
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3 text-xs"><div class="text-muted">Credential encryption</div><div class="mt-1 font-medium">{status.vault.encryptionReady ? 'External key configured' : 'External key missing'}</div></div>
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3 text-xs"><div class="text-muted">Apple Account</div><div class="mt-1 font-medium">{status.vault.accountHint ?? 'Not configured'}</div></div>
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3 text-xs"><div class="text-muted">Account session</div><div class="mt-1 font-medium">{status.vault.authenticatedAt ? `Verified ${new Date(status.vault.authenticatedAt).toLocaleString()}` : status.vault.authenticationError ?? 'Not verified'}</div></div>
      <div class="rounded-lg border border-border/70 bg-muted/20 p-3 text-xs"><div class="text-muted">FairPlay credential</div><div class="mt-1 font-medium">{status.vault.credentialConfigured ? 'Stored for this account' : 'Not configured'}</div></div>
    </div>
    {#if status.credentialRetrieval.state !== 'idle'}
      <div class="mt-3 rounded-lg border border-border/70 bg-muted/20 p-3 text-sm" role={['failed', 'interrupted'].includes(status.credentialRetrieval.state) ? 'alert' : 'status'}>
        <div class="font-medium">{status.credentialRetrieval.state === 'running' ? 'Retrieving from iPad' : status.credentialRetrieval.state === 'succeeded' ? 'Credential stored securely' : status.credentialRetrieval.state === 'interrupted' ? 'Credential retrieval interrupted' : 'Credential retrieval failed'}</div>
        {#if status.credentialRetrieval.state === 'running' && status.credentialRetrieval.startedAt}<p class="mt-1 text-xs text-muted">Started {new Date(status.credentialRetrieval.startedAt).toLocaleTimeString()}. This can take a few minutes.</p>{/if}
        {#if status.credentialRetrieval.error}<p class="mt-1 text-xs text-muted">{status.credentialRetrieval.error}</p>{/if}
      </div>
    {/if}
    {#if status.blockers.length > 0}
      <ul class="mt-3 list-disc space-y-1 pl-5 text-xs text-muted" aria-label="Setup requirements">
        {#each status.blockers as blocker (blocker)}<li>{blocker}</li>{/each}
      </ul>
    {/if}
  {/if}

  <div class="mt-5 grid gap-5 border-t border-border/70 pt-4 lg:grid-cols-2">
    <form class="space-y-3" onsubmit={(event) => { event.preventDefault(); void saveAccount(); }}>
      <div><h4 class="text-sm font-medium">Apple Account</h4><p class="mt-1 text-xs text-muted">Use the account signed into the paired iPad’s App Store. The password is encrypted using the external vault key and is never placed in a command or environment variable.</p></div>
      <div class="space-y-1.5"><Label for="offline-apple-id">Apple Account email</Label><Input id="offline-apple-id" type="email" autocomplete="username" bind:value={appleId} required maxlength={320} /></div>
      <div class="space-y-1.5"><Label for="offline-apple-password">Password</Label><Input id="offline-apple-password" type="password" autocomplete="new-password" bind:value={password} required maxlength={1024} /></div>
      <Button type="submit" size="sm" loading={savingAccount} disabled={!appleId || !password}>Save account</Button>
      {#if status?.vault.accountConfigured}
        <div class="space-y-2 rounded-lg border border-border/70 p-3">
          <p class="text-xs text-muted">Re-authentication may ask for a code sent to the trusted iPad. Approval is not automatic; dkrypt cannot reliably match Apple’s prompt to a specific request.</p>
          {#if verificationRequested}<div class="space-y-1.5"><Label for="offline-apple-code">Six-digit verification code</Label><Input id="offline-apple-code" inputmode="numeric" autocomplete="one-time-code" bind:value={verificationCode} pattern="[0-9]{6}" maxlength={6} /></div>{/if}
          <Button size="sm" variant="secondary" loading={authenticating} disabled={verificationRequested && verificationCode.length !== 6} onclick={() => void authenticate()}>{verificationRequested ? 'Verify code' : 'Verify Apple Account'}</Button>
        </div>
      {/if}
    </form>

    <section class="space-y-3">
      <div><h4 class="text-sm font-medium">Device-derived FairPlay credential</h4><p class="mt-1 text-xs text-muted">dkrypt retrieves the 16-byte credential from an App Store app installed under this Apple Account, then stores it directly in the encrypted vault. The value is never sent to the browser or returned by the API.</p></div>
      <div class="space-y-1.5"><Label for="offline-credential-device">Connected iPad</Label><select id="offline-credential-device" class="min-h-9 w-full rounded-md border border-border bg-background px-2 text-sm" bind:value={selectedDeviceId} disabled={retrievingCredential || status?.credentialRetrieval.state === 'running'}><option value="">Select an enabled USB iPad</option>{#each devices.filter((device) => device.enabled && !device.draining && device.transport === 'usb' && device.productType?.startsWith('iPad')) as device (device.id)}<option value={device.id}>{device.name} · {device.productType}</option>{/each}</select></div>
      <Button size="sm" loading={retrievingCredential} disabled={!status?.vault.accountConfigured || !status.vault.authenticatedAt || !selectedDeviceId || status.vault.credentialConfigured || status.credentialRetrieval.state === 'running'} onclick={() => void retrieveCredential()}>{status?.credentialRetrieval.state === 'running' ? 'Retrieval in progress' : 'Retrieve and store credential'}</Button>
      <p class="text-xs text-muted">This briefly restarts Apple’s FairPlay service. dkrypt drains the selected iPad so no decrypt job starts at the same time. The iPad must have an App Store app from the same Apple Account installed.</p>
    </section>
  </div>
</Card>

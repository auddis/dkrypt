<script lang="ts">
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Label from '#lib/components/ui/Label.svelte';
  import Textarea from '#lib/components/ui/Textarea.svelte';
  import { authenticateOfflineAppStoreAccount, fetchOfflineAppStoreStatus, saveOfflineAppStoreAccount, saveOfflineAppStoreCredential, type OfflineAppStoreStatus } from '#lib/api';

  let status = $state<OfflineAppStoreStatus | null>(null);
  let appleId = $state('');
  let password = $state('');
  let verificationCode = $state('');
  let fairPlayCredential = $state('');
  let verificationRequested = $state(false);
  let loading = $state(false);
  let savingAccount = $state(false);
  let authenticating = $state(false);
  let savingCredential = $state(false);
  let error = $state('');
  let notice = $state('');

  async function refresh(): Promise<void> {
    loading = true;
    error = '';
    try {
      status = await fetchOfflineAppStoreStatus();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load App Store processing status.';
    } finally {
      loading = false;
    }
  }

  async function saveAccount(): Promise<void> {
    savingAccount = true;
    error = '';
    notice = '';
    try {
      status = await saveOfflineAppStoreAccount(appleId, password);
      password = '';
      verificationCode = '';
      verificationRequested = false;
      notice = 'Apple Account details were encrypted and saved.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save Apple Account details.';
    } finally {
      savingAccount = false;
    }
  }

  async function authenticate(): Promise<void> {
    authenticating = true;
    error = '';
    notice = '';
    try {
      status = await authenticateOfflineAppStoreAccount(verificationCode || undefined);
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

  async function saveCredential(): Promise<void> {
    savingCredential = true;
    error = '';
    notice = '';
    try {
      status = await saveOfflineAppStoreCredential(fairPlayCredential);
      fairPlayCredential = '';
      notice = 'The device-derived credential was encrypted and saved.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save the FairPlay credential.';
    } finally {
      savingCredential = false;
    }
  }

  onMount(() => {
    void refresh();
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
      <Button size="sm" loading={savingAccount} disabled={!appleId || !password}>Save account</Button>
      {#if status?.vault.accountConfigured}
        <div class="space-y-2 rounded-lg border border-border/70 p-3">
          <p class="text-xs text-muted">Re-authentication may ask for a code sent to the trusted iPad. Approval is not automatic; dkrypt cannot reliably match Apple’s prompt to a specific request.</p>
          {#if verificationRequested}<div class="space-y-1.5"><Label for="offline-apple-code">Six-digit verification code</Label><Input id="offline-apple-code" inputmode="numeric" autocomplete="one-time-code" bind:value={verificationCode} pattern="[0-9]{6}" maxlength={6} /></div>{/if}
          <Button size="sm" variant="secondary" loading={authenticating} disabled={verificationRequested && verificationCode.length !== 6} onclick={() => void authenticate()}>{verificationRequested ? 'Verify code' : 'Verify Apple Account'}</Button>
        </div>
      {/if}
    </form>

    <form class="space-y-3" onsubmit={(event) => { event.preventDefault(); void saveCredential(); }}>
      <div><h4 class="text-sm font-medium">Device-derived FairPlay credential</h4><p class="mt-1 text-xs text-muted">Use only a credential retrieved from an installed App Store app signed into this same account on the paired jailbroken device. It is encrypted before storage and never shown again.</p></div>
      <div class="space-y-1.5"><Label for="offline-fairplay-credential">16-byte credential</Label><Textarea id="offline-fairplay-credential" bind:value={fairPlayCredential} autocomplete="off" spellcheck="false" rows={3} required maxlength={128} /></div>
      <Button size="sm" loading={savingCredential} disabled={!status?.vault.accountConfigured || !fairPlayCredential}>Save credential</Button>
      <p class="text-xs text-muted">The FairPlay decryptor is not bundled. Written permission and license clearance are required before enabling production use; configure an approved external binary and the authorization flag only after that gate is cleared.</p>
    </form>
  </div>
</Card>

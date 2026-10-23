import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '#config.js';
import { scopedLogger } from '#logger.js';
import { getAppleAccountVaultStatus, saveAppleAccountFairPlayCredential } from '#appleAccountVault.js';
import { getActiveJobs } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { getDevice, updateDevice } from '#store/state.js';
import type { DeviceRecord } from '#store/state.js';
import { createOfflineCredentialRetrievalRepository } from '#store/offlineCredentialRetrievalRepository.js';
import type { OfflineCredentialRetrievalRepository } from '#store/offlineCredentialRetrievalRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { withIpadecrypt } from '#idevice.js';
import type { DeviceConnection } from '#idevice.js';
import { terminateChildProcess } from '#jobs/process.js';

const log = scopedLogger('appstore-offline-credential');
const MAX_HELPER_DIAGNOSTIC_LENGTH = 4_096;

export interface CredentialRetrievalStatus {
  state: 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  operationId?: string;
  deviceId?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface FairPlayCredentialRetrieverDependencies {
  getDevice: typeof getDevice;
  getActiveJobs: typeof getActiveJobs;
  getVaultStatus: typeof getAppleAccountVaultStatus;
  updateDevice: typeof updateDevice;
  saveCredential: typeof saveAppleAccountFairPlayCredential;
  runRetriever(device: DeviceRecord): Promise<Buffer>;
  operationRepository: OfflineCredentialRetrievalRepository;
}

function isUsbIpad(device: DeviceRecord): boolean {
  const transport = device.transport ?? (device.udid ? device.usbmuxNetwork ? 'wifi' : 'usb' : 'wifi');
  return device.enabled
    && !device.draining
    && transport === 'usb'
    && !device.host
    && device.usbmuxNetwork !== true
    && Boolean(device.udid)
    && /^iPad\d+,\d+$/.test(device.productType ?? '');
}

function isRunningOnDevice(jobs: Job[], deviceId: string): boolean {
  return jobs.some((job) => job.status === 'running' && job.deviceId === deviceId);
}

function deviceConnection(device: DeviceRecord): DeviceConnection {
  return {
    id: device.id,
    transport: 'usb',
    udid: device.udid,
    user: device.user,
    port: device.port,
    keyPath: device.keyPath,
    usbmuxNetwork: false,
  };
}

function sshWrapper(): string {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'args=("$@")',
    'last=$((${#args[@]} - 1))',
    'if (( last < 0 )); then exit 2; fi',
    'remote="${args[$last]}"',
    'for index in "${!args[@]}"; do if [[ "${args[$index]}" == "root@127.0.0.1" ]]; then args[$index]="mobile@127.0.0.1"; fi; done',
    'printf -v quoted_remote "%q" "$remote"',
    'args[$last]="sudo -n env PATH=/var/jb/usr/bin:/var/jb/bin:/usr/bin:/bin:/sbin sh -c $quoted_remote"',
    'exec /usr/bin/ssh -i "$DKRYPT_DEVICE_SSH_KEY" -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no "${args[@]}"',
    '',
  ].join('\n');
}

function safeCredentialRetrievalDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\/(?:private\/)?var\/containers\/Bundle\/Application\/[^\s:]+/g, '[app path]')
    .replace(/\/(?:dev\/shm|tmp)\/[^\s:]+/g, '[temporary path]')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[device id]')
    .replace(/\b[0-9a-f]{40}\b/gi, '[device id]')
    .replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, '[redacted value]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HELPER_DIAGNOSTIC_LENGTH);
  return safeMessage || 'The credential helper failed without a diagnostic message.';
}

async function runCredentialHelper(device: DeviceRecord): Promise<Buffer> {
  const temporaryRoot = await mkdtemp(path.join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'dkrypt-fairplay-credential-'));
  try {
    return await withIpadecrypt(deviceConnection(device), async (runtimeDirectory) => {
      const runtime = JSON.parse(await readFile(path.join(runtimeDirectory, 'config.json'), 'utf8')) as {
        device?: { host?: unknown; port?: unknown; auth?: { keyPath?: unknown } };
      };
      const host = runtime.device?.host;
      const port = runtime.device?.port;
      const keyPath = runtime.device?.auth?.keyPath;
      if (host !== '127.0.0.1' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || typeof keyPath !== 'string' || !path.isAbsolute(keyPath)) {
        throw new Error('The managed device tunnel configuration is invalid');
      }
      const binDirectory = path.join(temporaryRoot, 'bin');
      const outputDirectory = path.join(temporaryRoot, 'result');
      await mkdir(binDirectory, { mode: 0o700 });
      await writeFile(path.join(binDirectory, 'ssh'), sshWrapper(), { mode: 0o700 });
      await chmod(path.join(binDirectory, 'ssh'), 0o700);
      const environment = {
        PATH: `${binDirectory}:/usr/local/bin:/usr/bin:/bin`,
        HOME: temporaryRoot,
        LANG: 'C.UTF-8',
        DKRYPT_DEVICE_SSH_KEY: keyPath,
      };
      const child = spawn(config.appStoreOfflinePythonBin, [
        config.appStoreOfflineCredentialRetriever,
        '--output-dir',
        outputDirectory,
        '--device-udid',
        device.udid!,
        '--ssh-port',
        String(port),
      ], {
        cwd: path.dirname(config.appStoreOfflineCredentialRetriever),
        env: environment,
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        stderr = (stderr + text).slice(-MAX_HELPER_DIAGNOSTIC_LENGTH);
      });
      let timedOut = false;
      let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateChildProcess(child, 'SIGTERM');
        hardKillTimer = setTimeout(() => terminateChildProcess(child, 'SIGKILL'), 15_000);
        hardKillTimer.unref();
      }, config.appStoreOfflineCredentialTimeoutSeconds * 1000);
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => {
            if (code === 0 && !timedOut) resolve();
            else {
              const exit = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
              const diagnostic = stderr.trim();
              reject(new Error(timedOut
                ? 'FairPlay credential retrieval timed out'
                : `FairPlay credential helper exited with ${exit}${diagnostic ? `: ${diagnostic}` : ''}`));
            }
          });
        });
        const credentialPath = path.join(outputDirectory, 'credential.bin');
        const credentialStat = await lstat(credentialPath);
        if (!credentialStat.isFile() || credentialStat.size !== 16) throw new Error('FairPlay credential retrieval returned an invalid credential');
        const credential = await readFile(credentialPath);
        if (credential.length !== 16) {
          credential.fill(0);
          throw new Error('FairPlay credential retrieval returned an invalid credential');
        }
        return credential;
      } finally {
        clearTimeout(timeout);
        if (hardKillTimer) clearTimeout(hardKillTimer);
      }
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function createFairPlayCredentialRetriever(overrides: Partial<FairPlayCredentialRetrieverDependencies> = {}) {
  const operationRepository = overrides.operationRepository ?? createOfflineCredentialRetrievalRepository(openStateCollectionDatabase({
    stateDir: config.stateDir,
    filename: config.stateDatabaseFile,
    busyTimeoutMs: config.stateDbBusyTimeoutMs,
  }, ['appstore_offline_credential_operations']));
  const dependencies: FairPlayCredentialRetrieverDependencies = {
    getDevice,
    getActiveJobs,
    getVaultStatus: getAppleAccountVaultStatus,
    updateDevice,
    saveCredential: saveAppleAccountFairPlayCredential,
    runRetriever: runCredentialHelper,
    operationRepository,
    ...overrides,
  };
  let current: CredentialRetrievalStatus = dependencies.operationRepository.read() ?? { state: 'idle' };
  if (current.state === 'running') {
    current = {
      ...current,
      state: 'interrupted',
      completedAt: Date.now(),
      error: 'The server restarted during credential retrieval. The iPad remains paused; verify it and enable it in Devices before retrying.',
    };
    dependencies.operationRepository.write(current);
  }

  function setStatus(status: CredentialRetrievalStatus, required = false): void {
    current = status;
    try {
      dependencies.operationRepository.write(status);
    } catch (error) {
      log.error('could not persist FairPlay credential retrieval status', { operationId: status.operationId, state: status.state, error: String(error) });
      if (required) throw new Error('could not persist the FairPlay credential retrieval operation');
    }
  }

  function restoreDevice(deviceId: string, reservedUpdatedAt: number | undefined): void {
    const latest = dependencies.getDevice(deviceId);
    if (reservedUpdatedAt === undefined || latest?.updatedAt !== reservedUpdatedAt) return;
    const result = dependencies.updateDevice(deviceId, { draining: false }, 'system');
    if (!result.ok) log.warn('could not release the iPad after FairPlay credential retrieval', { deviceId });
  }

  return {
    status(): CredentialRetrievalStatus {
      return { ...current };
    },
    start(deviceId: string): CredentialRetrievalStatus {
      if (current.state === 'running') {
        if (current.deviceId === deviceId) return { ...current };
        throw new Error('another FairPlay credential retrieval is already running');
      }
      const device = dependencies.getDevice(deviceId);
      if (!device || !isUsbIpad(device)) throw new Error('select an enabled, paired USB iPad');
      const vault = dependencies.getVaultStatus();
      if (!vault.encryptionReady || !vault.accountConfigured || !vault.authenticatedAt) {
        throw new Error('configure and verify the Apple Account before retrieving its device credential');
      }
      if (vault.credentialConfigured) throw new Error('a FairPlay credential is already stored for this Apple Account');
      if (isRunningOnDevice(dependencies.getActiveJobs(), device.id)) throw new Error('the selected iPad is currently running a job');
      const drained = dependencies.updateDevice(device.id, { draining: true }, 'system');
      if (!drained.ok) throw new Error('could not reserve the selected iPad');
      if (isRunningOnDevice(dependencies.getActiveJobs(), device.id)) {
        restoreDevice(device.id, drained.device?.updatedAt);
        throw new Error('the selected iPad started a job; retry after it finishes');
      }

      const startedAt = Date.now();
      const started: CredentialRetrievalStatus = { state: 'running', operationId: randomUUID(), deviceId: device.id, startedAt };
      const previous = current;
      try {
        setStatus(started, true);
      } catch {
        current = previous;
        restoreDevice(device.id, drained.device?.updatedAt);
        throw new Error('could not persist the FairPlay credential retrieval operation');
      }
      void (async () => {
        let credential: Buffer | undefined;
        try {
          credential = await dependencies.runRetriever(device);
          if (credential.length !== 16) throw new Error('retrieved FairPlay credential has an invalid length');
          dependencies.saveCredential(credential.toString('base64'));
          setStatus({ ...started, state: 'succeeded', completedAt: Date.now() });
        } catch (error) {
          const diagnostic = safeCredentialRetrievalDiagnostic(error);
          log.error('FairPlay credential retrieval failed', { operationId: started.operationId, deviceId: device.id, diagnostic });
          setStatus({ ...started, state: 'failed', completedAt: Date.now(), error: diagnostic });
        } finally {
          credential?.fill(0);
          restoreDevice(device.id, drained.device?.updatedAt);
        }
      })();
      return { ...current };
    },
  };
}

const defaultRetriever = createFairPlayCredentialRetriever();

export const getFairPlayCredentialRetrievalStatus = defaultRetriever.status;
export const startFairPlayCredentialRetrieval = defaultRetriever.start;

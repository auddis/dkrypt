import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { config } from '#config.js';
import { clearAppleAccountSessionSnapshot, markAppleAccountAuthenticated, markAppleAccountAuthenticationError, readAppleAccountSecrets, readAppleAccountSessionSnapshot, saveAppleAccountSessionSnapshot, getAppleAccountVaultStatus } from '#appleAccountVault.js';
import type { AppleAccountSecrets, AppleAccountVaultStatus } from '#appleAccountVault.js';
import { verifyIpaFairPlayDecrypted, type FairPlayVerificationResult } from '#util/ipaFairPlay.js';
import type { Job, JobExecutionStage } from '#jobs/types.js';
import { throwIfAborted } from '#util/abort.js';
import { terminateChildProcess } from '#jobs/process.js';

export interface OfflineAppStoreReadiness {
  enabled: boolean;
  ready: boolean;
  downloaderAvailable: boolean;
  decryptorAvailable: boolean;
  terminalAvailable: boolean;
  fairPlayAuthorized: boolean;
  vault: AppleAccountVaultStatus;
  blockers: string[];
}

export interface OfflineAppStoreResult {
  outputPath: string;
  warnings: string[];
  verification: FairPlayVerificationResult;
}

export interface OfflineAppStoreProcessor {
  readiness(job?: Pick<Job, 'testflight'>): OfflineAppStoreReadiness;
  run(job: Job, signal?: AbortSignal, setStage?: (stage: JobExecutionStage) => void): Promise<OfflineAppStoreResult>;
}

export interface OfflineAppStoreDependencies {
  enabled: boolean;
  fairPlayAuthorized: boolean;
  downloaderPath: string;
  decryptorPath: string;
  terminalPath: string;
  stagingDirectory: string;
  getSecrets(): AppleAccountSecrets | undefined;
  getVaultStatus(): AppleAccountVaultStatus;
  runDownload(job: Job, secrets: AppleAccountSecrets, outputPath: string, signal?: AbortSignal): Promise<void>;
  runDecrypt(job: Job, secrets: AppleAccountSecrets, inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void>;
  verify(path: string): FairPlayVerificationResult;
}

export class OfflineAppStoreUnavailableError extends Error {
  constructor(message = 'server-side App Store decryption is not configured') {
    super(message);
    this.name = 'OfflineAppStoreUnavailableError';
  }
}

export class OfflineAppStoreAuthenticationError extends Error {
  constructor(readonly code: 'two_factor_required' | 'authentication_failed') {
    super(code === 'two_factor_required' ? 'Apple Account verification is required' : 'Apple Account authentication failed');
    this.name = 'OfflineAppStoreAuthenticationError';
  }
}

type PromptResponder = (prompt: string) => Promise<string | undefined>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function childWritable(child: ChildProcess): Writable {
  if (!child.stdin) throw new Error('App Store helper input channel is unavailable');
  return child.stdin;
}

function runTerminalCommand(
  terminalPath: string,
  commandPath: string,
  args: string[],
  homeDirectory: string,
  signal: AbortSignal | undefined,
  childStarted: (child: ChildProcess) => void,
  respond: PromptResponder,
): Promise<{ output: string; code: number | null }> {
  const command = [commandPath, ...args].map(shellQuote).join(' ');
  const child = spawn(terminalPath, ['--quiet', '--return', '--echo=never', '--command', command, '/dev/null'], {
    cwd: homeDirectory,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: homeDirectory,
      XDG_CONFIG_HOME: path.join(homeDirectory, 'config'),
      XDG_STATE_HOME: path.join(homeDirectory, 'state'),
      XDG_DATA_HOME: path.join(homeDirectory, 'data'),
      LANG: 'C.UTF-8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  childStarted(child);
  const input = childWritable(child);
  let outputTail = '';
  let handling = Promise.resolve();
  const responded = new Set<string>();
  let closed = false;

  const onOutput = (chunk: Buffer | string) => {
    outputTail = `${outputTail}${chunk.toString()}`.slice(-8192);
    handling = handling.then(async () => {
      const promptOutput = outputTail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
      const prompt = [
        { key: 'Apple Account', pattern: /(?:enter (?:your )?)?(?:apple id|apple account)\s*:?\s*$/i },
        { key: 'password', pattern: /(?:enter (?:your )?)?password\s*:?\s*$/i },
        { key: '2FA code', pattern: /(?:enter (?:your )?)?(?:2fa|two.factor|verification) code\s*:?\s*$/i },
        { key: 'keychain passphrase', pattern: /(?:enter (?:your )?)?keychain passphrase\s*:?\s*$/i },
      ].find((candidate) => candidate.pattern.test(promptOutput.trimEnd()) && !responded.has(candidate.key));
      if (!prompt) return;
      responded.add(prompt.key);
      const response = await respond(prompt.key);
      if (response === undefined) {
        terminateChildProcess(child, 'SIGTERM');
        return;
      }
      if (closed) return;
      input.write(`${response}\n`);
    });
  };

  const abort = () => {
    if (closed) return;
    terminateChildProcess(child, 'SIGTERM');
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout?.on('data', onOutput);
  child.stderr?.on('data', onOutput);

  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      closed = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      closed = true;
      signal?.removeEventListener('abort', abort);
      void handling.then(() => resolve({ output: outputTail, code }), reject);
    });
  });
}

function statusBlockers(input: {
  enabled: boolean;
  downloaderAvailable: boolean;
  decryptorAvailable: boolean;
  terminalAvailable: boolean;
  fairPlayAuthorized: boolean;
  vault: AppleAccountVaultStatus;
}): string[] {
  const blockers: string[] = [];
  if (!input.enabled) blockers.push('offline decryption is disabled');
  if (!input.fairPlayAuthorized) blockers.push('FairPlay decryptor use has not been approved');
  if (!input.downloaderAvailable) blockers.push('App Store downloader is missing');
  if (!input.decryptorAvailable) blockers.push('FairPlay decryptor is missing');
  if (!input.terminalAvailable) blockers.push('secure prompt runner is missing');
  if (!input.vault.encryptionReady) blockers.push('external credential encryption key is not configured');
  if (input.vault.authenticationError === 'encryption_key_mismatch') blockers.push('stored account data cannot be decrypted with the configured key');
  if (!input.vault.accountConfigured) blockers.push('Apple Account credentials are not configured');
  if (input.vault.authenticationError && input.vault.authenticationError !== 'encryption_key_mismatch') blockers.push('Apple Account session needs verification');
  if (!input.vault.authenticatedAt) blockers.push('Apple Account session has not been verified');
  if (!input.vault.credentialConfigured) blockers.push('device-derived FairPlay credential is not configured');
  return blockers;
}

export function createOfflineAppStoreProcessor(dependencies: OfflineAppStoreDependencies): OfflineAppStoreProcessor {
  const isExecutable = (filePath: string): boolean => {
    try {
      accessSync(filePath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const readiness = (job?: Pick<Job, 'testflight'>): OfflineAppStoreReadiness => {
    const vault = dependencies.getVaultStatus();
    const downloaderAvailable = isExecutable(dependencies.downloaderPath);
    const decryptorAvailable = isExecutable(dependencies.decryptorPath);
    const terminalAvailable = isExecutable(dependencies.terminalPath);
    const blockers = statusBlockers({ enabled: dependencies.enabled, fairPlayAuthorized: dependencies.fairPlayAuthorized, downloaderAvailable, decryptorAvailable, terminalAvailable, vault });
    if (job?.testflight) blockers.push('TestFlight stays on the device workflow');
    return {
      enabled: dependencies.enabled,
      ready: blockers.length === 0 && !job?.testflight,
      downloaderAvailable,
      decryptorAvailable,
      terminalAvailable,
      fairPlayAuthorized: dependencies.fairPlayAuthorized,
      vault,
      blockers,
    };
  };

  return {
    readiness,
    async run(job, signal, setStage) {
      if (job.testflight) throw new OfflineAppStoreUnavailableError('TestFlight stays on the device workflow');
      const currentReadiness = readiness(job);
      if (!currentReadiness.ready) throw new OfflineAppStoreUnavailableError(currentReadiness.blockers.join('; '));
      const secrets = dependencies.getSecrets();
      if (!secrets?.fairPlayCredential) throw new OfflineAppStoreUnavailableError('device-derived FairPlay credential is not configured');
      throwIfAborted(signal);
      await mkdir(dependencies.stagingDirectory, { recursive: true, mode: 0o700 });
      const encryptedPath = path.join(dependencies.stagingDirectory, `${job.id}.offline-encrypted.ipa`);
      const outputPath = path.join(dependencies.stagingDirectory, `${job.id}.offline-decrypted.ipa`);
      await rm(encryptedPath, { force: true });
      await rm(outputPath, { force: true });
      try {
        await dependencies.runDownload(job, secrets, encryptedPath, signal);
        throwIfAborted(signal);
        const downloaded = await stat(encryptedPath);
        if (!downloaded.isFile() || downloaded.size <= 0 || downloaded.size > config.artifactMaxBytes) {
          throw new Error('App Store download has an invalid size');
        }
        setStage?.('offline_decrypting');
        await dependencies.runDecrypt(job, secrets, encryptedPath, outputPath, signal);
        throwIfAborted(signal);
        const verification = dependencies.verify(outputPath);
        if (verification.primaryEncrypted || (verification.encryptedPaths.length > 0 && !verification.extensionOnly)) {
          throw new Error(`FairPlay verification found encrypted executable paths: ${verification.encryptedPaths.join(', ')}`);
        }
        if (verification.extensionOnly) {
          job.warnings = [`Some embedded extensions remained encrypted: ${verification.encryptedPaths.join(', ')}`];
        }
        const output = await stat(outputPath);
        if (!output.isFile() || output.size <= 0 || output.size > config.artifactMaxBytes) throw new Error('decrypted IPA has an invalid size');
        await rm(encryptedPath, { force: true });
        return { outputPath, warnings: job.warnings ?? [], verification };
      } catch (error) {
        await Promise.all([rm(encryptedPath, { force: true }), rm(outputPath, { force: true })]);
        throw error;
      }
    },
  };
}

const defaultStagingDirectory = path.join(config.artifactDir, '.staging');
const SESSION_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
const SESSION_FILE_COUNT_LIMIT = 1000;
const SESSION_WORKSPACE_ROOT = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
let sessionOperation = Promise.resolve();

interface SessionFileEntry {
  path: string;
  data: string;
}

async function collectSessionFiles(root: string, relative = ''): Promise<SessionFileEntry[]> {
  const entries: SessionFileEntry[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const itemPath = path.join(relative, item.name);
    const absolutePath = path.join(root, itemPath);
    if (item.isSymbolicLink()) throw new Error('App Store provider session contains an unsupported link');
    if (item.isDirectory()) {
      entries.push(...await collectSessionFiles(root, itemPath));
      continue;
    }
    if (!item.isFile()) continue;
    const contents = await readFile(absolutePath);
    if (contents.length > SESSION_FILE_LIMIT_BYTES) throw new Error('App Store provider session file is too large');
    entries.push({ path: itemPath.split(path.sep).join('/'), data: contents.toString('base64') });
    if (entries.length > SESSION_FILE_COUNT_LIMIT) throw new Error('App Store provider session contains too many files');
  }
  return entries;
}

function parseSessionSnapshot(snapshot: Buffer): SessionFileEntry[] {
  const parsed = JSON.parse(snapshot.toString('utf8')) as { version?: unknown; files?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.files) || parsed.files.length > SESSION_FILE_COUNT_LIMIT) {
    throw new Error('stored App Store provider session is invalid');
  }
  return parsed.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as SessionFileEntry).path !== 'string' || typeof (entry as SessionFileEntry).data !== 'string') {
      throw new Error('stored App Store provider session is invalid');
    }
    const file = entry as SessionFileEntry;
    const normalized = path.posix.normalize(file.path);
    if (!file.path || normalized === '.' || normalized !== file.path || normalized.startsWith('../') || normalized.startsWith('/') || file.path.includes('\\')) {
      throw new Error('stored App Store provider session path is invalid');
    }
    return file;
  });
}

async function restoreSessionWorkspace(root: string): Promise<void> {
  const snapshot = readAppleAccountSessionSnapshot();
  if (!snapshot) return;
  try {
    for (const entry of parseSessionSnapshot(snapshot)) {
      const destination = path.resolve(root, ...entry.path.split('/'));
      if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new Error('stored App Store provider session path is invalid');
      const contents = Buffer.from(entry.data, 'base64');
      if (contents.toString('base64') !== entry.data || contents.length > SESSION_FILE_LIMIT_BYTES) throw new Error('stored App Store provider session file is invalid');
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, contents, { mode: 0o600 });
      contents.fill(0);
    }
  } finally {
    snapshot.fill(0);
  }
}

async function saveSessionWorkspace(root: string): Promise<void> {
  const files = await collectSessionFiles(root);
  if (files.length > SESSION_FILE_COUNT_LIMIT) throw new Error('App Store provider session contains too many files');
  const snapshot = Buffer.from(JSON.stringify({ version: 1, files }));
  try {
    saveAppleAccountSessionSnapshot(snapshot);
  } finally {
    snapshot.fill(0);
  }
}

async function withSessionWorkspace<T>(operation: (homeDirectory: string) => Promise<T>): Promise<T> {
  const previous = sessionOperation;
  let release: () => void = () => {};
  sessionOperation = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let homeDirectory: string | undefined;
  let result: T | undefined;
  let operationError: unknown;
  try {
    homeDirectory = await mkdtemp(path.join(SESSION_WORKSPACE_ROOT, 'dkrypt-appstore-session-'));
    await chmod(homeDirectory, 0o700);
    await restoreSessionWorkspace(homeDirectory);
    try {
      result = await operation(homeDirectory);
    } catch (error) {
      operationError = error;
    }
    await saveSessionWorkspace(homeDirectory);
  } catch (error) {
    if (operationError === undefined) operationError = error;
  } finally {
    try {
      if (homeDirectory) await rm(homeDirectory, { recursive: true, force: true });
    } finally {
      release();
    }
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}

async function runDefaultDownload(job: Job, secrets: AppleAccountSecrets, outputPath: string, signal?: AbortSignal): Promise<void> {
  const args = ['--format', 'json', 'download', '--bundle-identifier', job.bundleId, '--output', outputPath];
  if (job.externalVersionId) args.push('--external-version-id', job.externalVersionId);
  let requestedCredentials = false;
  const result = await withSessionWorkspace((homeDirectory) => runTerminalCommand(
      config.appStoreOfflineTerminalBin,
      config.appStoreOfflineDownloaderBin,
      args,
      homeDirectory,
      signal,
      (child) => { job.childProcess = child; },
      async (prompt) => {
        if (/2fa code|verification code/i.test(prompt)) return undefined;
        if (/keychain passphrase/i.test(prompt)) {
          requestedCredentials = true;
          return secrets.keychainPassphrase;
        }
        if (/password/i.test(prompt)) {
          requestedCredentials = true;
          return secrets.password;
        }
        if (/apple id|apple account/i.test(prompt)) {
          requestedCredentials = true;
          return secrets.appleId;
        }
        return undefined;
      },
    )).finally(() => { job.childProcess = undefined; });
  if (result.code !== 0) {
    const twoFactorRequired = /2fa code|verification code|two-factor/i.test(result.output);
    if (twoFactorRequired) {
      clearAppleAccountSessionSnapshot();
      markAppleAccountAuthenticationError('two_factor_required');
      throw new OfflineAppStoreAuthenticationError('two_factor_required');
    }
    if (/incorrect password|authentication failed|session expired|not authenticated/i.test(result.output)) {
      clearAppleAccountSessionSnapshot();
      markAppleAccountAuthenticationError('authentication_failed');
    }
    throw new Error('App Store download failed');
  }
  if (requestedCredentials) markAppleAccountAuthenticated();
}

async function runDefaultDecrypt(job: Job, secrets: AppleAccountSecrets, inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  const credential = Buffer.from(secrets.fairPlayCredential ?? '', 'base64');
  if (credential.length !== 16) throw new Error('stored FairPlay credential is invalid');
  const child = spawn(config.appStoreOfflineDecryptorBin, [inputPath, outputPath, '--credential', '/proc/self/fd/3'], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  job.childProcess = child;
  const credentialPipe = child.stdio[3] as Writable | null;
  if (!credentialPipe) {
    credential.fill(0);
    terminateChildProcess(child, 'SIGTERM');
    job.childProcess = undefined;
    throw new Error('FairPlay credential channel is unavailable');
  }
  const credentialForPipe = Buffer.from(credential);
  credential.fill(0);
  credentialPipe.end(credentialForPipe, () => credentialForPipe.fill(0));
  const abort = () => terminateChildProcess(child, 'SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error('offline decryption was cancelled'));
          return;
        }
        if (code !== 0) {
          reject(new Error('FairPlay decryption failed'));
          return;
        }
        resolve();
      });
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    if (job.childProcess === child) job.childProcess = undefined;
  }
}

export async function authenticateAppleAccount(authCode?: string): Promise<void> {
  if (authCode !== undefined && !/^\d{6}$/.test(authCode)) throw new Error('enter the six-digit Apple verification code');
  const secrets = readAppleAccountSecrets();
  if (!secrets) throw new OfflineAppStoreUnavailableError('Apple Account credentials are not configured');
  const args = ['--format', 'json', 'auth', 'login'];
  let usedAuthCode = false;
  const result = await withSessionWorkspace((homeDirectory) => runTerminalCommand(
      config.appStoreOfflineTerminalBin,
      config.appStoreOfflineDownloaderBin,
      args,
      homeDirectory,
      undefined,
      () => {},
      async (prompt) => {
        if (/2fa code|verification code/i.test(prompt)) {
          if (!authCode || usedAuthCode) return undefined;
          usedAuthCode = true;
          return authCode;
        }
        if (/keychain passphrase/i.test(prompt)) return secrets.keychainPassphrase;
        if (/password/i.test(prompt)) return secrets.password;
        if (/apple id|apple account/i.test(prompt)) return secrets.appleId;
        return undefined;
      },
    ));
  if (result.code !== 0) {
    const twoFactorRequired = /2fa code|verification code|two-factor/i.test(result.output) && !usedAuthCode;
    const code = twoFactorRequired ? 'two_factor_required' : 'authentication_failed';
    clearAppleAccountSessionSnapshot();
    markAppleAccountAuthenticationError(code);
    throw new OfflineAppStoreAuthenticationError(code);
  }
  markAppleAccountAuthenticated();
}

export function getOfflineAppStoreReadiness(job?: Pick<Job, 'testflight'>): OfflineAppStoreReadiness {
  return defaultProcessor.readiness(job);
}

export const offlineAppStoreProcessor = createOfflineAppStoreProcessor({
  enabled: config.appStoreOfflineDecryptEnabled,
  fairPlayAuthorized: config.appStoreOfflineFairPlayAuthorized,
  downloaderPath: config.appStoreOfflineDownloaderBin,
  decryptorPath: config.appStoreOfflineDecryptorBin,
  terminalPath: config.appStoreOfflineTerminalBin,
  stagingDirectory: defaultStagingDirectory,
  getSecrets: readAppleAccountSecrets,
  getVaultStatus: getAppleAccountVaultStatus,
  runDownload: runDefaultDownload,
  runDecrypt: runDefaultDecrypt,
  verify: verifyIpaFairPlayDecrypted,
});

const defaultProcessor = offlineAppStoreProcessor;

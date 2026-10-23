import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '#config.js';
import type { ExtractedIpaMetadata } from '#util/ipaMetadata.js';
import type { FairPlayVerificationResult } from '#util/ipaFairPlay.js';
import { terminateChildProcess } from '#jobs/process.js';
import { commandWithResourceLimits } from '#jobs/resourceLimits.js';

export interface IpaInspection {
  metadata: ExtractedIpaMetadata;
  verification: FairPlayVerificationResult;
}

interface IpaInspectionProcessResult {
  metadata: ExtractedIpaMetadata;
  verification: FairPlayVerificationResult;
}

const MAX_INSPECTION_OUTPUT_BYTES = 1024 * 1024;
const workerPath = fileURLToPath(new URL('./ipaInspectionWorker.ts', import.meta.url));

function workerCommand(ipaPath: string): string[] {
  const limited = commandWithResourceLimits(process.execPath, [workerPath, ipaPath], config.appStoreOfflineWorkerMemoryMb, config.appStoreOfflineInspectTimeoutSeconds);
  return [limited.command, ...limited.args];
}

export function inspectIpaInIsolatedProcess(
  ipaPath: string,
  signal?: AbortSignal,
  onChildProcess?: (child: ChildProcess | undefined) => void,
): Promise<IpaInspection> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('IPA inspection was cancelled'));

  return new Promise((resolve, reject) => {
    const [command, ...args] = workerCommand(ipaPath);
    const child = spawn(command!, args, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    onChildProcess?.(child);
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (inspectionTimer) clearTimeout(inspectionTimer);
      signal?.removeEventListener('abort', abort);
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      terminateChildProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateChildProcess(child, 'SIGKILL'), config.jobProcessGraceSeconds * 1000);
      killTimer.unref();
    };
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('IPA inspection was cancelled'));
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      onChildProcess?.(undefined);
      reject(error);
    };

    signal?.addEventListener('abort', abort, { once: true });
    inspectionTimer = setTimeout(() => stop(new Error('IPA inspection exceeded its time limit')), config.appStoreOfflineInspectTimeoutSeconds * 1000);
    inspectionTimer.unref();
    if (signal?.aborted) abort();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_INSPECTION_OUTPUT_BYTES) {
        stop(new Error('IPA inspection returned too much data'));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4096);
    });
    child.once('error', (error) => fail(error));
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      onChildProcess?.(undefined);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `IPA inspection worker exited with code ${String(code)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.toString('utf8')) as IpaInspectionProcessResult;
        if (!result.metadata?.summary || !result.metadata.infoPlist || !result.verification?.primaryExecutable) {
          throw new Error('IPA inspection worker returned an invalid result');
        }
        resolve(result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

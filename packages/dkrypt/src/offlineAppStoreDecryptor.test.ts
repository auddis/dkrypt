import { expect, test } from 'bun:test';
import { invokeFairPlayDecryptor } from '#offlineAppStoreDecryptor.js';
import type { Job } from '#jobs/types.js';

function job(): Job {
  return {
    id: 'fairplay-diagnostic-job',
    bundleId: 'com.example.app',
    source: 'manual',
    status: 'running',
    priority: 0,
    progress: 'processing',
    createdAt: Date.now(),
    waiters: [],
  };
}

test('FairPlay decryptor failure preserves a concise sanitized stderr reason', async () => {
  const sensitivePath = '/private/runtime/dkrypt-fairplay-secret/credential.bin';
  const currentJob = job();

  await expect(invokeFairPlayDecryptor({
    commandPath: '/bin/sh',
    commandArgs: ['-c', `printf '%s\\n' 'Traceback: ${sensitivePath}' 'ValueError: unsupported SINF' >&2; exit 9`],
    memoryMb: 256,
    cpuSeconds: 5,
    job: currentJob,
    sensitiveValues: [sensitivePath],
  })).rejects.toThrow('ValueError: unsupported SINF');

  await expect(invokeFairPlayDecryptor({
    commandPath: '/bin/sh',
    commandArgs: ['-c', `printf '%s\\n' 'ValueError: ${sensitivePath}' >&2; exit 9`],
    memoryMb: 256,
    cpuSeconds: 5,
    job: currentJob,
    sensitiveValues: [sensitivePath],
  })).rejects.not.toThrow(sensitivePath);
});

test('FairPlay decryptor diagnostics are bounded and exclude stdout', async () => {
  const noisyOutput = 'x'.repeat(5000);

  const failure = await invokeFairPlayDecryptor({
    commandPath: '/bin/sh',
    commandArgs: ['-c', `printf '%s\\n' '${noisyOutput}' >&2; printf '%s\\n' 'stdout-only secret'; exit 1`],
    memoryMb: 256,
    cpuSeconds: 5,
    job: job(),
    diagnosticLimit: 240,
  }).then(() => undefined, (error: Error) => error);
  if (!(failure instanceof Error)) throw new Error('FairPlay decryptor did not fail');
  expect(failure.message.length).toBeLessThan(300);
  expect(failure.message).not.toContain('stdout-only secret');
});

test('FairPlay decryptor clears job process ownership after a failed child', async () => {
  const currentJob = job();

  await expect(invokeFairPlayDecryptor({
    commandPath: '/bin/sh',
    commandArgs: ['-c', "printf '%s\\n' 'unsupported SINF' >&2; exit 1"],
    memoryMb: 256,
    cpuSeconds: 5,
    job: currentJob,
  })).rejects.toThrow('unsupported SINF');

  expect(currentJob.childProcess).toBeUndefined();
});

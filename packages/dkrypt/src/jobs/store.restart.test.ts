import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJobRepository } from '#jobs/repository.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { SCHEDULER_JOB_TIMEOUT_MS } from '#jobs/timeouts.js';

test('expires a restored queued job in live and persisted job state', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-expired-job-restart-'));
  const id = 'expired-queued-after-restart';
  const createdAt = Date.now() - SCHEDULER_JOB_TIMEOUT_MS - 5_000;
  const job: Job = {
    id,
    projectId: 'default',
    bundleId: 'com.apple.Pages',
    source: 'scheduler',
    priority: 0,
    status: 'queued',
    progress: 'waiting for a compatible device',
    createdAt,
    deadlineAt: createdAt + SCHEDULER_JOB_TIMEOUT_MS,
    schedulerDeadlineAt: createdAt + SCHEDULER_JOB_TIMEOUT_MS,
    waiters: [],
  };

  try {
    const repository = createJobRepository(openStateCollectionDatabase(
      { stateDir, filename: 'state.sqlite' },
      ['jobs', 'job_timelines'],
    ));
    repository.replace([job]);
    repository.close();

    const child = Bun.spawn(
      [process.execPath, '-e', `
        const [{ getJob }, { loadPersistedJobs }, { getJobHistoryEntryById }] = await Promise.all([
          import('./src/jobs/store.ts'),
          import('./src/jobs/repository.ts'),
          import('./src/store/state.ts'),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const id = 'expired-queued-after-restart';
        const active = getJob(id);
        const persisted = loadPersistedJobs().find((job) => job.id === id);
        const history = getJobHistoryEntryById(id);
        process.stdout.write(JSON.stringify({ marker: 'recovery-status', activeStatus: active?.status, persistedStatus: persisted?.status, historyStatus: history?.status }) + '\\n');
      `],
      {
        cwd: process.cwd(),
        env: {
          API_KEY: 'restart-test-api-key',
          SESSION_SIGNING_SECRET: 'restart-test-session-secret',
          ADMIN_PASSWORD: 'restart-test-admin-password',
          STATE_DIR: stateDir,
          STATE_DATABASE_FILE: 'state.sqlite',
          PATH: process.env.PATH ?? '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const resultLine = stdout.split('\n').find((line) => line.includes('"marker":"recovery-status"'));

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('error');
    expect(resultLine).toBeDefined();
    expect(JSON.parse(resultLine!)).toEqual({
      marker: 'recovery-status',
      activeStatus: 'failed',
      persistedStatus: 'failed',
      historyStatus: 'failed',
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

import cron, { type ScheduledTask } from 'node-cron';
import { scopedLogger } from '#logger.js';
import { createBackupSnapshot, getBackupSchedule } from '#store/state.js';

const log = scopedLogger('backup-scheduler');
let backupTask: ScheduledTask | undefined;
let backupTaskCron: string | undefined;
let stopping = false;

export function applyBackupSchedule(): void {
  if (stopping) return;
  const schedule = getBackupSchedule();

  if (!schedule.enabled || !cron.validate(schedule.cron)) {
    backupTask?.stop();
    backupTask = undefined;
    backupTaskCron = undefined;
    return;
  }

  if (backupTask && backupTaskCron === schedule.cron) return;

  backupTask?.stop();
  backupTask = cron.schedule(schedule.cron, () => {
    try {
      const backup = createBackupSnapshot('scheduled');
      if (backup.restoreDrillStatus === 'passed') {
        log.info('scheduled backup snapshot created and restore-tested', { filename: backup.filename });
      } else {
        log.error('scheduled backup snapshot restore verification failed', { filename: backup.filename, checks: backup.restoreDrillChecks });
      }
    } catch (error) {
      log.error('scheduled backup snapshot failed', { error: String(error) });
    }
  });
  backupTaskCron = schedule.cron;
  log.info('backup schedule applied', { cron: schedule.cron });
}

export function startBackupScheduler(): void {
  stopping = false;
  applyBackupSchedule();
}

export function stopBackupScheduler(): void {
  stopping = true;
  backupTask?.stop();
  backupTask = undefined;
  backupTaskCron = undefined;
}

import { getBillingEntitlements } from '#billing.js';
import { getAuthProfile } from '#identity.js';
import { config } from '#config.js';
import { getMaintenanceStatus } from '#maintenance.js';
import { getActiveJobs, getJobQueueSummaries, getQueueReason } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { getDeviceInstallBlocker } from '#deviceInstallEligibility.js';
import { serializeDashboardDevice } from '#dashboardDevicePresentation.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { effectiveTimeZone } from '#util/timezone.js';
import { nextRunnableCronOccurrence } from '#util/maintenanceWindow.js';
import { getDiskUsage } from '#util/diskUsage.js';
import {
  DEFAULT_PROJECT_ID,
  getEffectiveDevices,
  getEffectiveSettings,
  getEffectiveWatches,
  getSchedulerRunHistory,
  getWatchConfigIssues,
  isWatchSchedulable,
} from '#store/state.js';

const DEVICE_STATUS_FRESH_MS = 10 * 60_000;

export function buildDashboardOverview(permissions: bigint, userId: string, projectId = DEFAULT_PROJECT_ID) {
  const canViewAutomation = hasPermission(permissions, PermissionFlag.viewAutomation) || hasPermission(permissions, PermissionFlag.manageAutomation);
  const canViewDeviceData = hasPermission(permissions, PermissionFlag.viewDevices) || hasPermission(permissions, PermissionFlag.manageDevices);
  const projectWatches = getEffectiveWatches().filter((watch) =>
    (watch.projectId ?? DEFAULT_PROJECT_ID) === projectId && canAccessProject(userId, permissions, watch.projectId ?? DEFAULT_PROJECT_ID),
  );
  const statusWatches = projectWatches.map((watch) => {
    const schedulable = isWatchSchedulable(watch);
    return {
      id: watch.id,
      bundleId: watch.bundleId,
      schedulable,
      nextRunAt: schedulable
        ? nextRunnableCronOccurrence(watch.pollCron, effectiveTimeZone(watch.timezone), watch.maintenanceWindow, Date.now(), Date.now() + 366 * 24 * 60 * 60 * 1000)?.at
        : undefined,
    };
  });
  const watches = canViewAutomation ? projectWatches.map((watch, index) => {
    const publicWatch = { ...watch };
    delete publicWatch.lastScheduledAt;
    return {
      ...publicWatch,
      timezone: effectiveTimeZone(watch.timezone),
      missedRunPolicy: watch.missedRunPolicy ?? 'skip',
      nextRunAt: statusWatches[index]?.nextRunAt,
      schedulable: statusWatches[index]?.schedulable ?? false,
      configIssues: getWatchConfigIssues(watch),
    };
  }) : [];
  const statusWatchIds = new Set(statusWatches.map((watch) => watch.id));
  const schedulerRunHistory = getSchedulerRunHistory(200).filter((run) => run.watchId !== undefined && statusWatchIds.has(run.watchId)).slice(0, 10);
  const deviceRecords = getEffectiveDevices();
  const devices = canViewDeviceData ? deviceRecords.map((device) => serializeDashboardDevice(device)) : [];
  const cachedHealthByDevice = new Map(deviceRecords.map((device) => [device.id, getCachedDeviceHealth(device.id)?.value] as const));
  const freshHealthForDevice = (deviceId: string) => {
    const health = cachedHealthByDevice.get(deviceId);
    return health && Date.now() - health.checkedAt <= DEVICE_STATUS_FRESH_MS ? health : undefined;
  };
  const statusDevices = deviceRecords.map((device) => {
    const health = freshHealthForDevice(device.id);
    return {
      id: device.id,
      name: device.name,
      enabled: device.enabled,
      draining: device.draining ?? false,
      isPrimary: device.isPrimary,
      reachable: health?.reachable,
    };
  });
  const enabledDevices = deviceRecords.filter((device) => device.enabled);
  const recentHealth = enabledDevices.map((device) => freshHealthForDevice(device.id))
    .filter((health): health is NonNullable<typeof health> => health !== undefined);
  const onlineDevices = recentHealth.filter((health) => health.reachable).length;
  const readyDevices = recentHealth.filter((health) => health.reachable && !getDeviceInstallBlocker(health)).length;
  const unavailableDevices = recentHealth.length - onlineDevices;
  const deviceStatus = {
    configured: deviceRecords.length,
    enabled: enabledDevices.length,
    online: onlineDevices,
    ready: readyDevices,
    attention: onlineDevices - readyDevices,
    checking: enabledDevices.length - recentHealth.length,
    unavailable: unavailableDevices,
    freshUntil: recentHealth.length > 0 ? Math.min(...recentHealth.map((health) => health.checkedAt + DEVICE_STATUS_FRESH_MS)) : undefined,
  };
  const settings = getEffectiveSettings();
  const activeJobs = getActiveJobs().filter((job): job is Job & { status: 'queued' | 'running' } =>
    (job.status === 'queued' || job.status === 'running') && (job.projectId ?? DEFAULT_PROJECT_ID) === projectId,
  );
  const queueSummaries = getJobQueueSummaries(activeJobs);
  return {
    schedulerEnabled: statusWatches.some((watch) => watch.schedulable),
    settings: canViewAutomation ? settings : { ...settings, notifyWebhookUrl: '' },
    watches,
    statusWatches,
    devices,
    statusDevices,
    deviceStatus,
    lastSchedulerRunAt: schedulerRunHistory[0]?.ts,
    schedulerRunHistory,
    disk: getDiskUsage(config.artifactDir),
    isPaidPlan: getBillingEntitlements(userId).planId !== 'viewer',
    maintenance: getMaintenanceStatus(),
    projectId,
    activeJobs: activeJobs.map((job) => ({
      id: job.id,
      correlationId: job.correlationId ?? job.id,
      bundleId: job.bundleId,
      source: job.source,
      status: job.status,
      progress: job.progress,
      versionLabel: job.versionLabel,
      deviceId: job.deviceId,
      preferredDeviceId: job.preferredDeviceId,
      transport: job.transport,
      warnings: job.warnings,
      testflight: job.testflight
        ? { appId: job.testflight.appId, buildId: job.testflight.build.id, version: job.testflight.build.cfBundleShortVersion, buildNumber: job.testflight.build.cfBundleVersion }
        : undefined,
      queuedBy: job.queuedBy,
      queuedByDisplayName: job.queuedBy ? getAuthProfile(job.queuedBy)?.displayName : undefined,
      priority: job.priority,
      createdAt: job.createdAt,
      queue: queueSummaries.get(job.id),
      attempt: job.attempt,
      retryCount: job.retryCount,
      deadlineAt: job.deadlineAt,
      deadlineExceeded: job.deadlineExceeded,
      failureClass: job.failureClass,
      queueReason: getQueueReason(job),
    })),
  };
}

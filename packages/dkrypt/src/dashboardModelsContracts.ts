import { Type } from '@sinclair/typebox';
import { deviceTransportSchema, identifierSchema } from '#apiCommonContracts.js';

export const deviceTransportStateSchema = Type.Union([
  Type.Literal('discovered'),
  Type.Literal('pairing'),
  Type.Literal('connecting'),
  Type.Literal('ready'),
  Type.Literal('degraded'),
  Type.Literal('recovering'),
  Type.Literal('offline'),
  Type.Literal('unsupported'),
]);

const bridgeHeartbeatSchema = Type.Object({
  bridgeVersion: Type.Optional(Type.String()),
  channel: Type.Optional(Type.Union([Type.Literal('springboard'), Type.Literal('testflight'), Type.Literal('appstore')])),
  process: Type.Optional(Type.String()),
  at: Type.Optional(Type.Number()),
}, { additionalProperties: true });

export const bridgeHeartbeatsSchema = Type.Object({
  springboard: Type.Optional(bridgeHeartbeatSchema),
  testflight: Type.Optional(bridgeHeartbeatSchema),
  appstore: Type.Optional(bridgeHeartbeatSchema),
}, { additionalProperties: true });

export const dashboardDeviceResponseSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  enabled: Type.Boolean(),
  draining: Type.Optional(Type.Boolean()),
  isPrimary: Type.Optional(Type.Boolean()),
  transport: deviceTransportSchema,
  host: Type.Optional(Type.String()),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  user: Type.Optional(Type.String()),
  udid: Type.Optional(Type.String()),
  usbmuxNetwork: Type.Optional(Type.Boolean()),
  productType: Type.Optional(Type.String()),
  iosVersion: Type.Optional(Type.String()),
  toolchain: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  setupRequired: Type.Boolean(),
  transportState: deviceTransportStateSchema,
  transportCapabilities: Type.Array(Type.String()),
  lastSeenAt: Type.Optional(Type.Number()),
  agentHeartbeatAt: Type.Optional(Type.Number()),
  bridgeHeartbeats: Type.Optional(bridgeHeartbeatsSchema),
  recoveryState: Type.Union([Type.Literal('stable'), Type.Literal('recovering'), Type.Literal('degraded'), Type.Literal('offline')]),
}, { additionalProperties: true });

export const dashboardSettingsResponseSchema = Type.Object({
  notifyWebhookUrl: Type.String(),
  notifyFormat: Type.Union([Type.Literal('embed'), Type.Literal('plain')]),
  notifySuccessMode: Type.Union([Type.Literal('instant'), Type.Literal('daily'), Type.Literal('weekly')]),
  notifyQuietHoursStart: Type.String(),
  notifyQuietHoursEnd: Type.String(),
  notifyOnKeyRequest: Type.Boolean(),
  notifyOnAutomationSuccess: Type.Boolean(),
  notifyOnAutomationFailure: Type.Boolean(),
  notifyOnKeyExpiringSoon: Type.Boolean(),
  notifyOnDeviceOffline: Type.Boolean(),
  notifyOnDeviceBatteryHot: Type.Boolean(),
  notifyOnDeviceBatteryLow: Type.Boolean(),
  notifyOnDiskFull: Type.Boolean(),
  notifyOnDeviceStorageLow: Type.Boolean(),
  notifyOnTestFlightBridgeDown: Type.Boolean(),
  notifyOnJobCompleted: Type.Boolean(),
  notifyOnQueueSloBreach: Type.Boolean(),
  deviceOfflineAlertMinutes: Type.Integer({ minimum: 0 }),
  batteryHotAlertC: Type.Integer({ minimum: 0 }),
  batteryLowAlertPercent: Type.Integer({ minimum: 0 }),
  diskFullAlertPercent: Type.Integer({ minimum: 0 }),
  deviceStorageAlertPercent: Type.Integer({ minimum: 0 }),
  testFlightBridgeAlertMinutes: Type.Integer({ minimum: 0 }),
  jobHistoryRetentionDays: Type.Integer({ minimum: 0 }),
  maintenanceMode: Type.Boolean(),
}, { additionalProperties: true });

export const dashboardMaintenanceStatusSchema = Type.Object({
  active: Type.Boolean(),
  manual: Type.Boolean(),
  auto: Type.Boolean(),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const dashboardDiskUsageSchema = Type.Object({
  totalBytes: Type.Number(),
  freeBytes: Type.Number(),
  usedBytes: Type.Number(),
  usedPercent: Type.Number(),
}, { additionalProperties: true });

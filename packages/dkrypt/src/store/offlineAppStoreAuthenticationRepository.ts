import type { Database } from 'bun:sqlite';
import type { AppleAccountAuthenticationStatus } from '#offlineAppStoreAuthOperation.js';

export interface OfflineAppStoreAuthenticationRepository {
  read(): AppleAccountAuthenticationStatus | undefined;
  write(status: AppleAccountAuthenticationStatus): void;
}

export function createOfflineAppStoreAuthenticationRepository(database: Database): OfflineAppStoreAuthenticationRepository {
  const readQuery = database.query('SELECT payload FROM appstore_offline_authentication_operations WHERE id = ?');
  const writeQuery = database.query(`
    INSERT INTO appstore_offline_authentication_operations (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);

  return {
    read() {
      const row = readQuery.get('current') as { payload?: string } | null;
      if (!row?.payload) return undefined;
      const stored = JSON.parse(row.payload) as Record<string, unknown>;
      const state = stored.state;
      if (!['idle', 'running', 'verification_required', 'succeeded', 'failed', 'interrupted'].includes(String(state))) {
        throw new Error('stored Apple Account authentication status is malformed');
      }
      return {
        state: state as AppleAccountAuthenticationStatus['state'],
        ...(typeof stored.operationId === 'string' ? { operationId: stored.operationId } : {}),
        ...(typeof stored.startedAt === 'number' ? { startedAt: stored.startedAt } : {}),
        ...(typeof stored.completedAt === 'number' ? { completedAt: stored.completedAt } : {}),
        ...(typeof stored.error === 'string' ? { error: stored.error } : {}),
      };
    },
    write(status) {
      const updatedAt = status.completedAt ?? status.startedAt ?? Date.now();
      writeQuery.run('current', JSON.stringify(status), updatedAt);
    },
  };
}

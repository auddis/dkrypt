import type { Database } from 'bun:sqlite';
import type { CredentialRetrievalStatus } from '#offlineAppStoreCredential.js';

export interface OfflineCredentialRetrievalRepository {
  read(): CredentialRetrievalStatus | undefined;
  write(status: CredentialRetrievalStatus): void;
  close(): void;
}

export function createOfflineCredentialRetrievalRepository(database: Database): OfflineCredentialRetrievalRepository {
  const readQuery = database.query('SELECT payload FROM appstore_offline_credential_operations WHERE id = ?');
  const writeQuery = database.query(`
    INSERT INTO appstore_offline_credential_operations (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);

  return {
    read() {
      const row = readQuery.get('current') as { payload?: string } | null;
      if (!row?.payload) return undefined;
      const status = JSON.parse(row.payload) as CredentialRetrievalStatus;
      if (!['idle', 'running', 'succeeded', 'failed', 'interrupted'].includes(status.state)) {
        throw new Error('stored FairPlay credential retrieval status is malformed');
      }
      return status;
    },
    write(status) {
      const updatedAt = status.completedAt ?? status.startedAt ?? Date.now();
      writeQuery.run('current', JSON.stringify(status), updatedAt);
    },
    close() {
      database.close();
    },
  };
}

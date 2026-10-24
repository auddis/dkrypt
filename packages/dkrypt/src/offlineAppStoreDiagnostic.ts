import type { AppleAccountSecrets } from '#appleAccountVault.js';

const sensitiveFieldPattern = /(["']?(?:apple[ _-]?(?:id|account)|account[ _-]?(?:email|name)|email|password|passphrase|credential|authorization|access[ _-]?token|refresh[ _-]?token|session(?:[ _-]?token)?)["']?\s*[:=]\s*["']?)[^"'\s,}\]]+/gi;

function secretValues(secrets: AppleAccountSecrets): string[] {
  const values = [secrets.appleId, secrets.password, secrets.keychainPassphrase, secrets.fairPlayCredential];
  if (secrets.fairPlayCredential) {
    const credential = Buffer.from(secrets.fairPlayCredential, 'base64');
    if (credential.length === 16) values.push(credential.toString('hex'));
  }
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => right.length - left.length);
}

export function sanitizeAppStoreDownloadDiagnostic(output: string, secrets: AppleAccountSecrets): string {
  let sanitized = output.replaceAll('\0', '').replaceAll('\r', '\n');
  for (const value of secretValues(secrets)) sanitized = sanitized.replaceAll(value, '[redacted]');
  sanitized = sanitized
    .replace(/("(?:apple[ _-]?(?:id|account)|account[ _-]?(?:email|name)|email|password|passphrase|credential|authorization|access[ _-]?token|refresh[ _-]?token|session(?:[ _-]?token)?)"\s*:\s*")[^"\\]*(?:\\.[^"\\]*)*(")/gi, '$1[redacted]$2')
    .replace(sensitiveFieldPattern, '$1[redacted]')
    .replace(/\bBearer\s+[^\s,}\]]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-account]')
    .replace(/\/(?:dev\/shm|tmp)\/dkrypt-appstore-session-[^\s"'`]+/g, '[session-path]')
    .replace(/\b\d{6}\b/g, '[redacted-code]')
    .replace(/\n+/g, ' | ')
    .trim();
  return sanitized.slice(-1200) || 'no provider diagnostic was emitted';
}

import { describe, expect, test } from 'bun:test';
import { classifyIpaDecryptOutput } from './ipadecryptOutput.js';

const extensionOnlyOutput = [
  'Payload/YouTube.app/Extensions/AppMigrationExtension.appex/AppMigrationExtension still encrypted (cryptid != 0)',
  'Failed: [err] verify failed: 1 still encrypted',
].join('\n');

describe('classifyIpaDecryptOutput', () => {
  test('treats extension-only verification failures as warnings', () => {
    const result = classifyIpaDecryptOutput(extensionOnlyOutput);

    expect(result.extensionOnly).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('AppMigrationExtension.appex');
  });

  test('keeps main application verification failures fatal', () => {
    const result = classifyIpaDecryptOutput([
      'Payload/YouTube.app/YouTube still encrypted (cryptid != 0)',
      'Failed: [err] verify failed: 1 still encrypted',
    ].join('\n'));

    expect(result.extensionOnly).toBe(false);
    expect(result.error).toBe('Failed: [err] verify failed: 1 still encrypted');
  });

  test('keeps mixed application and extension failures fatal', () => {
    const result = classifyIpaDecryptOutput([
      'Payload/YouTube.app/Extensions/AppMigrationExtension.appex/AppMigrationExtension still encrypted (cryptid != 0)',
      'Payload/YouTube.app/YouTube still encrypted (cryptid != 0)',
      'Failed: [err] verify failed: 2 still encrypted',
    ].join('\n'));

    expect(result.extensionOnly).toBe(false);
    expect(result.error).toBe('Failed: [err] verify failed: 2 still encrypted');
  });

  test('keeps unrelated errors fatal even when an extension is encrypted', () => {
    const result = classifyIpaDecryptOutput([
      'Payload/YouTube.app/Extensions/AppMigrationExtension.appex/AppMigrationExtension still encrypted (cryptid != 0)',
      '[err] failed to write decrypted output',
    ].join('\n'));

    expect(result.extensionOnly).toBe(false);
    expect(result.error).toBe('[err] failed to write decrypted output');
  });
});

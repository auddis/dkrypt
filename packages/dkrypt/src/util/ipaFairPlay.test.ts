import AdmZip from 'adm-zip';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyIpaFairPlayDecrypted } from '#util/ipaFairPlay.js';

function machO(cryptId: number): Buffer {
  const image = Buffer.alloc(56);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(1, 16);
  image.writeUInt32LE(24, 20);
  image.writeUInt32LE(0x2c, 32);
  image.writeUInt32LE(24, 36);
  image.writeUInt32LE(cryptId, 48);
  return image;
}

function createIpa(executable: Buffer, extension?: Buffer): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'dkrypt-fairplay-'));
  const ipaPath = path.join(directory, 'app.ipa');
  const archive = new AdmZip();
  archive.addFile('Payload/Example.app/Info.plist', Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>`));
  archive.addFile('Payload/Example.app/Example', executable);
  if (extension) archive.addFile('Payload/Example.app/PlugIns/Share.appex/Share', extension);
  archive.writeZip(ipaPath);
  return ipaPath;
}

test('FairPlay verifier requires a valid arm64 primary executable and detects its cryptid', () => {
  const ipaPath = createIpa(machO(0));
  try {
    expect(verifyIpaFairPlayDecrypted(ipaPath)).toEqual({
      encryptedPaths: [],
      primaryExecutable: 'Payload/Example.app/Example',
      primaryEncrypted: false,
      extensionOnly: false,
    });
  } finally {
    rmSync(path.dirname(ipaPath), { recursive: true, force: true });
  }
});

test('FairPlay verifier distinguishes extension-only encryption from a primary executable failure', () => {
  const extensionOnlyPath = createIpa(machO(0), machO(1));
  const primaryEncryptedPath = createIpa(machO(1), machO(1));
  try {
    expect(verifyIpaFairPlayDecrypted(extensionOnlyPath)).toMatchObject({
      encryptedPaths: ['Payload/Example.app/PlugIns/Share.appex/Share'],
      primaryEncrypted: false,
      extensionOnly: true,
    });
    expect(verifyIpaFairPlayDecrypted(primaryEncryptedPath)).toMatchObject({
      primaryEncrypted: true,
      extensionOnly: false,
    });
  } finally {
    rmSync(path.dirname(extensionOnlyPath), { recursive: true, force: true });
    rmSync(path.dirname(primaryEncryptedPath), { recursive: true, force: true });
  }
});

test('FairPlay verifier rejects malformed primary executables', () => {
  const ipaPath = createIpa(Buffer.from('invalid'));
  try {
    expect(() => verifyIpaFairPlayDecrypted(ipaPath)).toThrow('no arm64 Mach-O slice');
  } finally {
    rmSync(path.dirname(ipaPath), { recursive: true, force: true });
  }
});

import AdmZip from 'adm-zip';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getIpaFairPlayLicenseSelector, verifyIpaFairPlayDecrypted } from '#util/ipaFairPlay.js';

function atom(name: string, value: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(value.length + header.length);
  header.write(name, 4, 4, 'ascii');
  return Buffer.concat([header, value]);
}

function sinf(user: number[], key: number[]): Buffer {
  const fields = Buffer.concat([
    atom('user', Buffer.from(user)),
    atom('key ', Buffer.from(key)),
    atom('name', Buffer.from('app-name')),
    atom('iviv', Buffer.alloc(16, 1)),
    atom('priv', Buffer.alloc(448, 2)),
  ]);
  return atom('sinf', atom('schi', fields));
}

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

function createIpaWithSinf(license: Buffer): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'dkrypt-fairplay-selector-'));
  const ipaPath = path.join(directory, 'app.ipa');
  const archive = new AdmZip();
  archive.addFile('Payload/Example.app/Info.plist', Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>`));
  archive.addFile('Payload/Example.app/SC_Info/Example.sinf', license);
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

test('FairPlay selector is stable for an account and key pair and differs across keys', () => {
  const firstPath = createIpaWithSinf(sinf([1, 2, 3, 4], [5, 6, 7, 8]));
  const samePath = createIpaWithSinf(sinf([1, 2, 3, 4], [5, 6, 7, 8]));
  const differentKeyPath = createIpaWithSinf(sinf([1, 2, 3, 4], [8, 7, 6, 5]));
  try {
    const first = getIpaFairPlayLicenseSelector(firstPath);
    expect(first).toBe(getIpaFairPlayLicenseSelector(samePath));
    expect(first).not.toBe(getIpaFairPlayLicenseSelector(differentKeyPath));
  } finally {
    rmSync(path.dirname(firstPath), { recursive: true, force: true });
    rmSync(path.dirname(samePath), { recursive: true, force: true });
    rmSync(path.dirname(differentKeyPath), { recursive: true, force: true });
  }
});

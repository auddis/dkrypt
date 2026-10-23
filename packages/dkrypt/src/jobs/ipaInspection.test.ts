import AdmZip from 'adm-zip';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectIpaInIsolatedProcess } from '#jobs/ipaInspection.js';

function machO(): Buffer {
  const image = Buffer.alloc(56);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(1, 16);
  image.writeUInt32LE(24, 20);
  image.writeUInt32LE(0x2c, 32);
  image.writeUInt32LE(24, 36);
  image.writeUInt32LE(0, 48);
  return image;
}

test('IPA inspection runs in a separate process and returns verified package metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-ipa-inspection-'));
  try {
    const ipaPath = path.join(root, 'app.ipa');
    const archive = new AdmZip();
    archive.addFile('Payload/Example.app/Info.plist', Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleExecutable</key><string>Example</string><key>CFBundleShortVersionString</key><string>1.2</string><key>CFBundleVersion</key><string>42</string></dict></plist>'));
    archive.addFile('Payload/Example.app/Example', machO());
    archive.writeZip(ipaPath);
    const inspection = await inspectIpaInIsolatedProcess(ipaPath);

    expect(inspection.metadata.infoPlist.CFBundleIdentifier).toBe('com.example.app');
    expect(inspection.metadata.summary).toMatchObject({ shortVersion: '1.2', bundleVersion: '42' });
    expect(inspection.verification).toMatchObject({ primaryExecutable: 'Payload/Example.app/Example', primaryEncrypted: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

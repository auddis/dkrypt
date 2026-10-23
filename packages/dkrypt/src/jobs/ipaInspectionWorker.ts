import { extractIpaMetadata } from '#util/ipaMetadata.js';
import { verifyIpaFairPlayDecrypted } from '#util/ipaFairPlay.js';

const ipaPath = process.argv[2];

if (!ipaPath) {
  process.stderr.write('IPA path is required');
  process.exitCode = 1;
} else {
  try {
    const [metadata, verification] = await Promise.all([
      extractIpaMetadata(ipaPath),
      Promise.resolve(verifyIpaFairPlayDecrypted(ipaPath)),
    ]);
    process.stdout.write(JSON.stringify({ metadata, verification }));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

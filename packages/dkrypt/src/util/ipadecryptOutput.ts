export interface IpaDecryptOutputClassification {
  encryptedPaths: string[];
  extensionOnly: boolean;
  warnings: string[];
  error?: string;
}

const ENCRYPTED_PATH_RE = /(?:^|\s)(?:\d+\.\s*)?(Payload\/.+?)\s+still encrypted\s+\(cryptid\s*!=\s*0\)/i;
const GENERIC_ENCRYPTED_PATH_RE = /^\s*(?:\d+\.\s*)?(.+?)\s+still encrypted\s+\(cryptid\s*!=\s*0\)\s*$/i;
const EXTENSION_PATH_RE = /(?:^|\/)(?:Extensions|PlugIns)\/|\.appex(?:\/|$)/i;
const EXPECTED_VERIFY_ERROR_RE = /verify failed|still encrypted|cryptid\s*!=\s*0/i;

function extractEncryptedPath(line: string): string | undefined {
  return line.match(ENCRYPTED_PATH_RE)?.[1]?.trim() ?? line.match(GENERIC_ENCRYPTED_PATH_RE)?.[1]?.trim();
}

export function classifyIpaDecryptOutput(output: string): IpaDecryptOutputClassification {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const encryptedPaths = [...new Set(lines.map(extractEncryptedPath).filter((path): path is string => Boolean(path)))];
  const errorLines = lines.filter((line) => line.includes('[err]'));
  const extensionOnly = encryptedPaths.length > 0
    && encryptedPaths.every((filePath) => EXTENSION_PATH_RE.test(filePath))
    && errorLines.every((line) => EXPECTED_VERIFY_ERROR_RE.test(line));
  const error = [...errorLines].reverse()[0];
  const warnings = extensionOnly
    ? [`Some embedded extensions remained encrypted: ${encryptedPaths.join(', ')}`]
    : [];

  return { encryptedPaths, extensionOnly, warnings, error };
}

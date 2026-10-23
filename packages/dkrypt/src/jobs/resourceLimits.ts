import { existsSync } from 'node:fs';

export function commandWithResourceLimits(
  command: string,
  args: string[],
  memoryMb: number,
  cpuSeconds: number,
): { command: string; args: string[] } {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/prlimit')) return { command, args };
  return {
    command: '/usr/bin/prlimit',
    args: [`--as=${memoryMb * 1024 * 1024}`, `--cpu=${cpuSeconds}`, '--', command, ...args],
  };
}

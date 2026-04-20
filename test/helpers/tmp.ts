import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TestDir {
  path: string;
  write(name: string, content: string): Promise<string>;
  read(name: string): Promise<string>;
  exists(name: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

export async function createTestDir(prefix = "am-test-"): Promise<TestDir> {
  // REV-4 LOW-1 / REV-3 Windows portability: use node:path everywhere so the
  // helper works on both POSIX and Windows. Previously `write()` sliced on a
  // literal `/` and spawned `mkdir -p` which are both POSIX-only.
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async write(name: string, content: string) {
      const filePath = join(path, name);
      const dir = dirname(filePath);
      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, content);
      return filePath;
    },
    async read(name: string) {
      return Bun.file(join(path, name)).text();
    },
    async exists(name: string) {
      return Bun.file(join(path, name)).exists();
    },
    async cleanup() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

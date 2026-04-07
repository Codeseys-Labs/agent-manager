import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestDir {
  path: string;
  write(name: string, content: string): Promise<string>;
  read(name: string): Promise<string>;
  exists(name: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

export async function createTestDir(prefix = "am-test-"): Promise<TestDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async write(name: string, content: string) {
      const filePath = join(path, name);
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      await Bun.spawn(["mkdir", "-p", dir]).exited;
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

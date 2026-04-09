import { afterEach, describe, expect, test } from "bun:test";
import { type TestDir, createTestDir } from "./tmp";

describe("TestDir helper", () => {
  let dir: TestDir;
  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("creates temp dir and writes/reads files", async () => {
    dir = await createTestDir();
    await dir.write("test.txt", "hello");
    expect(await dir.exists("test.txt")).toBe(true);
    expect(await dir.read("test.txt")).toBe("hello");
  });

  test("creates nested directories automatically", async () => {
    dir = await createTestDir();
    await dir.write("deep/nested/file.json", '{"key": "value"}');
    expect(await dir.exists("deep/nested/file.json")).toBe(true);
  });

  test("cleanup removes everything", async () => {
    dir = await createTestDir();
    const p = dir.path;
    await dir.write("file.txt", "data");
    await dir.cleanup();
    expect(await Bun.file(`${p}/file.txt`).exists()).toBe(false);
  });
});

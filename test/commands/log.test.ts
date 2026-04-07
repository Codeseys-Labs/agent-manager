import { describe, test, expect, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { initRepo, commitAll, log as gitLog } from "../../src/core/git";
import { formatLogEntry } from "../../src/commands/log";
import * as fs from "node:fs";
import { join } from "node:path";

describe("am log", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("formatLogEntry uses + prefix for add messages", () => {
    const entry = {
      oid: "abcdef1234567890abcdef1234567890abcdef12",
      message: "add server: tavily (search, web)",
      author: { name: "am", email: "am@localhost", timestamp: 1712534400 },
    };
    const formatted = formatLogEntry(entry);
    expect(formatted).toStartWith("+ abcdef1");
    expect(formatted).toContain("add server: tavily");
  });

  test("formatLogEntry uses - prefix for remove messages", () => {
    const entry = {
      oid: "1234567890abcdef1234567890abcdef12345678",
      message: "remove server: old-mcp",
      author: { name: "am", email: "am@localhost", timestamp: 1712534400 },
    };
    const formatted = formatLogEntry(entry);
    expect(formatted).toStartWith("- 1234567");
  });

  test("formatLogEntry uses ↓ prefix for import messages", () => {
    const entry = {
      oid: "aabbccdd11223344aabbccdd11223344aabbccdd",
      message: "import: claude-code (15 servers)",
      author: { name: "am", email: "am@localhost", timestamp: 1712534400 },
    };
    const formatted = formatLogEntry(entry);
    expect(formatted).toContain("\u2193");
  });

  test("formatLogEntry uses ↶ prefix for revert messages", () => {
    const entry = {
      oid: "deadbeef12345678deadbeef12345678deadbeef",
      message: "revert: add server: tavily",
      author: { name: "am", email: "am@localhost", timestamp: 1712534400 },
    };
    const formatted = formatLogEntry(entry);
    expect(formatted).toContain("\u21B6");
  });

  test("formatLogEntry uses ● for other messages", () => {
    const entry = {
      oid: "0000111122223333444455556666777788889999",
      message: "init: agent-manager repository",
      author: { name: "am", email: "am@localhost", timestamp: 1712534400 },
    };
    const formatted = formatLogEntry(entry);
    expect(formatted).toContain("\u25CF");
  });
});

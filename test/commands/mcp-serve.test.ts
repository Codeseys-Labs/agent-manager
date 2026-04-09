import { describe, expect, test } from "bun:test";
import { mcpServeCommand } from "../../src/commands/mcp-serve";

describe("mcp-serve command", () => {
  test("meta name is 'mcp-serve'", () => {
    expect(mcpServeCommand.meta?.name).toBe("mcp-serve");
  });

  test("meta has description", () => {
    expect(mcpServeCommand.meta?.description).toBeTruthy();
    expect(typeof mcpServeCommand.meta?.description).toBe("string");
  });
});

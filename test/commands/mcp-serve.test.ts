import { describe, expect, test } from "bun:test";
import { mcpServeCommand } from "../../src/commands/mcp-serve";
import { resolveMeta } from "../helpers/citty";

describe("mcp-serve command", () => {
  test("meta name is 'mcp-serve'", async () => {
    expect((await resolveMeta(mcpServeCommand))?.name).toBe("mcp-serve");
  });

  test("meta has description", async () => {
    expect((await resolveMeta(mcpServeCommand))?.description).toBeTruthy();
    expect(typeof (await resolveMeta(mcpServeCommand))?.description).toBe("string");
  });
});

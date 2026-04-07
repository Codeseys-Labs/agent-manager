import type { Adapter, Capability } from "../types.ts";
import { detect } from "./detect.ts";
import { claudeCodeSchema } from "./schema.ts";

const CAPABILITIES: Capability[] = [
  "mcp",
  "instructions",
  "permissions",
  "models",
  "skills",
  "plugins",
  "agents",
  "hooks",
];

export const claudeCodeAdapter: Adapter = {
  meta: {
    name: "claude-code",
    displayName: "Claude Code",
    version: "0.1.0",
    capabilities: CAPABILITIES,
  },

  detect() {
    return detect();
  },

  import() {
    throw new Error("claude-code adapter: import not implemented");
  },

  export() {
    throw new Error("claude-code adapter: export not implemented");
  },

  diff() {
    throw new Error("claude-code adapter: diff not implemented");
  },

  schema: claudeCodeSchema,
};

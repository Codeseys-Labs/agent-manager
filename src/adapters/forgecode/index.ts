import type {
  Adapter,
  Capability,
  DiffResult,
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  ResolvedConfig,
} from "../types.ts";
import { detect } from "./detect.ts";
import { diffConfig } from "./diff.ts";
import { exportConfig } from "./export.ts";
import { importConfig } from "./import.ts";

// CODEX-9 (2026-05-02): removed "agents" capability. The diff.ts and
// export.ts paths do not process config.agents — declaring the capability
// without a working diff path creates the exact gap `am status` is supposed
// to prevent. Re-add "agents" only when the diff/export paths are both
// implemented in the same PR (per the skill-agent-drift plan rule).
const CAPABILITIES: Capability[] = ["mcp", "instructions", "skills", "models"];

export const forgeCodeAdapter: Adapter = {
  meta: {
    name: "forgecode",
    displayName: "ForgeCode",
    version: "0.1.0",
    capabilities: CAPABILITIES,
  },

  detect() {
    return detect();
  },

  import(options: ImportOptions): ImportResult {
    return importConfig(options);
  },

  export(config: ResolvedConfig, options: ExportOptions): Promise<ExportResult> {
    return exportConfig(config, options);
  },

  diff(config: ResolvedConfig): DiffResult {
    return diffConfig(config);
  },
};

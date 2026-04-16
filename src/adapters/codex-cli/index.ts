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
import { codexCliSchema } from "./schema.ts";
import { createCodexSessionReader } from "./session.ts";

const CAPABILITIES: Capability[] = ["mcp", "instructions", "permissions", "agents"];

export const codexCliAdapter: Adapter = {
  meta: {
    name: "codex-cli",
    displayName: "Codex CLI",
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

  schema: codexCliSchema,

  sessionReader: createCodexSessionReader(),
};

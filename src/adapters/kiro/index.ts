import type {
  Adapter,
  Capability,
  ImportOptions,
  ImportResult,
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  DiffResult,
} from "../types.ts";
import { detect } from "./detect.ts";
import { importConfig } from "./import.ts";
import { exportConfig } from "./export.ts";
import { diffConfig } from "./diff.ts";
import { kiroSchema } from "./schema.ts";

const CAPABILITIES: Capability[] = [
  "mcp",
  "instructions",
  "skills",
  "agents",
];

export const kiroAdapter: Adapter = {
  meta: {
    name: "kiro",
    displayName: "Kiro",
    version: "0.1.0",
    capabilities: CAPABILITIES,
  },

  detect() {
    return detect();
  },

  import(options: ImportOptions): ImportResult {
    return importConfig(options);
  },

  export(config: ResolvedConfig, options: ExportOptions): ExportResult {
    return exportConfig(config, options);
  },

  diff(config: ResolvedConfig): DiffResult {
    return diffConfig(config);
  },

  schema: kiroSchema,
};

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
import { kiloCodeSchema } from "./schema.ts";

const CAPABILITIES: Capability[] = [
  "mcp",
  "instructions",
  "skills",
  "agents",
  "modes",
];

export const kiloCodeAdapter: Adapter = {
  meta: {
    name: "kilo-code",
    displayName: "Kilo Code",
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

  schema: kiloCodeSchema,
};

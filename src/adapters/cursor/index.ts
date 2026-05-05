import { scanVSCodeExtensions } from "../shared/marketplace-vscode.ts";
import type {
  Adapter,
  Capability,
  DiffResult,
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  MarketplaceResult,
  ResolvedConfig,
} from "../types.ts";
import { detect } from "./detect.ts";
import { diffConfig } from "./diff.ts";
import { exportConfig } from "./export.ts";
import { importConfig } from "./import.ts";

const CAPABILITIES: Capability[] = ["mcp", "instructions", "agents", "marketplace"];

export const cursorAdapter: Adapter = {
  meta: {
    name: "cursor",
    displayName: "Cursor",
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


  scanMarketplace(): MarketplaceResult {
    return scanVSCodeExtensions("cursor");
  },
};

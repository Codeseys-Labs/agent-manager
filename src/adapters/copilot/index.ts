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
import { createCopilotSessionReader } from "./session.ts";

const CAPABILITIES: Capability[] = ["mcp", "instructions", "marketplace"];

export const copilotAdapter: Adapter = {
  meta: {
    name: "copilot",
    displayName: "GitHub Copilot",
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

  sessionReader: createCopilotSessionReader(),

  scanMarketplace(): MarketplaceResult {
    return scanVSCodeExtensions("copilot");
  },
};

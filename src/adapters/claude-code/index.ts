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
import { scanClaudePlugins } from "./marketplace.ts";
import { createClaudeCodeSessionReader } from "./session.ts";

const CAPABILITIES: Capability[] = [
  "mcp",
  "instructions",
  "permissions",
  "models",
  "skills",
  "plugins",
  "agents",
  "hooks",
  "marketplace",
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

  import(options: ImportOptions): ImportResult {
    return importConfig(options);
  },

  export(config: ResolvedConfig, options: ExportOptions): Promise<ExportResult> {
    return exportConfig(config, options);
  },

  diff(config: ResolvedConfig): DiffResult {
    return diffConfig(config);
  },

  sessionReader: createClaudeCodeSessionReader(),

  scanMarketplace(): MarketplaceResult {
    return scanClaudePlugins();
  },
};

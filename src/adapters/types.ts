import type { z } from "zod";
import type { SessionReader } from "../core/session.ts";

// ── Capabilities ─────────────────────────────────────────────────

export type Capability =
  | "mcp"
  | "instructions"
  | "permissions"
  | "models"
  | "skills"
  | "plugins"
  | "agents"
  | "hooks"
  | "modes"
  | "marketplace";

// ── Adapter Metadata ─────────────────────────────────────────────

export interface AdapterMeta {
  name: string;
  displayName: string;
  version: string;
  capabilities: Capability[];
}

// ── Detection ────────────────────────────────────────────────────

export interface DetectResult {
  installed: boolean;
  version?: string;
  paths: Record<string, string>;
}

// ── Import ───────────────────────────────────────────────────────

export interface ImportOptions {
  projectPath?: string;
  entities?: ("servers" | "instructions" | "skills")[];
}

export interface ImportedServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "streamable-http" | "sse";
  description?: string;
  tags?: string[];
  enabled?: boolean;
  packageId?: string;
  adapterExtras?: Record<string, unknown>;
  scope: "global" | "project";
}

export interface ImportedInstruction {
  name: string;
  content: string;
  scope: "always" | "glob" | "agent-decision" | "manual";
  description?: string;
  sourcePath?: string;
}

export interface ImportedSkill {
  name: string;
  path: string;
  description?: string;
}

export interface ImportResult {
  servers: ImportedServer[];
  instructions: ImportedInstruction[];
  skills: ImportedSkill[];
  warnings: string[];
}

// ── Export ────────────────────────────────────────────────────────

export interface ExportOptions {
  projectPath?: string;
  dryRun?: boolean;
}

export interface WrittenFile {
  path: string;
  content: string;
  written: boolean;
}

export interface ExportResult {
  files: WrittenFile[];
  warnings: string[];
}

// ── Diff ─────────────────────────────────────────────────────────

export interface DiffChange {
  entity: "server" | "instruction" | "skill" | "agent" | "setting";
  name: string;
  type: "added-locally" | "removed-locally" | "modified" | "added-in-config";
  details?: { field: string; expected: unknown; actual: unknown }[];
}

export interface DiffResult {
  status: "in-sync" | "drifted" | "unmanaged";
  changes: DiffChange[];
}

// ── Resolved Config (input to export/diff) ───────────────────────

export interface ResolvedServer {
  name: string;
  command: string;
  url?: string;
  args: string[];
  env: Record<string, string>;
  transport: "stdio" | "streamable-http" | "sse";
  description: string;
  tags: string[];
  enabled: boolean;
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedInstruction {
  name: string;
  content: string;
  scope: "always" | "glob" | "agent-decision" | "manual";
  globs: string[];
  description: string;
  targets: string[];
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedSkill {
  name: string;
  path: string;
  description: string;
  tags: string[];
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedAgent {
  name: string;
  description: string;
  subagent_type: string;
  prompt: string;
  prompt_file: string;
  model: string;
  tools: string[];
  disallowed_tools: string[];
  mcp_servers: string[];
  max_turns: number | undefined;
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedConfig {
  servers: Record<string, ResolvedServer>;
  instructions: Record<string, ResolvedInstruction>;
  skills: Record<string, ResolvedSkill>;
  agents: Record<string, ResolvedAgent>;
  profile: string;
  adapters: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

// ── Adapter Schema (Zod-based validation) ────────────────────────

export interface AdapterSchema {
  server?: z.ZodType;
  instruction?: z.ZodType;
  global?: z.ZodType;
}

// ── Adapter Interface ────────────────────────────────────────────

// ── Marketplace ─────────────────────────────────────────────────

export type MarketplaceSource =
  | "claude-plugin"
  | "vscode-extension"
  | "cursor-extension"
  | "kiro-extension"
  | "windsurf-extension";

export interface MarketplaceMetadata {
  publisher?: string;
  repository?: string;
  installPath: string;
  manifestPath: string;
}

export interface MarketplaceItem {
  id: string;
  name: string;
  version: string;
  source: MarketplaceSource;
  servers: ImportedServer[];
  skills: ImportedSkill[];
  metadata: MarketplaceMetadata;
}

export interface MarketplaceResult {
  items: MarketplaceItem[];
  warnings: string[];
}

// ── Adapter Interface ────────────────────────────────────────────

export interface Adapter {
  meta: AdapterMeta;
  detect(): DetectResult;
  import(options: ImportOptions): ImportResult;
  export(config: ResolvedConfig, options: ExportOptions): ExportResult | Promise<ExportResult>;
  diff(config: ResolvedConfig): DiffResult;
  schema: AdapterSchema;
  sessionReader?: SessionReader;
  scanMarketplace?(): MarketplaceResult;
}

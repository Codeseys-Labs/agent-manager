import type {
  ResolvedAgent,
  ResolvedConfig,
  ResolvedInstruction,
  ResolvedServer,
  ResolvedSkill,
} from "../core/resolved.ts";
import type { SessionReader } from "../core/session.ts";

// Re-export the Resolved* family so existing adapter imports from this barrel
// keep working. These types live in core (the producer); adapters consume them.
// See ADR P2-A — the dependency direction is strictly adapters → core.
export type { ResolvedAgent, ResolvedConfig, ResolvedInstruction, ResolvedServer, ResolvedSkill };

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

/**
 * A single drift change surfaced by an adapter's `diff()`.
 *
 * `entity` is narrowed to the two entity kinds adapters actually emit
 * (P2-D, wave 8): every adapter diffs `server`, and the marker-based
 * instruction adapters (claude-code, codex-cli, cursor, kilo-code) additionally
 * diff `instruction` via {@link "./shared/diff-utils".compareInstructions}.
 *
 * Instruction-drift coverage is therefore PARTIAL for v1: adapters that emit
 * instructions but do not yet wire `compareInstructions` (amazon-q, cline,
 * continue, copilot, gemini-cli, kiro, roo-code, windsurf) report only server
 * drift, so a hand-edited rule file in those tools will not be flagged. Full
 * per-adapter instruction-drift coverage is tracked as v1.x follow-up.
 *
 * `skill` / `agent` / `setting` were advertised here but never emitted by any
 * adapter; they were removed rather than ship a union no producer satisfies. If
 * a future adapter diffs those entities, re-add the variant alongside the
 * producing code.
 */
export interface DiffChange {
  entity: "server" | "instruction";
  name: string;
  type: "added-locally" | "removed-locally" | "modified" | "added-in-config";
  details?: { field: string; expected: unknown; actual: unknown }[];
}

export interface DiffResult {
  status: "in-sync" | "drifted" | "unmanaged";
  changes: DiffChange[];
}

// ── Adapter Schema (Zod-based validation) ────────────────────────
//
// Removed 2026-05-05 per ADR-0041 (Phase 2 of ADR-0007 was never wired in
// 13 months of production). The `AdapterSchema` interface and the
// `Adapter.schema` field have been deleted. If a future use case requires
// per-adapter validation of `[entity.adapters.<name>]` subtables, re-add
// the field narrowly and see ADR-0041 for the re-introduction path.

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
  detect(): DetectResult | Promise<DetectResult>;
  import(options: ImportOptions): ImportResult | Promise<ImportResult>;
  export(config: ResolvedConfig, options: ExportOptions): ExportResult | Promise<ExportResult>;
  diff(config: ResolvedConfig): DiffResult | Promise<DiffResult>;
  sessionReader?: SessionReader;
  scanMarketplace?(): MarketplaceResult;
}

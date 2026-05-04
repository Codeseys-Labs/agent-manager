/**
 * `am mcp superset check|apply` — issue #3 problem 1.
 *
 * Enforces a project-scoped MCP config is a SUPERSET of the global
 * catalog. For each server in global.mcpServers, classify into one of
 * four copy classes (per docs/research/2026-05-03-mcp-superset-prior-art.md):
 *
 *   - "copy":   stdio-with-command OR HTTP-with-env-auth → safe to mirror
 *               verbatim into the project config.
 *   - "refuse": HTTP with URL-embedded credential → will NOT be copied;
 *               emit remediation suggesting ${VAR} substitution.
 *   - "skip":   disabled-in-global → not a superset requirement.
 *   - "rewrite": reserved for future --auto-rewrite (unused in MVP).
 *
 * Exit-code protocol (chezmoi + git-push style, per research report §2.1):
 *   0 — superset satisfied
 *   1 — drift (at least one "copy" class entry missing from project)
 *   2 — refusal (at least one "refuse" class entry; distinct from 1 so
 *        CI can route security findings separately)
 *   3 — input error (file missing / malformed JSON)
 *   --strict collapses 2 → 1 for callers that treat any non-zero as fail
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { scanUrlForCredentials } from "../core/url-credentials";
import { errorMessage } from "../lib/errors";
import { error, info, output } from "../lib/output";

// ── Types ────────────────────────────────────────────────────────────────────

interface McpServerShape {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disabled?: boolean;
  enabled?: boolean;
  headers?: Record<string, string>;
}

type CopyClass = "copy" | "refuse" | "skip" | "rewrite";

interface ClassifyResult {
  class: CopyClass;
  sourceShape:
    | "stdio"
    | "http-env-bearer"
    | "http-url-credential"
    | "disabled-in-global"
    | "unknown";
  reason: string;
  remediation?: {
    kind: "rotate-to-env-var";
    suggestedEnvVar: string;
    rewritePreview?: string;
  };
  redactedDetectedPattern?: string;
}

interface SupersetEntry {
  name: string;
  class: CopyClass;
  sourceShape: ClassifyResult["sourceShape"];
  reason: string;
  inProject: boolean;
  action: "add" | "none" | "refuse";
  details?: Record<string, unknown>;
  remediation?: ClassifyResult["remediation"];
  redactedDetectedPattern?: string;
}

interface SupersetReport {
  schema_version: 1;
  command: "mcp superset check" | "mcp superset apply";
  global_source: string;
  project_target: string;
  summary: {
    total_global_enabled: number;
    in_project: number;
    to_copy: number;
    to_rewrite: number;
    to_refuse: number;
    skipped_disabled: number;
  };
  entries: SupersetEntry[];
  exit_code: 0 | 1 | 2 | 3;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a single server by its shape. Pure function — no disk IO, no
 * network. Exported for unit testing.
 */
export function classifyServer(name: string, server: McpServerShape): ClassifyResult {
  // Disabled-in-global → not a superset requirement.
  if (server.disabled === true || server.enabled === false) {
    return {
      class: "skip",
      sourceShape: "disabled-in-global",
      reason: "disabled: true in global; not a superset requirement",
    };
  }

  // Collect every URL this server carries (url field + http(s) command).
  const urls: string[] = [];
  if (server.url && /^https?:\/\//i.test(server.url)) urls.push(server.url);
  if (server.command && /^https?:\/\//i.test(server.command)) urls.push(server.command);
  for (const arg of server.args ?? []) {
    if (typeof arg === "string" && /^https?:\/\//i.test(arg)) urls.push(arg);
  }

  // URL-embedded credential → refuse.
  for (const url of urls) {
    const hits = scanUrlForCredentials(url);
    if (hits.length > 0) {
      const hit = hits[0];
      return {
        class: "refuse",
        sourceShape: "http-url-credential",
        reason: `URL query parameter ${hit.queryKey}= contains embedded credential`,
        remediation: {
          kind: "rotate-to-env-var",
          suggestedEnvVar: hit.suggestedEnvVar,
          rewritePreview: url.replace(
            `${hit.queryKey}=${hit.redactedValue}`.slice(0, -1),
            `${hit.queryKey}=${hit.suggestedEnvVar}`,
          ),
        },
        redactedDetectedPattern: `${hit.queryKey}=${hit.redactedValue.replace(/[^…]+…?/, (m) => `${m.slice(0, 4)}****`)}`,
      };
    }
  }

  // HTTP with Authorization header pointing at env var → copy verbatim.
  const hasHttpAuth =
    (server.type === "http" || urls.length > 0) &&
    (server.headers?.Authorization?.includes("${") ||
      server.headers?.authorization?.includes("${") ||
      Object.values(server.env ?? {}).some((v) => v.includes("${")));
  if (urls.length > 0 && hasHttpAuth) {
    return {
      class: "copy",
      sourceShape: "http-env-bearer",
      reason: "HTTP with env-var Authorization; safe to mirror verbatim",
    };
  }

  // stdio-with-command → copy verbatim.
  if (server.command && !/^https?:\/\//i.test(server.command)) {
    return {
      class: "copy",
      sourceShape: "stdio",
      reason: "stdio-with-command; safe to mirror verbatim",
    };
  }

  // HTTP without credentials or auth → still copy (server is public).
  if (urls.length > 0) {
    return {
      class: "copy",
      sourceShape: "http-env-bearer",
      reason: "HTTP URL without detected credentials; safe to mirror verbatim",
    };
  }

  return {
    class: "skip",
    sourceShape: "unknown",
    reason: "Unknown server shape; skipping",
  };
}

// ── Build the report ────────────────────────────────────────────────────────

/**
 * Build the superset report given parsed global + project mcpServers maps.
 * Pure function; exported for tests.
 */
export function buildSupersetReport(
  global: Record<string, McpServerShape>,
  project: Record<string, McpServerShape>,
  opts: { globalSource: string; projectTarget: string; command: SupersetReport["command"] },
): SupersetReport {
  const entries: SupersetEntry[] = [];
  let totalEnabled = 0;
  let toCopy = 0;
  let toRefuse = 0;
  let skipped = 0;
  let inProject = 0;

  for (const [name, server] of Object.entries(global)) {
    const cls = classifyServer(name, server);
    const present = Object.hasOwn(project, name);
    if (cls.class !== "skip") totalEnabled++;
    if (cls.class === "skip") skipped++;

    let action: SupersetEntry["action"] = "none";
    if (cls.class === "refuse") {
      action = "refuse";
      toRefuse++;
    } else if (cls.class === "copy" && !present) {
      action = "add";
      toCopy++;
    } else if (cls.class === "copy" && present) {
      inProject++;
    }

    entries.push({
      name,
      class: cls.class,
      sourceShape: cls.sourceShape,
      reason: cls.reason,
      inProject: present,
      action,
      details:
        cls.class === "copy" && !present
          ? {
              command: server.command,
              args: server.args,
              env: server.env,
              url: server.url,
            }
          : cls.class === "copy" && present
            ? { already_in_sync: true }
            : undefined,
      remediation: cls.remediation,
      redactedDetectedPattern: cls.redactedDetectedPattern,
    });
  }

  const exitCode: SupersetReport["exit_code"] = toRefuse > 0 ? 2 : toCopy > 0 ? 1 : 0;

  return {
    schema_version: 1,
    command: opts.command,
    global_source: opts.globalSource,
    project_target: opts.projectTarget,
    summary: {
      total_global_enabled: totalEnabled,
      in_project: inProject,
      to_copy: toCopy,
      to_rewrite: 0,
      to_refuse: toRefuse,
      skipped_disabled: skipped,
    },
    entries,
    exit_code: exitCode,
  };
}

// ── IO ──────────────────────────────────────────────────────────────────────

async function readMcpFile(path: string): Promise<Record<string, McpServerShape>> {
  const text = await readFile(path, "utf-8");
  const parsed = JSON.parse(text) as { mcpServers?: Record<string, McpServerShape> };
  return parsed.mcpServers ?? {};
}

async function writeProjectWithSuperset(
  path: string,
  copyEntries: SupersetEntry[],
  globalMap: Record<string, McpServerShape>,
): Promise<number> {
  const existing = JSON.parse(await readFile(path, "utf-8").catch(() => "{}"));
  const projectServers = (existing.mcpServers ?? {}) as Record<string, McpServerShape>;
  let added = 0;
  for (const entry of copyEntries) {
    if (entry.action !== "add") continue;
    projectServers[entry.name] = globalMap[entry.name];
    added++;
  }
  const next = { ...existing, mcpServers: projectServers };
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return added;
}

// ── Command surface ─────────────────────────────────────────────────────────

function defaultGlobalPath(): string {
  return join(homedir(), ".claude.json");
}

function defaultProjectPath(): string {
  return join(process.cwd(), ".mcp.json");
}

export const mcpSupersetCommand = defineCommand({
  meta: {
    name: "superset",
    description: "Enforce project .mcp.json is a superset of global ~/.claude.json (issue #3)",
  },
  subCommands: {
    check: () => Promise.resolve(checkSubcommand),
    apply: () => Promise.resolve(applySubcommand),
  },
});

export const checkSubcommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Audit: report divergence between global and project MCP configs (nonzero exit on drift)",
  },
  args: {
    global: {
      type: "string",
      description: "Path to global MCP config (default: ~/.claude.json)",
    },
    project: { type: "string", description: "Path to project MCP config (default: ./.mcp.json)" },
    strict: {
      type: "boolean",
      description: "Collapse refuse (2) → drift (1) for binary CI gates",
      default: false,
    },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const globalPath = resolve(String(args.global ?? defaultGlobalPath()));
    const projectPath = resolve(String(args.project ?? defaultProjectPath()));

    let global: Record<string, McpServerShape>;
    let project: Record<string, McpServerShape>;
    try {
      global = await readMcpFile(globalPath);
    } catch (e) {
      error(`Cannot read global config at ${globalPath}: ${errorMessage(e)}`, opts);
      process.exitCode = 3;
      return;
    }
    try {
      project = await readMcpFile(projectPath);
    } catch {
      project = {}; // absent project is fine — report as all-missing
    }

    const report = buildSupersetReport(global, project, {
      globalSource: globalPath,
      projectTarget: projectPath,
      command: "mcp superset check",
    });

    if (args.json) {
      output(report, opts);
    } else {
      const s = report.summary;
      info(`Global enabled: ${s.total_global_enabled} · in project: ${s.in_project}`, opts);
      if (s.to_copy > 0) info(`  ${s.to_copy} server(s) need to be copied into project`, opts);
      if (s.to_refuse > 0) {
        info(`  ${s.to_refuse} server(s) REFUSED (URL credential leak — see --json)`, opts);
      }
      if (s.skipped_disabled > 0) info(`  ${s.skipped_disabled} skipped (disabled)`, opts);
      for (const e of report.entries) {
        if (e.class === "refuse") {
          error(`  refuse: ${e.name} — ${e.reason}`, opts);
          if (e.remediation?.suggestedEnvVar) {
            info(`    → rotate to ${e.remediation.suggestedEnvVar}`, opts);
          }
        } else if (e.action === "add") {
          info(`  drift: ${e.name} needed in project`, opts);
        }
      }
    }

    const exit = report.exit_code;
    process.exitCode = args.strict && exit === 2 ? 1 : exit;
  },
});

export const applySubcommand = defineCommand({
  meta: {
    name: "apply",
    description:
      "Reconcile: copy missing servers from global into project (refuses URL-credential-bearing entries)",
  },
  args: {
    global: { type: "string" },
    project: { type: "string" },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    "dry-run": {
      type: "boolean",
      description: "Preview changes without writing",
      default: false,
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const globalPath = resolve(String(args.global ?? defaultGlobalPath()));
    const projectPath = resolve(String(args.project ?? defaultProjectPath()));
    const dryRun = args["dry-run"] as boolean;

    let global: Record<string, McpServerShape>;
    let project: Record<string, McpServerShape>;
    try {
      global = await readMcpFile(globalPath);
    } catch (e) {
      error(`Cannot read global: ${errorMessage(e)}`, opts);
      process.exitCode = 3;
      return;
    }
    try {
      project = await readMcpFile(projectPath);
    } catch {
      project = {};
    }

    const report = buildSupersetReport(global, project, {
      globalSource: globalPath,
      projectTarget: projectPath,
      command: "mcp superset apply",
    });

    let added = 0;
    if (!dryRun && report.summary.to_copy > 0) {
      added = await writeProjectWithSuperset(projectPath, report.entries, global);
    }

    if (args.json) {
      output({ ...report, applied: !dryRun, added }, opts);
    } else {
      if (dryRun) {
        info(`Dry run: would copy ${report.summary.to_copy} server(s) into ${projectPath}`, opts);
      } else if (added > 0) {
        info(`Copied ${added} server(s) into ${projectPath}`, opts);
      } else {
        info("Nothing to apply.", opts);
      }
      if (report.summary.to_refuse > 0) {
        error(
          `${report.summary.to_refuse} server(s) REFUSED — their URL carries embedded credentials. Rotate to \${VAR} first.`,
          opts,
        );
      }
    }

    // Exit 2 if anything refused (even in --apply); apply does NOT rewrite.
    process.exitCode = report.exit_code === 2 ? 2 : 0;
  },
});

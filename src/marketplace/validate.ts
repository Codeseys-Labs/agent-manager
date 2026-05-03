/**
 * `am marketplace validate <path>` — static validator for marketplace repos.
 *
 * Parses every discoverable `plugin.json` under a local path (file://-style,
 * no cloning) and reports structural issues WITHOUT side effects. Unlike the
 * installer, this runs offline against an uncloned working tree, which is
 * what marketplace authors need before pushing.
 *
 * Checks performed:
 *   1. Scan finds ≥1 plugin. Zero plugins = hard error (misconfigured layout).
 *   2. Each `plugin.json` parses as JSON and conforms to PluginManifestSchema
 *      (Zod — see `./schema.ts`). Missing `name`/`description` is a hard error.
 *   3. No two plugins share a `name` (duplicates would overwrite each other
 *      at install time).
 *   4. Every `prompt_file` path inside `agents.*.prompt_file` resolves to a
 *      file that exists relative to the plugin directory.
 *   5. `skills[]` entries resolve to existing files.
 *
 * Exit semantics:
 *   - 0 errors + 0 warnings → valid.
 *   - Any errors → invalid (exit 1 from CLI).
 *   - Warnings do not fail the validation but are surfaced.
 *
 * ADR reference: this is B3-full from
 * `docs/research/2026-05-02-all-pillars-review/04-marketplace.md §6.1` and the
 * tracking stub at `docs/plans/deferred-pillar-review-items.md`.
 */

import * as fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { scanMarketplace } from "./scanner";
import { PluginManifestSchema } from "./schema";
import type { DiscoveredPlugin } from "./types";

export interface ValidateIssue {
  severity: "error" | "warning";
  plugin?: string;
  manifestPath?: string;
  field?: string;
  message: string;
}

export interface ValidateResult {
  path: string;
  pluginsFound: number;
  valid: boolean;
  issues: ValidateIssue[];
}

/**
 * Validate a marketplace at the given local path.
 *
 * The `path` argument is the marketplace's repo root (NOT a plugin
 * subdirectory). Scanner semantics match the installer: it checks `plugins/`
 * and top-level directories.
 */
export async function validateMarketplace(path: string): Promise<ValidateResult> {
  const issues: ValidateIssue[] = [];
  const absPath = isAbsolute(path) ? path : resolve(process.cwd(), path);

  // 0. Path must exist + be a directory.
  try {
    const stat = await fs.promises.stat(absPath);
    if (!stat.isDirectory()) {
      return {
        path: absPath,
        pluginsFound: 0,
        valid: false,
        issues: [
          {
            severity: "error",
            message: `${absPath} is not a directory`,
          },
        ],
      };
    }
  } catch {
    return {
      path: absPath,
      pluginsFound: 0,
      valid: false,
      issues: [
        {
          severity: "error",
          message: `${absPath} does not exist`,
        },
      ],
    };
  }

  // 1. Discover plugins via the same scanner the installer uses.
  // Passing a synthetic marketplace name is fine — it only shows up in the
  // DiscoveredPlugin.marketplace field which we don't rely on here.
  const discovered = await scanMarketplace("<validate>", absPath);

  if (discovered.length === 0) {
    issues.push({
      severity: "error",
      message:
        "No plugins found. Expected at least one directory with .am-plugin/plugin.json or .claude-plugin/plugin.json. See docs/marketplace-author-guide.md §Repository layout.",
    });
    return { path: absPath, pluginsFound: 0, valid: false, issues };
  }

  // 2. Per-plugin manifest validation + referenced-file checks.
  const names = new Map<string, string[]>(); // name -> [manifestPath, ...]
  for (const plugin of discovered) {
    await validateSinglePlugin(plugin, issues);
    const existing = names.get(plugin.manifest.name) ?? [];
    existing.push(plugin.manifestPath);
    names.set(plugin.manifest.name, existing);
  }

  // 3. Duplicate-name detection.
  for (const [name, paths] of names.entries()) {
    if (paths.length > 1) {
      issues.push({
        severity: "error",
        plugin: name,
        message: `Plugin name "${name}" is declared in ${paths.length} manifests: ${paths.join(", ")}. Install would clobber all but the first.`,
      });
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  return {
    path: absPath,
    pluginsFound: discovered.length,
    valid: !hasErrors,
    issues,
  };
}

async function validateSinglePlugin(
  plugin: DiscoveredPlugin,
  issues: ValidateIssue[],
): Promise<void> {
  const { manifest, pluginDir, manifestPath } = plugin;

  // 2a. Schema validation.
  const parsed = PluginManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        severity: "error",
        plugin: manifest.name,
        manifestPath,
        field: issue.path.join(".") || "(root)",
        message: issue.message,
      });
    }
    // If schema fails, skip file-reference checks — the shapes are unreliable.
    return;
  }

  // 2b. Skills files exist.
  for (const skillPath of manifest.skills ?? []) {
    const full = isAbsolute(skillPath) ? skillPath : join(pluginDir, skillPath);
    try {
      await fs.promises.access(full);
    } catch {
      issues.push({
        severity: "error",
        plugin: manifest.name,
        manifestPath,
        field: `skills: ${skillPath}`,
        message: `Skill file not found at ${full}`,
      });
    }
  }

  // 2c. Agent prompt_file paths exist.
  for (const [agentKey, agentCfg] of Object.entries(manifest.agents ?? {})) {
    if (!agentCfg.prompt_file) continue;
    const full = isAbsolute(agentCfg.prompt_file)
      ? agentCfg.prompt_file
      : join(pluginDir, agentCfg.prompt_file);
    try {
      await fs.promises.access(full);
    } catch {
      issues.push({
        severity: "error",
        plugin: manifest.name,
        manifestPath,
        field: `agents.${agentKey}.prompt_file`,
        message: `Prompt file not found at ${full}`,
      });
    }
  }

  // 2d. Warn if neither prompt nor prompt_file is set for an agent.
  for (const [agentKey, agentCfg] of Object.entries(manifest.agents ?? {})) {
    if (!agentCfg.prompt && !agentCfg.prompt_file) {
      issues.push({
        severity: "warning",
        plugin: manifest.name,
        manifestPath,
        field: `agents.${agentKey}`,
        message: "Agent has neither prompt nor prompt_file; will be empty at runtime",
      });
    }
  }

  // 2e. Warn on `@latest` in server args (supply-chain risk).
  for (const [serverKey, serverCfg] of Object.entries(manifest.servers ?? {})) {
    for (const arg of serverCfg.args ?? []) {
      if (typeof arg === "string" && arg.endsWith("@latest")) {
        issues.push({
          severity: "warning",
          plugin: manifest.name,
          manifestPath,
          field: `servers.${serverKey}.args`,
          message: `Pins "@latest" — users get unreviewed upstream changes. Prefer a pinned version (see docs/marketplace-author-guide.md §Security expectations).`,
        });
        break; // one warning per server, not per arg
      }
    }
  }

  // 2f. Warn if manifest has `adapter` field (community adapter) — most
  // plugins should NOT use this; it's a per-plugin override. Docs flag this
  // explicitly.
  if (manifest.adapter) {
    issues.push({
      severity: "warning",
      plugin: manifest.name,
      manifestPath,
      field: "adapter",
      message:
        "Bundles a community adapter. Adapter must be checksum-pinned by the marketplace author; install-time checksum enforcement is separate. Verify with `am adapter verify` after install.",
    });
  }
}

/**
 * Minimal human-readable summary string for CLI output. Machine consumers
 * should use the ValidateResult object directly via --json.
 */
export function formatValidateSummary(result: ValidateResult): string {
  const lines: string[] = [];
  lines.push(`Validating ${result.path}`);
  lines.push(`Plugins found: ${result.pluginsFound}`);
  if (result.issues.length === 0) {
    lines.push("No issues.");
  } else {
    const errors = result.issues.filter((i) => i.severity === "error");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    lines.push(`Errors: ${errors.length}`);
    lines.push(`Warnings: ${warnings.length}`);
    for (const issue of result.issues) {
      const loc = issue.plugin
        ? `[${issue.plugin}${issue.field ? ` · ${issue.field}` : ""}]`
        : "[marketplace]";
      lines.push(`  ${issue.severity.toUpperCase()} ${loc} ${issue.message}`);
    }
  }
  lines.push(result.valid ? "VALID" : "INVALID");
  return lines.join("\n");
}

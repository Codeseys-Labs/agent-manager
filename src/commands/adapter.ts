import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  getCommunityAdapterConfig,
  listCommunityAdapterNames,
  readAdaptersToml,
  removeCommunityAdapterConfig,
  setCommunityAdapterConfig,
  writeAdaptersToml,
} from "../adapters/community/loader";
import { CommunityAdapterProxy } from "../adapters/community/proxy";
import type { CommunityAdapterConfig } from "../adapters/community/types";
import { getAdapter, isBuiltInAdapter, listAllAdapters } from "../adapters/registry";
import { resolveConfigDir } from "../core/config";
import { commitAll } from "../core/git";
import { amError, debug, error, info, output } from "../lib/output";

// ── list ───────────────────────────────────────────────────────────

const listSubcommand = defineCommand({
  meta: { name: "list", description: "Show all registered adapters" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const names = await listAllAdapters();

    const rows: Array<{
      name: string;
      displayName: string;
      capabilities: string[];
      installed: boolean;
      version?: string;
      source: string;
    }> = [];

    for (const name of names) {
      const adapter = await getAdapter(name);
      if (!adapter) continue;
      const detect = await adapter.detect();
      rows.push({
        name: adapter.meta.name,
        displayName: adapter.meta.displayName,
        capabilities: adapter.meta.capabilities,
        installed: detect.installed,
        version: detect.version,
        source: isBuiltInAdapter(name) ? "built-in" : "community",
      });
    }

    if (args.json) {
      output({ adapters: rows }, opts);
      return;
    }

    info(
      `${"Name".padEnd(16)} ${"Display Name".padEnd(20)} ${"Source".padEnd(12)} ${"Capabilities".padEnd(30)} ${"Detected"}`,
      opts,
    );
    info(
      `${"─".repeat(16)} ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(30)} ${"─".repeat(10)}`,
      opts,
    );
    for (const r of rows) {
      const detected = r.installed ? (r.version ? `yes (${r.version})` : "yes") : "no";
      info(
        `${r.name.padEnd(16)} ${r.displayName.padEnd(20)} ${r.source.padEnd(12)} ${r.capabilities.join(", ").padEnd(30)} ${detected}`,
        opts,
      );
    }
    info(`\n${rows.length} adapter(s)`, opts);
  },
});

// ── install ────────────────────────────────────────────────────────

const installSubcommand = defineCommand({
  meta: { name: "install", description: "Install a community adapter" },
  args: {
    source: {
      type: "positional",
      description: "npm package, git URL, or local path",
      required: true,
    },
    force: { type: "boolean", description: "Force install even if name conflicts", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const source = args.source;
      const configDir = resolveConfigDir();
      const adaptersDir = join(configDir, "adapters");

      // Determine source type and adapter name
      const { name, sourceType, installCmd } = resolveSource(source);

      debug(`Resolved source: name=${name}, type=${sourceType}`, opts);

      // Check for built-in conflict
      if (isBuiltInAdapter(name) && !args.force) {
        error(
          `"${name}" is a built-in adapter. Built-in adapters always take precedence. Use --force to install anyway.`,
          opts,
        );
        process.exitCode = 1;
        return;
      }

      // Check if already installed
      const existing = await getCommunityAdapterConfig(configDir, name);
      if (existing && !args.force) {
        error(`"${name}" is already installed. Use --force to reinstall.`, opts);
        process.exitCode = 1;
        return;
      }

      // Create adapter directory
      const adapterDir = join(adaptersDir, name);
      await mkdir(adapterDir, { recursive: true });

      // Install based on source type
      info(`Installing "${name}" from ${sourceType}...`, opts);

      let command: string;

      if (sourceType === "local") {
        // Local path: resolve and use directly
        const { resolve } = await import("node:path");
        command = resolve(source.replace(/^local:/, ""));
        debug(`Using local adapter at ${command}`, opts);
      } else if (sourceType === "npm") {
        // npm: install package into the adapter directory
        const pkgName = source.replace(/@[\d.]+$/, ""); // strip version for npm install arg
        const installArg = source; // npm handles version in the package specifier
        const proc = Bun.spawn(installCmd, { cwd: adapterDir, stdout: "pipe", stderr: "pipe" });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          error(`npm install failed: ${stderr}`, opts);
          process.exitCode = 1;
          return;
        }
        // Find the bin entry
        command = join(adapterDir, "node_modules", ".bin", `am-adapter-${name}`);
      } else {
        // git: clone into the adapter directory
        const proc = Bun.spawn(installCmd, { cwd: adaptersDir, stdout: "pipe", stderr: "pipe" });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          error(`git clone failed: ${stderr}`, opts);
          process.exitCode = 1;
          return;
        }
        // Run npm install in the cloned directory.
        // --ignore-scripts: cloned repo is untrusted; its package.json
        // lifecycle scripts (preinstall/install/postinstall) must not run
        // on the host before validation + checksum pinning.
        const npmProc = Bun.spawn(["npm", "install", "--production", "--ignore-scripts"], {
          cwd: adapterDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        await npmProc.exited;
        // Assume bin entry follows convention
        command = join(adapterDir, "bin", "adapter.js");
      }

      // Validate: spawn the adapter and check protocol
      info("Validating adapter...", opts);
      let proxy: CommunityAdapterProxy;
      try {
        proxy = await CommunityAdapterProxy.create(command);
      } catch (err) {
        error(`Adapter validation failed: ${err instanceof Error ? err.message : err}`, opts);
        // Clean up
        await rm(adapterDir, { recursive: true, force: true });
        process.exitCode = 1;
        return;
      }

      info(`Verified: ${proxy.meta.displayName} v${proxy.meta.version}`, opts);
      proxy.kill();

      // Capture checksum of the adapter entrypoint. This is what the loader
      // will verify on every subsequent spawn — TOFU-style pinning of the
      // bits we just validated.
      //
      // Exception: `local:` adapters are the user's own code under active
      // development. Recomputing the checksum on every edit would be noise,
      // so we record no checksum and the loader skips the check with a warn.
      let checksum: string | undefined;
      if (sourceType === "local") {
        debug("local adapter: skipping checksum pinning (user-owned source)", opts);
      } else {
        checksum = await computeChecksum(command);
      }

      // Register in adapters.toml
      const config: CommunityAdapterConfig = {
        source: formatSource(source, sourceType),
        command,
        installed_at: new Date().toISOString(),
        ...(checksum ? { checksum } : {}),
      };
      await setCommunityAdapterConfig(configDir, name, config);

      // Auto-commit
      try {
        await commitAll(configDir, `adapter install: ${name}`);
      } catch {
        // Git not initialized or nothing to commit
      }

      if (args.json) {
        output({ action: "install", adapter: name, source: config.source, command }, opts);
      } else {
        info(`\nInstalled "${name}". Run \`am apply\` to generate native configs.`, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

// ── remove ─────────────────────────────────────────────────────────

const removeSubcommand = defineCommand({
  meta: { name: "remove", description: "Remove a community adapter" },
  args: {
    name: { type: "positional", description: "Adapter name", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const name = args.name;
      const configDir = resolveConfigDir();

      if (isBuiltInAdapter(name)) {
        error(`"${name}" is a built-in adapter and cannot be removed.`, opts);
        process.exitCode = 1;
        return;
      }

      const removed = await removeCommunityAdapterConfig(configDir, name);
      if (!removed) {
        error(`Community adapter "${name}" not found.`, opts);
        process.exitCode = 1;
        return;
      }

      // Remove adapter directory
      const adapterDir = join(configDir, "adapters", name);
      await rm(adapterDir, { recursive: true, force: true });

      // Auto-commit
      try {
        await commitAll(configDir, `adapter remove: ${name}`);
      } catch {
        // Git not initialized or nothing to commit
      }

      if (args.json) {
        output({ action: "remove", adapter: name }, opts);
      } else {
        info(`Removed "${name}".`, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

// ── update ─────────────────────────────────────────────────────────

const updateSubcommand = defineCommand({
  meta: { name: "update", description: "Update community adapters" },
  args: {
    name: { type: "positional", description: "Adapter name (omit for all)", required: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const toml = await readAdaptersToml(configDir);
      const names = args.name ? [args.name as string] : Object.keys(toml.adapters);

      if (names.length === 0) {
        info("No community adapters installed.", opts);
        return;
      }

      const results: Array<{ name: string; action: string }> = [];

      for (const name of names) {
        const config = toml.adapters[name];
        if (!config) {
          error(`Adapter "${name}" not found.`, opts);
          results.push({ name, action: "not_found" });
          continue;
        }

        if (config.source.startsWith("local:")) {
          debug(`Skipping local adapter "${name}" — no update mechanism.`, opts);
          results.push({ name, action: "skipped" });
          continue;
        }

        // For npm sources, re-run npm install to get latest.
        // --ignore-scripts: community adapter; lifecycle scripts would run
        // as the user on update without a prompt, giving an attacker a path
        // to RCE via a compromised package version.
        if (config.source.startsWith("npm:")) {
          const adapterDir = join(configDir, "adapters", name);
          const pkg = config.source.replace("npm:", "");
          const proc = Bun.spawn(["npm", "install", pkg, "--ignore-scripts"], {
            cwd: adapterDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            error(`Failed to update "${name}".`, opts);
            results.push({ name, action: "failed" });
            continue;
          }
        }

        // Validate the updated adapter
        try {
          const proxy = await CommunityAdapterProxy.create(config.command);
          info(`Updated "${name}" — ${proxy.meta.displayName} v${proxy.meta.version}`, opts);
          proxy.kill();
          // Re-pin the checksum against the freshly installed bits. Without
          // this, the next load would fail because the hash on disk no
          // longer matches the stored hash.
          const newChecksum = await computeChecksum(config.command);
          await setCommunityAdapterConfig(configDir, name, { ...config, checksum: newChecksum });
          results.push({ name, action: "updated" });
        } catch {
          error(`Adapter "${name}" failed validation after update.`, opts);
          results.push({ name, action: "failed" });
        }
      }

      if (args.json) {
        output({ action: "update", results }, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

// ── verify ─────────────────────────────────────────────────────────

const verifySubcommand = defineCommand({
  meta: { name: "verify", description: "Health-check a community adapter" },
  args: {
    name: { type: "positional", description: "Adapter name", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const name = args.name;
      const configDir = resolveConfigDir();

      const config = await getCommunityAdapterConfig(configDir, name);
      if (!config) {
        error(`Community adapter "${name}" not found.`, opts);
        process.exitCode = 1;
        return;
      }

      info(`Verifying "${name}"...`, opts);
      debug(`Command: ${config.command}`, opts);

      let proxy: CommunityAdapterProxy;
      try {
        proxy = await CommunityAdapterProxy.create(config.command);
      } catch (err) {
        const result = {
          adapter: name,
          status: "error" as const,
          error: err instanceof Error ? err.message : String(err),
        };
        if (args.json) {
          output(result, opts);
        } else {
          error(`Verification failed: ${result.error}`, opts);
        }
        process.exitCode = 1;
        return;
      }

      const meta = proxy.meta;
      const detectResult = await proxy.detect();
      proxy.kill();

      const result = {
        adapter: name,
        status: "ok" as const,
        meta,
        detected: detectResult.installed,
        detectedVersion: detectResult.version,
      };

      if (args.json) {
        output(result, opts);
      } else {
        info(`  Name:         ${meta.name}`, opts);
        info(`  Display Name: ${meta.displayName}`, opts);
        info(`  Version:      ${meta.version}`, opts);
        info(`  Capabilities: ${meta.capabilities.join(", ")}`, opts);
        info(
          `  Detected:     ${detectResult.installed ? `yes${detectResult.version ? ` (${detectResult.version})` : ""}` : "no"}`,
          opts,
        );
        info("  Status:       ok", opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

// ── Root adapter command ───────────────────────────────────────────

export const adapterCommand = defineCommand({
  meta: { name: "adapter", description: "Manage adapters" },
  subCommands: {
    list: () => Promise.resolve(listSubcommand),
    install: () => Promise.resolve(installSubcommand),
    remove: () => Promise.resolve(removeSubcommand),
    update: () => Promise.resolve(updateSubcommand),
    verify: () => Promise.resolve(verifySubcommand),
  },
});

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Valid adapter name: lowercase alphanumerics, dash, underscore.
 * Must start with alnum. 1–64 chars. Matches the subset of POSIX-safe
 * directory names that also work as command prefixes (`am-adapter-<name>`).
 *
 * Rejects: path traversal (`..`, `/`), empty strings, uppercase,
 * whitespace, leading dash/underscore, and anything > 64 chars.
 */
const ADAPTER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate a derived adapter name. Throws on invalid input so the caller
 * can fail before creating directories, spawning npm, or writing TOML.
 *
 * A separate export so tests can exercise it directly and other call sites
 * (e.g. marketplace installer) can reuse the same rule.
 */
export function validateAdapterName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("Invalid adapter name: empty or non-string value");
  }
  // Reject obvious path-traversal and separator abuse even before the regex,
  // so the error message is actionable.
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(
      `Invalid adapter name "${name}": must not contain "..", "/", or "\\" (would escape adapters directory).`,
    );
  }
  if (!ADAPTER_NAME_RE.test(name)) {
    throw new Error(
      `Invalid adapter name "${name}": must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters/digits, dash, underscore; start with alnum; 1–64 chars).`,
    );
  }
}

export function resolveSource(source: string): {
  name: string;
  sourceType: "npm" | "git" | "local";
  installCmd: string[];
} {
  // Local path
  if (source.startsWith("./") || source.startsWith("/") || source.startsWith("local:")) {
    const path = source.replace(/^local:/, "");
    // Derive name from directory basename
    const name =
      path
        .split("/")
        .filter(Boolean) // drop empty segments from trailing or doubled slashes
        .pop()
        ?.replace(/^am-adapter-/, "") ?? "";
    validateAdapterName(name);
    return { name, sourceType: "local", installCmd: [] };
  }

  // Git URL
  if (
    source.startsWith("git+") ||
    source.startsWith("https://") ||
    source.startsWith("git://") ||
    source.endsWith(".git")
  ) {
    const url = source.replace(/^git\+/, "");
    // Derive name from repo basename
    const repoName =
      url
        .split("/")
        .filter(Boolean)
        .pop()
        ?.replace(/\.git$/, "") ?? "";
    const name = repoName.replace(/^am-adapter-/, "");
    validateAdapterName(name);
    return { name, sourceType: "git", installCmd: ["git", "clone", url, name] };
  }

  // npm package (default)
  const pkgName = source.replace(/@[\d.]+$/, ""); // strip version
  // Strip leading scope (@scope/) for the derived name — npm install
  // still receives the original `source` spec.
  const unscoped = pkgName.replace(/^@[^/]+\//, "");
  const name = unscoped.replace(/^am-adapter-/, "");
  validateAdapterName(name);
  return {
    name,
    sourceType: "npm",
    // --ignore-scripts: marketplace adapter is untrusted; lifecycle scripts
    // (preinstall/install/postinstall) can execute arbitrary code before any
    // checksum or manifest validation runs — classic supply-chain RCE.
    installCmd: ["npm", "install", source, "--production", "--ignore-scripts"],
  };
}

function formatSource(source: string, sourceType: "npm" | "git" | "local"): string {
  if (sourceType === "local") return `local:${source.replace(/^local:/, "")}`;
  if (sourceType === "git") return `git+${source.replace(/^git\+/, "")}`;
  return `npm:${source}`;
}

/**
 * Compute the sha256 of the adapter entrypoint file and format it as
 * `sha256:<hex>` for storage in adapters.toml.
 *
 * Pins the exact bits that just passed validation. The loader verifies
 * this on every spawn; any tampering after install causes load failure.
 */
async function computeChecksum(commandPath: string): Promise<string> {
  const data = await readFile(commandPath);
  const hex = createHash("sha256").update(data).digest("hex");
  return `sha256:${hex}`;
}

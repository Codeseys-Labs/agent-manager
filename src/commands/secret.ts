import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import {
  formatScanReport,
  redactSecret,
  scanConfigForSecrets,
  substituteSecret,
} from "../core/secret-detection";
import {
  decryptValue,
  encryptValue,
  generateKey,
  importKey,
  isEncrypted,
  loadKey,
  saveKey,
} from "../core/secrets";
import { requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";

export const secretCommand = defineCommand({
  meta: { name: "secret", description: "Manage encrypted secrets" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  subCommands: {
    set: () => Promise.resolve(setCommand),
    get: () => Promise.resolve(getCommand),
    list: () => Promise.resolve(listCommand),
    scan: () => Promise.resolve(scanCommand),
    "install-scanner": () => Promise.resolve(installScannerCommand),
    "generate-key": () => Promise.resolve(generateKeyCommand),
    "import-key": () => Promise.resolve(importKeyCommand),
  },
});

const setCommand = defineCommand({
  meta: { name: "set", description: "Encrypt and store a secret value" },
  args: {
    name: { type: "positional", description: "Secret name (env var key)", required: true },
    value: { type: "positional", description: "Secret value to encrypt", required: true },
    server: {
      type: "string",
      description: "Server to set the secret for (if omitted, sets in settings.env)",
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");

      const key = await loadKey(configDir);
      if (!key) {
        error("No encryption key found. Run `am secret generate-key` first.", opts);
        process.exitCode = 1;
        return;
      }

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      const encrypted = await encryptValue(args.value, key);

      if (args.server) {
        // Set in server env
        const server = config.servers?.[args.server];
        if (!server) {
          error(`Server "${args.server}" not found.`, opts);
          process.exitCode = 1;
          return;
        }
        if (!server.env) server.env = {};
        server.env[args.name] = encrypted;
      } else {
        // Set in settings.env (top-level env for profiles/global use)
        if (!config.settings) config.settings = {};
        config.settings.env = config.settings.env ?? {};
        config.settings.env[args.name] = encrypted;
      }

      await writeConfig(configPath, config);

      try {
        await commitAll(configDir, `secret: set ${args.name}`);
      } catch {
        // Nothing to commit
      }

      info(`Secret "${args.name}" set.`, opts);
      if (args.json) {
        output({ action: "set", name: args.name, server: args.server ?? null }, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Decrypt and display a secret value" },
  args: {
    name: { type: "positional", description: "Secret name to retrieve", required: true },
    server: { type: "string", description: "Server to read the secret from" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");

      const key = await loadKey(configDir);
      if (!key) {
        error("No encryption key found.", opts);
        process.exitCode = 1;
        return;
      }

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      let value: string | undefined;

      if (args.server) {
        value = config.servers?.[args.server]?.env?.[args.name];
      } else {
        value = config.settings?.env?.[args.name];
      }

      if (!value) {
        error(`Secret "${args.name}" not found.`, opts);
        process.exitCode = 1;
        return;
      }

      const decrypted = await decryptValue(value, key);

      if (args.json) {
        output({ name: args.name, value: decrypted }, opts);
      } else {
        console.log(decrypted);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List secret names (not values)" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      const secrets: Array<{ name: string; location: string }> = [];

      // Check settings.env
      const settingsEnv = config.settings?.env;
      if (settingsEnv) {
        for (const [name, value] of Object.entries(settingsEnv)) {
          if (typeof value === "string" && isEncrypted(value)) {
            secrets.push({ name, location: "settings" });
          }
        }
      }

      // Check server env fields
      for (const [serverName, server] of Object.entries(config.servers ?? {})) {
        for (const [name, value] of Object.entries(server.env ?? {})) {
          if (isEncrypted(value)) {
            secrets.push({ name, location: `server:${serverName}` });
          }
        }
      }

      if (args.json) {
        output({ secrets }, opts);
        return;
      }

      if (secrets.length === 0) {
        info("No secrets found.", opts);
        return;
      }

      info(`${"Name".padEnd(30)} ${"Location"}`, opts);
      info(`${"─".repeat(30)} ${"─".repeat(30)}`, opts);
      for (const s of secrets) {
        info(`${s.name.padEnd(30)} ${s.location}`, opts);
      }
      info(`\n${secrets.length} secret(s)`, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const installScannerCommand = defineCommand({
  meta: { name: "install-scanner", description: "Install betterleaks secret scanner" },
  args: {
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const { isBetterleaksAvailable, getBetterleaksVersion, installBetterleaks } = await import(
      "../core/betterleaks"
    );

    if (isBetterleaksAvailable()) {
      const version = getBetterleaksVersion();
      info(`betterleaks is already installed: ${version ?? "unknown version"}`, opts);
      return;
    }

    info("Installing betterleaks secret scanner...", opts);
    const result = await installBetterleaks();

    if (result.success) {
      info(`betterleaks installed at ${result.path}`, opts);
      if (args.json) output({ action: "install", path: result.path, success: true }, opts);
    } else {
      error(`Failed to install betterleaks: ${result.error}`, opts);
      info("You can install manually:", opts);
      info("  brew install betterleaks", opts);
      info("  # or download from https://github.com/betterleaks/betterleaks/releases", opts);
      process.exitCode = 1;
    }
  },
});

const scanCommand = defineCommand({
  meta: { name: "scan", description: "Scan server configs for potential unencrypted secrets" },
  args: {
    fix: {
      type: "boolean",
      description: "Auto-substitute and encrypt all high/medium confidence secrets",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      if (!config.servers || Object.keys(config.servers).length === 0) {
        info("No servers configured.", opts);
        return;
      }

      // Tiered scan: Tier 1 (key names) always, Tier 2 (betterleaks) when available
      const { isBetterleaksAvailable, getBetterleaksVersion } = await import("../core/betterleaks");
      const useBetterleaks = isBetterleaksAvailable();
      if (useBetterleaks && !args.json) {
        info(
          `Using betterleaks (${getBetterleaksVersion() ?? "installed"}) for Tier 2 inline scanning`,
          opts,
        );
      }

      const scanResults = await scanConfigForSecrets(config.servers);

      if (scanResults.length === 0) {
        if (args.json) {
          output({ action: "scan", secrets: [] }, opts);
        } else {
          info("No secrets detected.", opts);
        }
        if (!useBetterleaks) {
          info("", opts);
          info("Tip: Install betterleaks for Tier 2 inline secret scanning:", opts);
          info("  am secret install-scanner", opts);
        }
        return;
      }

      const totalSecrets = scanResults.reduce((sum, r) => sum + r.secrets.length, 0);

      if (!args.fix) {
        if (args.json) {
          output(
            {
              action: "scan",
              secrets: scanResults.map((r) => ({
                server: r.serverName,
                secrets: r.secrets.map((s) => ({
                  location: s.location,
                  key: s.key,
                  value: redactSecret(s.value),
                  source: s.source,
                  suggestedEnvVar: s.suggestedEnvVar,
                })),
              })),
            },
            opts,
          );
        } else {
          info(formatScanReport(scanResults), opts);
          info("", opts);
          info("Run `am secret scan --fix` to auto-substitute and encrypt.", opts);
        }
        if (!useBetterleaks) {
          info("", opts);
          info("Tip: Install betterleaks for Tier 2 inline secret scanning:", opts);
          info("  am secret install-scanner", opts);
        }
        return;
      }

      // Fix mode: substitute and encrypt
      let key = await loadKey(configDir);
      if (!key) {
        // Auto-generate key
        const base64Key = await generateKey();
        await saveKey(configDir, base64Key);
        key = await importKey(base64Key);
        info("Generated encryption key (stored in .agent-manager/key.txt)", opts);
      }

      let substituted = 0;
      const fixedSecrets: Array<{ server: string; key: string; envVar: string }> = [];

      for (const result of scanResults) {
        const server = config.servers![result.serverName];
        if (!server) continue;

        for (const secret of result.secrets) {
          const envVar = secret.suggestedEnvVar;
          substituteSecret(server, secret, envVar);

          // Store the original value encrypted in settings.env
          if (!config.settings) config.settings = {};
          if (!config.settings.env) config.settings.env = {};
          config.settings.env[envVar] = await encryptValue(secret.value, key);

          fixedSecrets.push({
            server: result.serverName,
            key: secret.key ?? `args[${secret.index}]`,
            envVar,
          });
          substituted++;
        }
      }

      await writeConfig(configPath, config);

      try {
        await commitAll(configDir, `secret: auto-encrypt ${substituted} secret(s)`);
      } catch {
        // Nothing to commit
      }

      if (args.json) {
        output({ action: "scan-fix", substituted, fixed: fixedSecrets }, opts);
      } else {
        info(`Substituted and encrypted ${substituted} secret(s):`, opts);
        for (const f of fixedSecrets) {
          info(`  ${f.server}: ${f.key} -> \${${f.envVar}}`, opts);
        }
        info(
          `\nOriginal values stored encrypted in settings.env. Skipped ${totalSecrets - substituted} low-confidence finding(s).`,
          opts,
        );
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const generateKeyCommand = defineCommand({
  meta: { name: "generate-key", description: "Generate a new encryption key" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();

    await mkdir(join(configDir, ".agent-manager"), { recursive: true });

    const base64 = await generateKey();
    await saveKey(configDir, base64);

    info("Encryption key generated and saved.", opts);
    info(`Save this key in your password manager: ${base64}`, opts);

    if (args.json) {
      output({ action: "generate-key", key: base64 }, opts);
    }
  },
});

const importKeyCommand = defineCommand({
  meta: { name: "import-key", description: "Import an encryption key from a file" },
  args: {
    path: { type: "positional", description: "Path to key file", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const destDir = join(configDir, ".agent-manager");
    const destPath = join(destDir, "key.txt");

    await mkdir(destDir, { recursive: true });
    await copyFile(args.path, destPath);

    // Validate the key
    try {
      const key = await loadKey(configDir);
      if (!key) throw new Error("Invalid key");
    } catch {
      error("Imported file does not contain a valid encryption key.", opts);
      process.exitCode = 1;
      return;
    }

    info("Encryption key imported.", opts);
    if (args.json) {
      output({ action: "import-key", source: args.path }, opts);
    }
  },
});

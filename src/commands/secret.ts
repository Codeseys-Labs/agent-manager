import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { atomicWriteFile } from "../core/atomic-write";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { withConfig } from "../core/controller";
import {
  SETTINGS_ENV_SCOPE,
  type SecretScanResult,
  formatScanReport,
  pickEnvVarName,
  redactSecret,
  scanConfigForSecrets,
  scanSettingsEnvForSecrets,
  substituteSecret,
} from "../core/secret-detection";
import {
  encryptValue,
  generateKey,
  getDefaultBackend,
  importKey,
  isEncrypted,
  loadKey,
  resolveKeyPath,
  saveKey,
} from "../core/secrets";
import { classifyEnvelope, decodeEnvelope } from "../core/secrets-decode";
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

      const key = await loadKey(configDir);
      if (!key) {
        error("No encryption key found. Run `am secret generate-key` first.", opts);
        process.exitCode = 1;
        return;
      }

      const encrypted = await encryptValue(args.value, key);

      type Outcome = { status: "ok" } | { status: "server-not-found" };
      const outcome = await withConfig<Outcome>(configDir, async (maybeConfig) => {
        requireConfig(maybeConfig);
        const config = maybeConfig;

        if (args.server) {
          const server = config.servers?.[args.server];
          if (!server) {
            return { result: { status: "server-not-found" }, changed: false };
          }
          if (!server.env) server.env = {};
          server.env[args.name] = encrypted;
        } else {
          if (!config.settings) config.settings = {};
          config.settings.env = config.settings.env ?? {};
          config.settings.env[args.name] = encrypted;
        }
        return {
          result: { status: "ok" },
          commitMessage: `secret: set ${args.name}`,
          changed: true,
        };
      });

      if (outcome.status === "server-not-found") {
        error(`Server "${args.server}" not found.`, opts);
        process.exitCode = 1;
        return;
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

      // Format-aware decode (P0-3 fix): dispatch by envelope format. Load the
      // legacy AES key for `enc:v1:` and the age backend for `enc:v2:age:`.
      // An unknown `enc:` prefix fails loud rather than echoing ciphertext.
      const kind = classifyEnvelope(value);
      const key = await loadKey(configDir);
      const ageBackend =
        kind === "v2-age" ? await getDefaultBackend(configDir, { config, override: "age" }) : null;
      if (kind === "v1-aes-gcm" && !key) {
        error("No encryption key found.", opts);
        process.exitCode = 1;
        return;
      }

      const decrypted = await decodeEnvelope(value, {
        legacyKey: key ?? null,
        ageBackend,
      });

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

      const hasServers = !!config.servers && Object.keys(config.servers).length > 0;
      const hasSettingsEnv = !!config.settings?.env && Object.keys(config.settings.env).length > 0;
      // Nothing to scan only when BOTH the server table AND settings.env are
      // empty. A config with no servers can still carry a plaintext secret in
      // [settings.env] (M6) — that must not be reported as "nothing to scan".
      if (!hasServers && !hasSettingsEnv) {
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

      // Scan servers AND settings.env. The settings.env block is surfaced under
      // the synthetic `settings` scope so it flows through formatScanReport, the
      // JSON output, and the M5 exit-code gate identically to server findings.
      const serverResults = config.servers ? await scanConfigForSecrets(config.servers) : [];
      const settingsResult = await scanSettingsEnvForSecrets(config.settings?.env);
      const scanResults: SecretScanResult[] =
        settingsResult.secrets.length > 0 ? [...serverResults, settingsResult] : serverResults;

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
        // Gate CI: report-mode (no --fix) must exit nonzero when plaintext
        // secrets were found, or `am secret scan` can never fail a pipeline
        // (ws 1f08-secret-scan-exit-code, M5). We reach this branch only after
        // the zero-findings early return above, so scanResults is non-empty.
        process.exitCode = 1;
        if (!useBetterleaks) {
          info("", opts);
          info("Tip: Install betterleaks for Tier 2 inline secret scanning:", opts);
          info("  am secret install-scanner", opts);
        }
        return;
      }

      // Fix mode: substitute and encrypt — do key work before taking the lock.
      let key = await loadKey(configDir);
      if (!key) {
        const base64Key = await generateKey();
        await saveKey(configDir, base64Key);
        key = await importKey(base64Key);
        info(`Generated encryption key (stored at ${resolveKeyPath()})`, opts);
      }
      const encryptionKey = key;

      interface FixResult {
        substituted: number;
        fixedSecrets: Array<{ server: string; key: string; envVar: string }>;
      }

      const fixOutcome = await withConfig<FixResult>(configDir, async (maybeConfig) => {
        requireConfig(maybeConfig);
        const config = maybeConfig;
        let substituted = 0;
        const fixedSecrets: Array<{ server: string; key: string; envVar: string }> = [];

        // Re-scan inside the lock so we operate on the current state.
        const freshScan = config.servers ? await scanConfigForSecrets(config.servers) : [];

        // settings.env secrets (M6): a plaintext value under an obviously-secret
        // key in [settings.env]. The value already lives where encrypted secrets
        // belong, so the fix is to encrypt IN PLACE — no substitution / move.
        const freshSettings = await scanSettingsEnvForSecrets(config.settings?.env);
        for (const secret of freshSettings.secrets) {
          // Only key-name env findings have a stable home key we can rewrite in
          // place. Anything else (no key) is skipped rather than risk leaving a
          // plaintext copy beside an encrypted one (review A+F invariant).
          if (secret.location !== "env" || !secret.key) continue;
          const settingsEnv = config.settings?.env;
          if (!settingsEnv || settingsEnv[secret.key] !== secret.value) continue;
          settingsEnv[secret.key] = await encryptValue(secret.value, encryptionKey);
          fixedSecrets.push({
            server: SETTINGS_ENV_SCOPE,
            key: secret.key,
            envVar: secret.key,
          });
          substituted++;
        }

        for (const result of freshScan) {
          const server = config.servers![result.serverName];
          if (!server) continue;

          for (const secret of result.secrets) {
            if (!config.settings) config.settings = {};
            if (!config.settings.env) config.settings.env = {};
            // URL creds derive generic names (api_key→API_KEY) that collide
            // across servers; pick a collision-safe key (review finding C — this
            // --fix path previously used the bare name and clobbered).
            const envVar =
              secret.source === "url-credential"
                ? pickEnvVarName(config.settings.env, secret.suggestedEnvVar, result.serverName)
                : secret.suggestedEnvVar;
            // INVARIANT: only encrypt+count once the plaintext is provably gone
            // (review A+F). If substitution can't rewrite the location, skip —
            // do not store an encrypted copy beside surviving plaintext.
            if (!substituteSecret(server, secret, envVar)) {
              continue;
            }
            config.settings.env[envVar] = await encryptValue(secret.value, encryptionKey);

            fixedSecrets.push({
              server: result.serverName,
              key: secret.key ?? `args[${secret.index}]`,
              envVar,
            });
            substituted++;
          }
        }

        return {
          result: { substituted, fixedSecrets },
          commitMessage:
            substituted > 0 ? `secret: auto-encrypt ${substituted} secret(s)` : undefined,
          changed: substituted > 0,
        };
      });

      const { substituted, fixedSecrets } = fixOutcome;
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

    const base64 = await generateKey();
    await saveKey(configDir, base64);

    const keyPath = resolveKeyPath();
    info(`Encryption key generated and saved to ${keyPath}`, opts);
    info(`Save this key in your password manager: ${base64}`, opts);

    if (args.json) {
      output({ action: "generate-key", key: base64, path: keyPath }, opts);
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
    const destPath = resolveKeyPath();

    await mkdir(dirname(destPath), { recursive: true });
    // Read source, write with mode 0o600 to match saveKey semantics.
    const contents = await readFile(args.path, "utf-8");
    await atomicWriteFile(destPath, contents, { mode: 0o600 });

    // Validate the key
    try {
      const key = await loadKey(configDir);
      if (!key) throw new Error("Invalid key");
    } catch {
      error("Imported file does not contain a valid encryption key.", opts);
      process.exitCode = 1;
      return;
    }

    info(`Encryption key imported to ${destPath}`, opts);
    if (args.json) {
      output({ action: "import-key", source: args.path, path: destPath }, opts);
    }
  },
});

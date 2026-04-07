import { defineCommand } from "citty";
import { join } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
import {
  resolveConfigDir,
  readConfig,
  writeConfig,
} from "../core/config";
import { commitAll } from "../core/git";
import {
  generateKey,
  importKey,
  loadKey,
  saveKey,
  encryptValue,
  decryptValue,
  isEncrypted,
} from "../core/secrets";
import { output, info, error } from "../lib/output";

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
    "generate-key": () => Promise.resolve(generateKeyCommand),
    "import-key": () => Promise.resolve(importKeyCommand),
  },
});

const setCommand = defineCommand({
  meta: { name: "set", description: "Encrypt and store a secret value" },
  args: {
    name: { type: "positional", description: "Secret name (env var key)", required: true },
    value: { type: "positional", description: "Secret value to encrypt", required: true },
    server: { type: "string", description: "Server to set the secret for (if omitted, sets in settings.env)" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    const key = await loadKey(configDir);
    if (!key) {
      error("No encryption key found. Run `am secret generate-key` first.", opts);
      process.exitCode = 1;
      return;
    }

    let config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

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
      (config.settings as any).env = (config.settings as any).env ?? {};
      (config.settings as any).env[args.name] = encrypted;
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
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    const key = await loadKey(configDir);
    if (!key) {
      error("No encryption key found.", opts);
      process.exitCode = 1;
      return;
    }

    let config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    let value: string | undefined;

    if (args.server) {
      value = config.servers?.[args.server]?.env?.[args.name];
    } else {
      value = (config.settings as any)?.env?.[args.name];
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
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    let config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    const secrets: Array<{ name: string; location: string }> = [];

    // Check settings.env
    const settingsEnv = (config.settings as any)?.env;
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

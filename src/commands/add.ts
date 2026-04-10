import { join } from "node:path";
import { defineCommand } from "citty";
import { readConfig, resolveConfigDir, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import type { Server } from "../core/schema";
import { scanServerForSecrets, substituteSecret } from "../core/secret-detection";
import { encryptValue, generateKey, importKey, loadKey, saveKey } from "../core/secrets";
import { error, info, output } from "../lib/output";

export const addCommand = defineCommand({
  meta: { name: "add", description: "Add a server to the config" },
  args: {
    name: { type: "positional", description: "Server name", required: true },
    command: { type: "string", description: "Command to run", required: true },
    args: { type: "string", description: "Comma-separated args" },
    tags: { type: "string", description: "Comma-separated tags" },
    description: { type: "string", description: "Server description" },
    env: { type: "string", description: "Comma-separated KEY=VALUE pairs" },
    project: {
      type: "boolean",
      description: "Add to project config instead of global",
      default: false,
    },
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

    const name = args.name;

    // Check for duplicate
    if (config.servers?.[name]) {
      error(`Server "${name}" already exists. Remove it first or use a different name.`, opts);
      process.exitCode = 1;
      return;
    }

    // Build server entry
    const server: Server = {
      command: args.command,
      transport: "stdio",
      enabled: true,
    };
    if (args.args) server.args = args.args.split(",").map((s) => s.trim());
    if (args.tags) server.tags = args.tags.split(",").map((s) => s.trim());
    if (args.description) server.description = args.description;
    if (args.env) {
      server.env = {};
      for (const pair of args.env.split(",")) {
        const [k, ...rest] = pair.split("=");
        if (k && rest.length > 0) server.env[k.trim()] = rest.join("=").trim();
      }
    }

    // Add to config
    if (!config.servers) config.servers = {};
    config.servers[name] = server;

    // Scan for secrets and auto-encrypt before writing
    const scanResult = scanServerForSecrets(name, server);
    let secretsEncrypted = 0;
    const actionableSecrets = scanResult.secrets.filter((s) => s.confidence !== "low");

    if (actionableSecrets.length > 0) {
      // Ensure encryption key exists — auto-generate if missing
      let key = await loadKey(configDir);
      if (!key) {
        const base64Key = await generateKey();
        await saveKey(configDir, base64Key);
        key = await importKey(base64Key);
        info("Generated encryption key (stored in .agent-manager/key.txt)", opts);
      }

      for (const secret of actionableSecrets) {
        substituteSecret(server, secret, secret.suggestedEnvVar);
        if (!config.settings) config.settings = {};
        if (!config.settings.env) config.settings.env = {};
        config.settings.env[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
        secretsEncrypted++;
      }
    }

    await writeConfig(configPath, config);

    // Auto-commit
    const tagStr = server.tags?.length ? ` (${server.tags.join(", ")})` : "";
    try {
      await commitAll(configDir, `add server: ${name}${tagStr}`);
    } catch {
      // Nothing to commit is fine
    }

    info(`Added server "${name}"`, opts);
    if (secretsEncrypted > 0 && !args.json) {
      info(`  Encrypted ${secretsEncrypted} secret(s) — values use \${VAR} references now.`, opts);
    }

    if (args.json) {
      output(
        {
          action: "add",
          server: name,
          config: server,
          secretsEncrypted: secretsEncrypted > 0 ? secretsEncrypted : undefined,
        },
        opts,
      );
    }
  },
});

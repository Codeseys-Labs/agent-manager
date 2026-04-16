/**
 * Community adapter loader (ADR-0027).
 *
 * Reads adapters.toml from the config directory, spawns a
 * CommunityAdapterProxy for each enabled adapter, and caches them.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { isNotFound } from "../../lib/errors.ts";
import { tomlStringify } from "../../lib/toml.ts";
import type { Adapter } from "../types.ts";
import { CommunityAdapterProxy } from "./proxy.ts";
import type { AdaptersToml, CommunityAdapterConfig } from "./types.ts";

const ADAPTERS_TOML = "adapters.toml";

const proxyCache = new Map<string, CommunityAdapterProxy>();

/**
 * Verify the SHA256 checksum of an adapter binary against the stored checksum.
 * Throws if the checksum doesn't match. Warns (returns) if no checksum is stored.
 */
export async function verifyChecksum(name: string, command: string, storedChecksum: string | undefined): Promise<void> {
  if (!storedChecksum) {
    console.error(`warning: community adapter "${name}" has no checksum in adapters.toml — skipping integrity check`);
    return;
  }

  // Expected format: "sha256:<hex>"
  const colonIdx = storedChecksum.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(
      `Adapter binary checksum format invalid for "${name}". Expected "sha256:<hex>", got "${storedChecksum}"`,
    );
  }
  const expectedHash = storedChecksum.slice(colonIdx + 1);

  let binaryData: Buffer;
  try {
    binaryData = await readFile(command);
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(`Adapter binary not found for "${name}": ${command}`);
    }
    throw err;
  }

  const actualHash = createHash("sha256").update(binaryData).digest("hex");

  if (actualHash !== expectedHash) {
    throw new Error(
      `Adapter binary checksum mismatch for ${name}. Expected ${expectedHash}, got ${actualHash}. The adapter may have been tampered with.`,
    );
  }
}

/** Read and parse adapters.toml. Returns empty record if file doesn't exist. */
export async function readAdaptersToml(configDir: string): Promise<AdaptersToml> {
  const path = join(configDir, ADAPTERS_TOML);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = TOML.parse(raw) as unknown as AdaptersToml;
    return { adapters: parsed.adapters ?? {} };
  } catch (err) {
    if (isNotFound(err)) return { adapters: {} };
    throw err;
  }
}

/** Write adapters.toml to the config directory. */
export async function writeAdaptersToml(configDir: string, data: AdaptersToml): Promise<void> {
  const path = join(configDir, ADAPTERS_TOML);
  await writeFile(path, tomlStringify(data as unknown as Record<string, unknown>));
}

/**
 * Load all enabled community adapters from adapters.toml.
 * Returns a map of adapter name -> Adapter instance.
 * Adapters that fail to load are skipped (with a warning logged to stderr).
 */
export async function loadCommunityAdapters(
  configDir: string,
): Promise<Map<string, CommunityAdapterProxy>> {
  const toml = await readAdaptersToml(configDir);
  const loaded = new Map<string, CommunityAdapterProxy>();

  for (const [name, config] of Object.entries(toml.adapters)) {
    if (config.enabled === false) continue;

    // Return cached proxy if alive
    const cached = proxyCache.get(name);
    if (cached) {
      if (cached.isAlive()) {
        loaded.set(name, cached);
        continue;
      }
      // Dead proxy — evict from cache and respawn below
      cached.kill();
      proxyCache.delete(name);
    }

    try {
      // Verify binary integrity before spawning
      await verifyChecksum(name, config.command, config.checksum);

      const proxy = await CommunityAdapterProxy.create(config.command);
      proxyCache.set(name, proxy);
      loaded.set(name, proxy);
    } catch (err) {
      console.error(
        `warning: failed to load community adapter "${name}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return loaded;
}

/** List the names of all community adapters in adapters.toml (enabled or not). */
export async function listCommunityAdapterNames(configDir: string): Promise<string[]> {
  const toml = await readAdaptersToml(configDir);
  return Object.keys(toml.adapters);
}

/** Get a single community adapter config by name. */
export async function getCommunityAdapterConfig(
  configDir: string,
  name: string,
): Promise<CommunityAdapterConfig | undefined> {
  const toml = await readAdaptersToml(configDir);
  return toml.adapters[name];
}

/** Add or update a community adapter entry in adapters.toml. */
export async function setCommunityAdapterConfig(
  configDir: string,
  name: string,
  config: CommunityAdapterConfig,
): Promise<void> {
  const toml = await readAdaptersToml(configDir);
  toml.adapters[name] = config;
  await writeAdaptersToml(configDir, toml);
}

/** Remove a community adapter entry from adapters.toml. */
export async function removeCommunityAdapterConfig(
  configDir: string,
  name: string,
): Promise<boolean> {
  const toml = await readAdaptersToml(configDir);
  if (!(name in toml.adapters)) return false;
  delete toml.adapters[name];
  await writeAdaptersToml(configDir, toml);
  // Kill cached proxy
  const proxy = proxyCache.get(name);
  if (proxy) {
    proxy.kill();
    proxyCache.delete(name);
  }
  return true;
}

/** Kill all cached community adapter proxies. Call on process exit. */
export function killAllProxies(): void {
  for (const [, proxy] of proxyCache) {
    proxy.kill();
  }
  proxyCache.clear();
}

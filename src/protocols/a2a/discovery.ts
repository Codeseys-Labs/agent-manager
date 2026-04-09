/**
 * A2A Agent Discovery — find and register remote A2A agents.
 *
 * Sources:
 *   1. Direct URL — fetch /.well-known/agent.json from any URL
 *   2. Local roster — agents.toml in the config directory
 *   3. Config discovery sources — settings.a2a.discovery_sources[]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { tomlStringify } from "../../lib/toml";
import { A2AClient } from "./client";
import type { AgentCard, AgentRosterEntry } from "./types";

const ROSTER_FILENAME = "agents.toml";

// ── URL-based discovery ────────────────────────────────────────

/**
 * Fetch an Agent Card from a URL.
 * Tries /.well-known/agent.json at the given base URL.
 * Returns null if no agent card is found (404).
 */
export async function discoverFromUrl(url: string): Promise<AgentCard | null> {
  const client = new A2AClient({ timeout: 15_000 });
  return client.discoverAgent(url);
}

// ── Roster file operations ─────────────────────────────────────

interface RosterToml {
  agents?: Record<
    string,
    {
      url: string;
      description?: string;
      added_at: string;
      last_seen?: string;
    }
  >;
}

/**
 * Load the agent roster from the config directory.
 * Returns an empty array if the file doesn't exist.
 */
export async function loadRoster(configDir: string): Promise<AgentRosterEntry[]> {
  const rosterPath = join(configDir, ROSTER_FILENAME);
  let raw: string;
  try {
    raw = await readFile(rosterPath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  const parsed = TOML.parse(raw) as unknown as RosterToml;
  const agents = parsed.agents ?? {};

  return Object.entries(agents).map(([name, entry]) => ({
    name,
    url: entry.url,
    description: entry.description,
    addedAt: entry.added_at,
    lastSeen: entry.last_seen,
  }));
}

/**
 * Save the agent roster to the config directory.
 * Overwrites the existing file.
 */
export async function saveRoster(configDir: string, entries: AgentRosterEntry[]): Promise<void> {
  const rosterPath = join(configDir, ROSTER_FILENAME);

  const agents: Record<
    string,
    { url: string; description?: string; added_at: string; last_seen?: string }
  > = {};
  for (const entry of entries) {
    agents[entry.name] = {
      url: entry.url,
      ...(entry.description ? { description: entry.description } : {}),
      added_at: entry.addedAt,
      ...(entry.lastSeen ? { last_seen: entry.lastSeen } : {}),
    };
  }

  const toml = tomlStringify({ agents });
  await writeFile(rosterPath, toml, "utf-8");
}

/**
 * Add an agent to the roster. If an agent with the same name exists, it's updated.
 * Returns the added/updated entry.
 */
export async function addToRoster(
  configDir: string,
  entry: AgentRosterEntry,
): Promise<AgentRosterEntry> {
  const roster = await loadRoster(configDir);
  const idx = roster.findIndex((r) => r.name === entry.name);
  if (idx >= 0) {
    roster[idx] = entry;
  } else {
    roster.push(entry);
  }
  await saveRoster(configDir, roster);
  return entry;
}

/**
 * Remove an agent from the roster by name.
 * Returns true if an agent was removed, false if not found.
 */
export async function removeFromRoster(configDir: string, name: string): Promise<boolean> {
  const roster = await loadRoster(configDir);
  const idx = roster.findIndex((r) => r.name === name);
  if (idx < 0) return false;
  roster.splice(idx, 1);
  await saveRoster(configDir, roster);
  return true;
}

/**
 * Discover agents from a local roster file path (TOML format).
 * Fetches the Agent Card for each entry and returns cards for reachable agents.
 */
export async function discoverFromRoster(rosterPath: string): Promise<AgentCard[]> {
  let raw: string;
  try {
    raw = await readFile(rosterPath, "utf-8");
  } catch {
    return [];
  }

  const parsed = TOML.parse(raw) as unknown as RosterToml;
  const agents = parsed.agents ?? {};
  const client = new A2AClient({ timeout: 10_000 });

  const cards: AgentCard[] = [];
  const entries = Object.entries(agents);

  // Fetch in parallel with concurrency limit of 5
  const batchSize = 5;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(([, entry]) => client.discoverAgent(entry.url)),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        cards.push(result.value);
      }
    }
  }

  return cards;
}

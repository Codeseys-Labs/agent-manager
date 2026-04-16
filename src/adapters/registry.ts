import type { Adapter } from "./types.ts";

type AdapterFactory = () => Promise<Adapter>;

/** Resolve config dir without importing the heavy core/config module. */
function getConfigDir(): string {
  const { homedir } = require("node:os");
  const { join } = require("node:path");
  return process.env.AM_CONFIG_DIR ?? join(homedir(), ".config", "agent-manager");
}

/** Lazy-load community adapter functions to avoid circular imports. */
async function communityLoader() {
  const { loadCommunityAdapters, listCommunityAdapterNames } = await import(
    "./community/loader.ts"
  );
  return { loadCommunityAdapters, listCommunityAdapterNames };
}

/** Built-in adapter factories — always take precedence over community. */
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  "claude-code": async () => {
    const { claudeCodeAdapter } = await import("./claude-code/index.ts");
    return claudeCodeAdapter;
  },
  forgecode: async () => {
    const { forgeCodeAdapter } = await import("./forgecode/index.ts");
    return forgeCodeAdapter;
  },
  "codex-cli": async () => {
    const { codexCliAdapter } = await import("./codex-cli/index.ts");
    return codexCliAdapter;
  },
  kiro: async () => {
    const { kiroAdapter } = await import("./kiro/index.ts");
    return kiroAdapter;
  },
  cursor: async () => {
    const { cursorAdapter } = await import("./cursor/index.ts");
    return cursorAdapter;
  },
  "kilo-code": async () => {
    const { kiloCodeAdapter } = await import("./kilo-code/index.ts");
    return kiloCodeAdapter;
  },
  windsurf: async () => {
    const { windsurfAdapter } = await import("./windsurf/index.ts");
    return windsurfAdapter;
  },
  cline: async () => {
    const { clineAdapter } = await import("./cline/index.ts");
    return clineAdapter;
  },
  copilot: async () => {
    const { copilotAdapter } = await import("./copilot/index.ts");
    return copilotAdapter;
  },
  "amazon-q": async () => {
    const { amazonQAdapter } = await import("./amazon-q/index.ts");
    return amazonQAdapter;
  },
  "roo-code": async () => {
    const { rooCodeAdapter } = await import("./roo-code/index.ts");
    return rooCodeAdapter;
  },
  "gemini-cli": async () => {
    const { geminiCliAdapter } = await import("./gemini-cli/index.ts");
    return geminiCliAdapter;
  },
  continue: async () => {
    const { continueAdapter } = await import("./continue/index.ts");
    return continueAdapter;
  },
};

const adapterCache = new Map<string, Adapter>();

/** List all adapter names: built-in first, then community. */
export function listAdapters(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}

/** List all adapter names including community (async because it reads adapters.toml). */
export async function listAllAdapters(): Promise<string[]> {
  const builtIn = Object.keys(ADAPTER_FACTORIES);
  const { listCommunityAdapterNames } = await communityLoader();
  const communityNames = await listCommunityAdapterNames(getConfigDir());
  // Community adapters with the same name as built-in are shadowed
  const uniqueCommunity = communityNames.filter((n) => !ADAPTER_FACTORIES[n]);
  return [...builtIn, ...uniqueCommunity];
}

export async function getAdapter(name: string): Promise<Adapter | undefined> {
  // 1. Check built-in first (fast path)
  const factory = ADAPTER_FACTORIES[name];
  if (factory) {
    const cached = adapterCache.get(name);
    if (cached) return cached;

    const adapter = await factory();
    adapterCache.set(name, adapter);
    return adapter;
  }

  // 2. Check community adapters
  const cached = adapterCache.get(name);
  if (cached) return cached;

  const { loadCommunityAdapters } = await communityLoader();
  const community = await loadCommunityAdapters(getConfigDir());
  const proxy = community.get(name);
  if (proxy) {
    adapterCache.set(name, proxy);
    return proxy;
  }

  return undefined;
}

/** Check if a name is a built-in adapter. */
export function isBuiltInAdapter(name: string): boolean {
  return name in ADAPTER_FACTORIES;
}

export async function getDetectedAdapters(): Promise<Adapter[]> {
  const detected: Adapter[] = [];
  for (const name of listAdapters()) {
    const adapter = await getAdapter(name);
    if (!adapter) continue;
    // Community adapters have async detect — use it when available
    const result = "detectAsync" in adapter && typeof adapter.detectAsync === "function"
      ? await (adapter as { detectAsync(): Promise<{ installed: boolean }> }).detectAsync()
      : adapter.detect();
    if (result.installed) {
      detected.push(adapter);
    }
  }
  return detected;
}

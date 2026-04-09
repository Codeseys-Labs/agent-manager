import type { Adapter } from "./types.ts";

type AdapterFactory = () => Promise<Adapter>;

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

export function listAdapters(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}

export async function getAdapter(name: string): Promise<Adapter | undefined> {
  const factory = ADAPTER_FACTORIES[name];
  if (!factory) return undefined;

  const cached = adapterCache.get(name);
  if (cached) return cached;

  const adapter = await factory();
  adapterCache.set(name, adapter);
  return adapter;
}

export async function getDetectedAdapters(): Promise<Adapter[]> {
  const detected: Adapter[] = [];
  for (const name of listAdapters()) {
    const adapter = await getAdapter(name);
    if (adapter?.detect().installed) {
      detected.push(adapter);
    }
  }
  return detected;
}

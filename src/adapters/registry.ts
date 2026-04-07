import type { Adapter } from "./types.ts";

type AdapterFactory = () => Promise<Adapter>;

const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  "claude-code": async () => {
    const { claudeCodeAdapter } = await import("./claude-code/index.ts");
    return claudeCodeAdapter;
  },
};

const adapterCache = new Map<string, Adapter>();

export function listAdapters(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}

export async function getAdapter(
  name: string,
): Promise<Adapter | undefined> {
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
    if (adapter && adapter.detect().installed) {
      detected.push(adapter);
    }
  }
  return detected;
}

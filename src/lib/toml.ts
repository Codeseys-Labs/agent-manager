import type { JsonMap } from "@iarna/toml";
import { stringify } from "@iarna/toml";

/**
 * Type-safe TOML stringify wrapper.
 * Our Zod-inferred config types include `undefined` (optional fields) and string
 * literal unions which don't structurally match @iarna/toml's JsonMap type.
 * The runtime values are always valid TOML — this wrapper consolidates the
 * single necessary cast to one audited location.
 */
export function tomlStringify(obj: Record<string, unknown>): string {
  return stringify(obj as JsonMap);
}

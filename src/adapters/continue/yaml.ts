/**
 * Minimal YAML helper for the Continue adapter.
 *
 * Reading: delegates to `Bun.YAML.parse` (Bun >= 1.3). YAML we encounter in
 * Continue configs is simple scalars + sequences + mappings, no anchors, tags,
 * or multi-doc streams.
 *
 * Writing: we emit a conservative block-style YAML by hand because
 * `Bun.YAML.stringify` (as of 1.3.x) emits flow style which is unfriendly for
 * humans editing `config.yaml`. The subset we emit is sufficient for
 * `schema: v1` Continue config files (name, version, schema, mcpServers list).
 */

/** Parse YAML text to an unknown value. */
export function parseYaml(text: string): unknown {
  // Bun.YAML is available in Bun 1.3+. At runtime we expect Bun; at build time
  // we don't want to couple to a bun typing, so access it dynamically.
  const bunGlobal = (globalThis as { Bun?: { YAML?: { parse(s: string): unknown } } }).Bun;
  const y = bunGlobal?.YAML;
  if (!y || typeof y.parse !== "function") {
    throw new Error(
      "YAML parsing requires Bun >= 1.3 (Bun.YAML.parse). Running outside Bun is not supported for Continue YAML.",
    );
  }
  return y.parse(text);
}

/**
 * Write a Continue-shaped object as human-friendly block YAML.
 *
 * This is NOT a general-purpose YAML serializer — it only handles the shapes
 * we emit in config.yaml / .continue/mcpServers/*.yaml:
 *   - objects with string/number/boolean/array/object values
 *   - arrays of primitives and arrays of objects (block sequences)
 *
 * Scalars that look ambiguous (colons, leading `-`, quotes, special YAML
 * values like `null`/`true`/`false`/numerics) are double-quoted.
 */
export function stringifyYaml(value: unknown): string {
  const out: string[] = [];
  writeNode(value, 0, out, false);
  // Ensure trailing newline.
  const text = out.join("");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function writeNode(value: unknown, indent: number, out: string[], inline: boolean): void {
  if (value === null || value === undefined) {
    out.push(inline ? "null" : "null\n");
    return;
  }
  if (typeof value === "string") {
    out.push(inline ? formatScalar(value) : `${formatScalar(value)}\n`);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const s = String(value);
    out.push(inline ? s : `${s}\n`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(inline ? "[]" : "[]\n");
      return;
    }
    if (!inline) out.push("\n");
    writeSequence(value, indent, out);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) {
      out.push(inline ? "{}" : "{}\n");
      return;
    }
    if (!inline) out.push("\n");
    writeMapping(entries, indent, out);
    return;
  }
  // Fallback for unexpected values
  out.push(inline ? JSON.stringify(value) : `${JSON.stringify(value)}\n`);
}

function writeMapping(entries: [string, unknown][], indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  for (const [key, val] of entries) {
    const k = formatKey(key);
    if (isScalar(val)) {
      out.push(`${pad}${k}: `);
      writeNode(val, indent + 2, out, true);
      out.push("\n");
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        out.push(`${pad}${k}: []\n`);
      } else {
        out.push(`${pad}${k}:\n`);
        writeSequence(val, indent + 2, out);
      }
    } else if (val && typeof val === "object") {
      const subEntries = Object.entries(val as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      if (subEntries.length === 0) {
        out.push(`${pad}${k}: {}\n`);
      } else {
        out.push(`${pad}${k}:\n`);
        writeMapping(subEntries, indent + 2, out);
      }
    } else {
      out.push(`${pad}${k}: `);
      writeNode(val, indent + 2, out, true);
      out.push("\n");
    }
  }
}

function writeSequence(items: unknown[], indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  for (const item of items) {
    if (isScalar(item)) {
      out.push(`${pad}- `);
      writeNode(item, indent, out, true);
      out.push("\n");
    } else if (Array.isArray(item)) {
      // Nested arrays are uncommon; emit flow for simplicity.
      out.push(`${pad}- ${JSON.stringify(item)}\n`);
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      if (entries.length === 0) {
        out.push(`${pad}- {}\n`);
        continue;
      }
      // First pair on the dash line, the rest aligned.
      const [firstKey, firstVal] = entries[0];
      const rest = entries.slice(1);
      out.push(`${pad}- ${formatKey(firstKey)}: `);
      if (isScalar(firstVal)) {
        writeNode(firstVal, indent + 2, out, true);
        out.push("\n");
      } else if (Array.isArray(firstVal)) {
        if (firstVal.length === 0) out.push("[]\n");
        else {
          out.push("\n");
          writeSequence(firstVal, indent + 4, out);
        }
      } else if (firstVal && typeof firstVal === "object") {
        const subEntries = Object.entries(firstVal as Record<string, unknown>).filter(
          ([, v]) => v !== undefined,
        );
        if (subEntries.length === 0) out.push("{}\n");
        else {
          out.push("\n");
          writeMapping(subEntries, indent + 4, out);
        }
      } else {
        writeNode(firstVal, indent + 2, out, true);
        out.push("\n");
      }
      for (const [k, v] of rest) {
        writeMapping([[k, v]], indent + 2, out);
      }
    } else {
      out.push(`${pad}- ${JSON.stringify(item)}\n`);
    }
  }
}

function isScalar(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

/** Quote a key if it contains YAML-special characters. */
function formatKey(key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(key)) return key;
  return JSON.stringify(key);
}

/** Quote a string scalar when needed, otherwise emit plain. */
function formatScalar(s: string): string {
  if (s === "") return '""';
  // Reserved / unsafe words — quote to preserve string type.
  if (
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) ||
    /^[\[\]{}&*!|>'"%@`#\s]/.test(s) ||
    /[:#\n]/.test(s) ||
    s !== s.trim()
  ) {
    return JSON.stringify(s);
  }
  return s;
}

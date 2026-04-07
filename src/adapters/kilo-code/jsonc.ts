/**
 * Minimal JSONC parser: strips comments and trailing commas before JSON.parse.
 *
 * Handles:
 *   - Single-line comments: // ...
 *   - Multi-line comments: /* ... *​/
 *   - Trailing commas before ] or }
 *   - Preserves strings containing // or /* intact
 */
export function parseJsonc(text: string): unknown {
  let result = "";
  let i = 0;
  while (i < text.length) {
    // String literal — copy verbatim (handles escaped quotes)
    if (text[i] === '"') {
      const start = i;
      i++; // skip opening quote
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      result += text.slice(start, i);
      continue;
    }

    // Single-line comment
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip */
      continue;
    }

    result += text[i];
    i++;
  }

  // Strip trailing commas before ] or }
  result = result.replace(/,\s*([\]}])/g, "$1");

  return JSON.parse(result);
}

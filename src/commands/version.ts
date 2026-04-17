import { defineCommand } from "citty";
import { info, output } from "../lib/output";
import { AM_VERSION } from "../lib/version";

export const versionCommand = defineCommand({
  meta: { name: "version", description: "Print version" },
  args: {
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
  },
  run({ args }) {
    const version = AM_VERSION;
    const opts = { json: args.json, quiet: args.quiet };
    if (args.json) {
      output({ version }, opts);
    } else {
      info(version, opts);
    }
  },
});

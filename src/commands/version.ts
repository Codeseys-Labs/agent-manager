import { defineCommand } from "citty";
import { info, output } from "../lib/output";

export const versionCommand = defineCommand({
  meta: { name: "version", description: "Print version" },
  args: {
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
  },
  run({ args }) {
    const version = process.env.BUILD_VERSION ?? "0.1.0";
    const opts = { json: args.json, quiet: args.quiet };
    if (args.json) {
      output({ version }, opts);
    } else {
      info(version, opts);
    }
  },
});

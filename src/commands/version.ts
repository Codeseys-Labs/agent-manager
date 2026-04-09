import { defineCommand } from "citty";

export const versionCommand = defineCommand({
  meta: { name: "version", description: "Show agent-manager version" },
  run() {
    console.log(`agent-manager v${process.env.BUILD_VERSION ?? "0.1.0"}`);
  },
});

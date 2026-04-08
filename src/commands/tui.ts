import { defineCommand } from "citty";

export const tuiCommand = defineCommand({
  meta: { name: "tui", description: "Launch interactive TUI dashboard" },
  args: {},
  async run() {
    const { launchTui } = await import("../tui/index.tsx");
    await launchTui();
  },
});

import { Box, Text } from "silvery";
import React from "react";

interface Props {
  onBack: () => void;
}

const SHORTCUTS = [
  { key: "Tab / 1-3", desc: "Switch between Dashboard, Profiles, Status tabs" },
  { key: "s", desc: "Sync config from git" },
  { key: "a", desc: "Apply config to all detected adapters" },
  { key: "p", desc: "Open profile switcher" },
  { key: "t", desc: "Open status view" },
  { key: "?", desc: "Show this help" },
  { key: "q", desc: "Quit" },
  { key: "", desc: "" },
  { key: "Profile Switcher", desc: "" },
  { key: "Up/Down", desc: "Navigate profiles" },
  { key: "Enter", desc: "Switch to selected profile" },
  { key: "Esc/q", desc: "Back to dashboard" },
];

export function HelpView({ onBack }: Props) {
  return (
    <Box flexDirection="column">
      <Text bold> Keyboard Shortcuts</Text>
      <Box>
        <Text dimColor> {"─".repeat(50)}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {SHORTCUTS.map((s, i) =>
          s.key === "" ? (
            <Box key={`spacer-${i}`}>
              <Text> </Text>
            </Box>
          ) : s.desc === "" ? (
            <Box key={s.key}>
              <Text bold> {s.key}</Text>
            </Box>
          ) : (
            <Box key={s.key}>
              <Text>
                {"  "}
                <Text bold color="cyan">
                  {s.key.padEnd(14)}
                </Text>
                {s.desc}
              </Text>
            </Box>
          ),
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor> [q/Esc/?] back</Text>
      </Box>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "silvery";

interface Props {
  onBack: () => void;
}

const SHORTCUTS = [
  { key: "Tab / 1-3", desc: "Switch between Dashboard, Profiles, Status tabs" },
  { key: "s", desc: "Sync config from git (pull)" },
  { key: "a", desc: "Apply config to all detected adapters" },
  { key: "P (shift+p)", desc: "Push config to remote" },
  { key: "A (shift+a)", desc: "Add server (shows CLI hint)" },
  { key: "D (shift+d)", desc: "Remove selected server" },
  { key: "E (shift+e)", desc: "View server details (with edit hint)" },
  { key: "I (shift+i)", desc: "Import from all detected tools" },
  { key: "Up/Down", desc: "Navigate server list" },
  { key: "p", desc: "Open profile switcher" },
  { key: "t", desc: "Open status view" },
  { key: "?", desc: "Show this help" },
  { key: "q", desc: "Quit" },
  { key: "", desc: "" },
  { key: "Profile Switcher", desc: "" },
  { key: "Up/Down", desc: "Navigate profiles" },
  { key: "Enter", desc: "Switch to selected profile" },
  { key: "Esc/q", desc: "Back to dashboard" },
  { key: "", desc: "" },
  { key: "Server Detail", desc: "" },
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
            // biome-ignore lint/suspicious/noArrayIndexKey: spacer elements have no stable key
            <Box key={`spacer-${i}`}>
              <Text> </Text>
            </Box>
          ) : s.desc === "" ? (
            <Box key={s.key}>
              <Text bold> {s.key}</Text>
            </Box>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: duplicate keys possible across sections
            <Box key={`${s.key}-${i}`}>
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

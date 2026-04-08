import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  profiles: string[];
  descriptions: Record<string, string>;
  currentProfile: string;
  onSelect: (profile: string) => void;
  onBack: () => void;
}

export function ProfileSwitcher({
  profiles,
  descriptions,
  currentProfile,
  onSelect,
  onBack,
}: Props) {
  const [cursor, setCursor] = useState(
    Math.max(0, profiles.indexOf(currentProfile)),
  );

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(profiles.length - 1, c + 1));
    } else if (key.return) {
      if (profiles[cursor]) {
        onSelect(profiles[cursor]);
      }
    } else if (input === "q" || key.escape) {
      onBack();
    }
  });

  if (profiles.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>  Switch Profile</Text>
        <Box marginTop={1}>
          <Text dimColor>  No profiles configured. Add profiles in config.toml.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>  [q] back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>  Switch Profile</Text>
      <Box marginTop={1} flexDirection="column">
        {profiles.map((name, i) => {
          const isCurrent = name === currentProfile;
          const isSelected = i === cursor;
          const desc = descriptions[name] || "";
          return (
            <Box key={name}>
              <Text>
                {"  "}
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? "▸ " : "  "}
                  {name.padEnd(16)}
                </Text>
                <Text dimColor>{desc.padEnd(30)}</Text>
                {isCurrent && <Text color="green"> (active)</Text>}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {"  "}Current: <Text color="cyan">{currentProfile}</Text>
          {"  "}[Enter] switch  [q/Esc] back
        </Text>
      </Box>
    </Box>
  );
}

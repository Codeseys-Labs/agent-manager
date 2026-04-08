import React from "react";
import { Box, Text } from "ink";
import type { TuiData } from "./data.ts";

interface Props {
  data: TuiData;
  onBack: () => void;
}

export function StatusView({ data, onBack }: Props) {
  const { git, adapters, profileName, servers } = data;

  const activeCount = servers.filter((s) => s.enabled).length;

  return (
    <Box flexDirection="column">
      {/* Git sync state */}
      <Text bold>  Git Sync</Text>
      <Box>
        <Text dimColor>  {"─".repeat(50)}</Text>
      </Box>
      <Box>
        <Text>
          {"  "}Branch: <Text bold>{git.branch}</Text>
        </Text>
      </Box>
      <Box>
        <Text>
          {"  "}Status:{" "}
          <Text color={git.clean ? "green" : "yellow"}>
            {git.clean ? "clean" : `${git.dirty.length} uncommitted change(s)`}
          </Text>
        </Text>
      </Box>
      {git.remotes.length > 0 ? (
        <Box>
          <Text>
            {"  "}Remote: <Text dimColor>{git.remotes[0].url}</Text>
          </Text>
        </Box>
      ) : (
        <Box>
          <Text>
            {"  "}Remote: <Text color="yellow">none (run `am push` to set up)</Text>
          </Text>
        </Box>
      )}

      {/* Dirty files */}
      {git.dirty.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>  Uncommitted Files</Text>
          <Box>
            <Text dimColor>  {"─".repeat(50)}</Text>
          </Box>
          {git.dirty.slice(0, 10).map((f) => (
            <Box key={f}>
              <Text>
                {"  "}<Text color="yellow">M</Text> {f}
              </Text>
            </Box>
          ))}
          {git.dirty.length > 10 && (
            <Box>
              <Text dimColor>  ... and {git.dirty.length - 10} more</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Adapter drift */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>  Adapter Drift</Text>
        <Box>
          <Text dimColor>  {"─".repeat(50)}</Text>
        </Box>
        {adapters.length === 0 ? (
          <Box>
            <Text dimColor>  No adapters detected on this system.</Text>
          </Box>
        ) : (
          adapters.map((a) => {
            const icon =
              a.status === "in-sync"
                ? "●"
                : a.status === "drifted"
                  ? "⚠"
                  : "○";
            const color =
              a.status === "in-sync"
                ? "green"
                : a.status === "drifted"
                  ? "yellow"
                  : "gray";
            return (
              <Box key={a.name}>
                <Text>
                  {"  "}
                  <Text color={color}>{icon} </Text>
                  {a.name.padEnd(20)}
                  <Text color={color}>
                    {a.status === "in-sync"
                      ? "in sync"
                      : a.status === "drifted"
                        ? `${a.changes} change(s) — run \`am apply\` to fix`
                        : a.status}
                  </Text>
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* Summary */}
      <Box marginTop={1}>
        <Text>
          {"  "}Profile: <Text color="cyan">{profileName}</Text>
          {"  "}Servers: <Text bold>{activeCount}/{servers.length}</Text>
          {"  "}Adapters: <Text bold>{adapters.length}</Text>
        </Text>
      </Box>

      {/* Suggestions */}
      {(adapters.some((a) => a.status === "drifted") || !git.clean) && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">  Suggestions</Text>
          {adapters.some((a) => a.status === "drifted") && (
            <Box>
              <Text>  {"  "}Run <Text bold>am apply</Text> to sync adapter configs</Text>
            </Box>
          )}
          {!git.clean && (
            <Box>
              <Text>  {"  "}Run <Text bold>am push</Text> to commit and push changes</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>  [q/Esc] back to dashboard</Text>
      </Box>
    </Box>
  );
}

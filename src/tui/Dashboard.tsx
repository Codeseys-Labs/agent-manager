import { Box, Text } from "silvery";
import React from "react";
import type { TuiData } from "./data.ts";

interface Props {
  data: TuiData;
  onSync: () => void;
  onApply: () => void;
}

function statusIcon(enabled: boolean): string {
  return enabled ? "●" : "○";
}

function statusColor(enabled: boolean): string {
  return enabled ? "green" : "gray";
}

export function Dashboard({ data, onSync, onApply }: Props) {
  const { profileName, servers, adapters, git } = data;

  const activeCount = servers.filter((s) => s.enabled).length;
  const totalCount = servers.length;

  return (
    <Box flexDirection="column">
      {/* Header info */}
      <Box marginBottom={1}>
        <Text>
          Profile:{" "}
          <Text bold color="cyan">
            {profileName}
          </Text>
          {"  "}Servers:{" "}
          <Text bold>
            {activeCount}/{totalCount}
          </Text>
          {"  "}Git: <Text bold>{git.branch}</Text>{" "}
          <Text color={git.clean ? "green" : "yellow"}>
            ({git.clean ? "clean" : `${git.dirty.length} dirty`})
          </Text>
        </Text>
      </Box>

      {/* Server table */}
      <Box flexDirection="column">
        <Box>
          <Text bold>
            {"  "}
            {"Name".padEnd(24)}
            {"Command".padEnd(30)}
            {"Tags".padEnd(20)}
            {"Status"}
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            {"  "}
            {"─".repeat(24)}
            {"─".repeat(30)}
            {"─".repeat(20)}
            {"─".repeat(10)}
          </Text>
        </Box>
        {servers.length === 0 ? (
          <Box>
            <Text dimColor> No servers configured. Run `am add` to add one.</Text>
          </Box>
        ) : (
          servers.map((s) => (
            <Box key={s.name}>
              <Text>
                {"  "}
                <Text color={statusColor(s.enabled)}>{statusIcon(s.enabled)} </Text>
                {s.name.padEnd(22)}
                <Text dimColor>{s.command.padEnd(30)}</Text>
                <Text dimColor>{(s.tags.join(", ") || "—").padEnd(20)}</Text>
                <Text color={s.enabled ? "green" : "gray"}>
                  {s.enabled ? "active" : "disabled"}
                </Text>
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Adapter drift */}
      {adapters.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold> Tool Sync Status</Text>
          <Box>
            <Text dimColor> {"─".repeat(50)}</Text>
          </Box>
          {adapters.map((a) => {
            const icon = a.status === "in-sync" ? "●" : a.status === "drifted" ? "⚠" : "○";
            const color =
              a.status === "in-sync" ? "green" : a.status === "drifted" ? "yellow" : "gray";
            const label =
              a.status === "in-sync"
                ? "in sync"
                : a.status === "drifted"
                  ? `drift (${a.changes} change${a.changes !== 1 ? "s" : ""})`
                  : a.status;
            return (
              <Box key={a.name}>
                <Text>
                  {"  "}
                  <Text color={color}>{icon} </Text>
                  {a.name.padEnd(20)}
                  <Text color={color}>{label}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{"  "}[s]ync [a]pply [p]rofiles [t]status [q]uit [?]help</Text>
      </Box>
    </Box>
  );
}

import React, { useState } from "react";
import { Box, Text, useInput } from "silvery";
import type { TuiData } from "./data.ts";

type DashboardMode = "list" | "confirm-delete" | "server-detail";

interface Props {
  data: TuiData;
  onSync: () => void;
  // SEC-4c: App owns the apply keybindings (`a` = safe/gated, `F` = force) and
  // surfaces the summary via showMessage; the Dashboard only renders the footer
  // hint and never invokes apply directly, so it takes App's void-wrapper.
  onApply: (force?: boolean) => void;
  onRemoveServer?: (serverName: string) => Promise<string>;
  onImport?: () => Promise<string>;
  showMessage?: (msg: string) => void;
}

function statusIcon(enabled: boolean): string {
  return enabled ? "●" : "○";
}

function statusColor(enabled: boolean): string {
  return enabled ? "green" : "gray";
}

export function Dashboard({ data, onSync, onApply, onRemoveServer, onImport, showMessage }: Props) {
  const { profileName, servers, adapters, git } = data;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<DashboardMode>("list");

  const activeCount = servers.filter((s) => s.enabled).length;
  const totalCount = servers.length;

  const selectedServer = servers[selectedIndex] ?? null;

  useInput(
    (input, key) => {
      if (mode === "confirm-delete") {
        if (input === "y" || input === "Y") {
          if (selectedServer && onRemoveServer) {
            onRemoveServer(selectedServer.name).then((msg) => {
              showMessage?.(msg);
            });
          }
          setMode("list");
        } else {
          setMode("list");
        }
        return;
      }

      if (mode === "server-detail") {
        if (input === "q" || key.escape) {
          setMode("list");
        }
        return;
      }

      // List mode navigation
      if (key.upArrow && servers.length > 0) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow && servers.length > 0) {
        setSelectedIndex((i) => Math.min(servers.length - 1, i + 1));
        return;
      }
      if (input === "D" && selectedServer && onRemoveServer) {
        setMode("confirm-delete");
        return;
      }
      if (input === "E" && selectedServer) {
        setMode("server-detail");
        return;
      }
      if (input === "I" && onImport) {
        showMessage?.("Importing...");
        onImport().then((msg) => {
          showMessage?.(msg);
        });
        return;
      }
    },
    { isActive: true },
  );

  // Server detail view
  if (mode === "server-detail" && selectedServer) {
    return (
      <Box flexDirection="column">
        <Text bold> Server: {selectedServer.name}</Text>
        <Box>
          <Text dimColor> {"─".repeat(50)}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text>
              {"  "}
              <Text bold>command: </Text>
              {selectedServer.command}
            </Text>
          </Box>
          <Box>
            <Text>
              {"  "}
              <Text bold>args: </Text>
              {selectedServer.args.length > 0 ? `[${selectedServer.args.join(", ")}]` : "[]"}
            </Text>
          </Box>
          <Box>
            <Text>
              {"  "}
              <Text bold>tags: </Text>
              {selectedServer.tags.length > 0 ? selectedServer.tags.join(", ") : "—"}
            </Text>
          </Box>
          <Box>
            <Text>
              {"  "}
              <Text bold>transport:</Text> {selectedServer.transport}
            </Text>
          </Box>
          <Box>
            <Text>
              {"  "}
              <Text bold>enabled: </Text>
              <Text color={selectedServer.enabled ? "green" : "gray"}>
                {String(selectedServer.enabled)}
              </Text>
            </Text>
          </Box>
          {selectedServer.description && (
            <Box>
              <Text>
                {"  "}
                <Text bold>desc: </Text>
                {selectedServer.description}
              </Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor> Edit via CLI: am config edit</Text>
          <Text dimColor>
            {" "}
            Or: am add server {selectedServer.name} --command "..." (will prompt to replace)
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor> [q/Esc] back</Text>
        </Box>
      </Box>
    );
  }

  // Confirm delete dialog
  if (mode === "confirm-delete" && selectedServer) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow"> Delete server '{selectedServer.name}'? [y/n]</Text>
        </Box>
      </Box>
    );
  }

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
          servers.map((s, i) => {
            const isSelected = i === selectedIndex;
            return (
              <Box key={s.name}>
                <Text>
                  {isSelected ? (
                    <Text color="cyan" bold>
                      {"▸ "}
                    </Text>
                  ) : (
                    <Text>{"  "}</Text>
                  )}
                  <Text color={statusColor(s.enabled)}>{statusIcon(s.enabled)} </Text>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {s.name.padEnd(22)}
                  </Text>
                  <Text dimColor>{s.command.padEnd(30)}</Text>
                  <Text dimColor>{(s.tags.join(", ") || "—").padEnd(20)}</Text>
                  <Text color={s.enabled ? "green" : "gray"}>
                    {s.enabled ? "active" : "disabled"}
                  </Text>
                </Text>
              </Box>
            );
          })
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
        <Text dimColor>
          {"  "}[s]ync [a]pply [F]orce-apply [P]ush [A]dd [D]elete [E]dit [I]mport [p]rofiles
          [t]status [q]uit [?]help
        </Text>
      </Box>
      {servers.length > 0 && (
        <Box>
          <Text dimColor>{"  "}[Up/Down] navigate servers</Text>
        </Box>
      )}
    </Box>
  );
}

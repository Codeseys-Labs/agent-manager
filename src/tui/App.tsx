import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "silvery";
import { Dashboard } from "./Dashboard.tsx";
import { HelpView } from "./HelpView.tsx";
import { ProfileSwitcher } from "./ProfileSwitcher.tsx";
import { StatusView } from "./StatusView.tsx";
import type { TuiData } from "./data.ts";

type View = "dashboard" | "profiles" | "status" | "help";

const TABS: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "profiles", label: "Profiles" },
  { id: "status", label: "Status" },
];

interface Props {
  initialData: TuiData;
  onProfileSwitch: (profile: string) => Promise<void>;
  onSync: () => Promise<void>;
  // SEC-4c: apply now returns a human-readable summary (which tools were
  // written, which were SKIPPED by the fail-closed drift gate) and accepts an
  // explicit `force` to overwrite a drifted target on purpose.
  onApply: (force?: boolean) => Promise<string>;
  onPush: () => Promise<string>;
  onAddServer: () => Promise<string>;
  onRemoveServer: (serverName: string) => Promise<string>;
  onImport: () => Promise<string>;
}

export function App({
  initialData,
  onProfileSwitch,
  onSync,
  onApply,
  onPush,
  onAddServer,
  onRemoveServer,
  onImport,
}: Props) {
  const { exit } = useApp();
  const [view, setView] = useState<View>("dashboard");
  const [data, setData] = useState<TuiData>(initialData);
  const [message, setMessage] = useState<string | null>(null);

  const showMessage = useCallback((msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const handleSync = useCallback(async () => {
    showMessage("Syncing...");
    try {
      await onSync();
      showMessage("Sync complete");
    } catch (err: any) {
      showMessage(`Sync failed: ${err.message}`);
    }
  }, [onSync, showMessage]);

  const handleApply = useCallback(
    async (force = false) => {
      showMessage(force ? "Force-applying..." : "Applying...");
      try {
        // SEC-4c: surface the apply summary verbatim — when the fail-closed
        // drift gate skips a tool, the message names it and prompts [F] to
        // force-overwrite. Default (`a`) is the SAFE, gated apply.
        const result = await onApply(force);
        showMessage(result);
      } catch (err: any) {
        showMessage(`Apply failed: ${err.message}`);
      }
    },
    [onApply, showMessage],
  );

  const handlePush = useCallback(async () => {
    showMessage("Pushing...");
    try {
      const result = await onPush();
      showMessage(result);
    } catch (err: any) {
      showMessage(`Push failed: ${err.message}`);
    }
  }, [onPush, showMessage]);

  const handleAddServer = useCallback(async () => {
    try {
      const result = await onAddServer();
      showMessage(result);
    } catch (err: any) {
      showMessage(`Add server failed: ${err.message}`);
    }
  }, [onAddServer, showMessage]);

  const handleRemoveServer = useCallback(
    async (serverName: string): Promise<string> => {
      try {
        const result = await onRemoveServer(serverName);
        // Update local data to remove the server from the list
        setData((prev) => ({
          ...prev,
          servers: prev.servers.filter((s) => s.name !== serverName),
        }));
        return result;
      } catch (err: any) {
        return `Remove failed: ${err.message}`;
      }
    },
    [onRemoveServer],
  );

  const handleImport = useCallback(async (): Promise<string> => {
    try {
      const result = await onImport();
      return result;
    } catch (err: any) {
      return `Import failed: ${err.message}`;
    }
  }, [onImport]);

  const handleProfileSelect = useCallback(
    async (profile: string) => {
      showMessage(`Switching to ${profile}...`);
      try {
        await onProfileSwitch(profile);
        setData((prev) => ({ ...prev, profileName: profile }));
        showMessage(`Profile switched to ${profile}`);
        setView("dashboard");
      } catch (err: any) {
        showMessage(`Switch failed: ${err.message}`);
      }
    },
    [onProfileSwitch, showMessage],
  );

  // Global key handling (only when not in a sub-view that handles its own keys)
  useInput(
    (input, key) => {
      if (input === "q") {
        exit();
        return;
      }
      if (input === "?") {
        setView((v) => (v === "help" ? "dashboard" : "help"));
        return;
      }
      if (input === "s") {
        handleSync();
        return;
      }
      if (input === "a") {
        handleApply(false);
        return;
      }
      // SEC-4c: explicit force-overwrite path, consistent with the CLI's
      // `--force`. `a` is the safe (drift-gated) apply; `F` overwrites a
      // drifted native config on purpose after the gate flagged it.
      if (input === "F") {
        handleApply(true);
        return;
      }
      if (input === "P") {
        handlePush();
        return;
      }
      if (input === "A") {
        handleAddServer();
        return;
      }
      if (input === "p") {
        setView("profiles");
        return;
      }
      if (input === "t") {
        setView("status");
        return;
      }
      if (key.tab) {
        setView((current) => {
          const idx = TABS.findIndex((t) => t.id === current);
          if (idx === -1) return "dashboard";
          return TABS[(idx + 1) % TABS.length].id;
        });
        return;
      }
      if (input === "1") setView("dashboard");
      if (input === "2") setView("profiles");
      if (input === "3") setView("status");
    },
    { isActive: view === "dashboard" },
  );

  return (
    <Box flexDirection="column">
      {/* Title bar */}
      <Box>
        <Text bold color="cyan">
          {"  "}agent-manager v0.1.0
        </Text>
        <Text>{"  "}</Text>
        <Text dimColor>
          Profile: <Text color="cyan">{data.profileName}</Text>
        </Text>
      </Box>

      {/* Tab bar */}
      <Box marginTop={1}>
        <Text>{"  "}</Text>
        {TABS.map((tab, i) => {
          const isActive = view === tab.id || (view === "help" && tab.id === "dashboard");
          return (
            <React.Fragment key={tab.id}>
              {i > 0 && <Text dimColor>{" | "}</Text>}
              <Text bold={isActive} color={isActive ? "cyan" : undefined} inverse={isActive}>
                {` ${i + 1}:${tab.label} `}
              </Text>
            </React.Fragment>
          );
        })}
        {view === "help" && (
          <>
            <Text dimColor>{" | "}</Text>
            <Text bold color="cyan" inverse>
              {" ?:Help "}
            </Text>
          </>
        )}
      </Box>
      <Box>
        <Text dimColor> {"─".repeat(60)}</Text>
      </Box>

      {/* Content area */}
      <Box flexDirection="column" marginTop={1}>
        {view === "dashboard" && (
          <Dashboard
            data={data}
            onSync={handleSync}
            onApply={handleApply}
            onRemoveServer={handleRemoveServer}
            onImport={handleImport}
            showMessage={showMessage}
          />
        )}
        {view === "profiles" && (
          <ProfileSwitcher
            profiles={data.profiles}
            descriptions={data.profileDescriptions}
            currentProfile={data.profileName}
            onSelect={handleProfileSelect}
            onBack={() => setView("dashboard")}
          />
        )}
        {view === "status" && <StatusView data={data} onBack={() => setView("dashboard")} />}
        {view === "help" && <HelpView onBack={() => setView("dashboard")} />}
      </Box>

      {/* Status bar */}
      {message && (
        <Box marginTop={1}>
          <Text color="yellow"> {message}</Text>
        </Box>
      )}
    </Box>
  );
}

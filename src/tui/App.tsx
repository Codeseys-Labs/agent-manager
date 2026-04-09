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
  onApply: () => Promise<void>;
}

export function App({ initialData, onProfileSwitch, onSync, onApply }: Props) {
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

  const handleApply = useCallback(async () => {
    showMessage("Applying...");
    try {
      await onApply();
      showMessage("Apply complete");
    } catch (err: any) {
      showMessage(`Apply failed: ${err.message}`);
    }
  }, [onApply, showMessage]);

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
        handleApply();
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
          <Dashboard data={data} onSync={handleSync} onApply={handleApply} />
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

/**
 * `am setup` — first-run setup wizard (ADR-0053, docs/design/am-setup-wizard.md).
 *
 * A single guided, resumable, non-interactive-capable command that takes a
 * stranger from "just installed `am`" to "native configs written + green
 * health check" without reading source. It does NOT replace the granular
 * commands (`am init`, `am import`, `am apply`, `am doctor`) — it sequences
 * them, and each remains independently usable.
 *
 * This module is pure orchestration: every capability it uses already exists
 * and is tested elsewhere. The mapping:
 *   - probe / health   → collectDoctorChecks (commands/doctor.ts)
 *   - tool detection    → getDetectedAdapters (adapters/registry)
 *   - fresh config      → withConfig + initRepo (controller + core/git, mirrors init.ts)
 *   - clone-from-remote → cloneRepo (core/git)
 *   - secrets (AES)     → generateKey / saveKey / loadKey (core/secrets)
 *   - apply             → applyResolved + ADR-0038 dry-run envelope (controller)
 *
 * Mode resolution (ADR-0053 step 0):
 *   interactive = isTTY && !--yes && !--non-interactive && !--json && !CI
 * Non-interactive resolves every value from flag > env > existing config >
 * default; a required value with no source is a structured error, never a hang.
 *
 * NOTE ON SECRETS (Wave 2 fence): only the legacy AES backend (ADR-0012) is
 * offered here. The age backend (ADR-0042) is fenced until its apply-path
 * runtime is fixed and integration-tested — the wizard MUST NOT offer the age
 * path. See ADR-0053 step 3 and ADR-0042 status.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { getDetectedAdapters } from "../adapters/registry";
import type { Adapter } from "../adapters/types";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { applyResolved, withConfig } from "../core/controller";
import { cloneRepo, getStatus, initRepo } from "../core/git";
import type { Config } from "../core/schema";
import { generateKey, loadKey, resolveKeyPath, saveKey } from "../core/secrets";
import { collectDoctorChecks } from "./doctor";

/**
 * Test-only adapter-detection seam (mirrors `__setAdapterResolverForTests`
 * in core/controller.ts and the `__set…ForTests` pattern in commands/run.ts).
 * When set, the wizard resolves detected adapters via this override instead of
 * the real registry, so command-level tests can drive `setupCommand.run()`
 * WITHOUT detecting (and applying to) the real machine's tools. Tests that
 * exercise the apply step should ALSO set the controller's
 * `__setAdapterResolverForTests` so `applyResolved` agrees. Never set in prod.
 */
let detectedAdaptersOverride: (() => Promise<Adapter[]>) | null = null;

/** @internal test seam — see `detectedAdaptersOverride`. */
export function __setDetectedAdaptersForTests(fn: (() => Promise<Adapter[]>) | null): void {
  detectedAdaptersOverride = fn;
}

async function resolveDetectedAdapters(): Promise<Adapter[]> {
  return detectedAdaptersOverride ? detectedAdaptersOverride() : getDetectedAdapters();
}

/**
 * The secret-encryption choices offered by the wizard's step 3.
 *
 * Wave 2 fence (ADR-0053 step 3 / ADR-0042 status): ONLY the legacy AES
 * backend (ADR-0012) is offered. The age backend is fenced until its
 * apply-path runtime is fixed and integration-tested. This is a pure function
 * so the contract ("never offers age") is directly assertable in tests without
 * mocking the prompt library.
 */
export function secretsBackendOptions(): Array<{ value: "generate" | "skip"; label: string }> {
  return [
    { value: "generate", label: "Generate a new encryption key (AES-256-GCM, recommended)" },
    { value: "skip", label: "Skip — set up secrets later" },
  ];
}

/** Resolve a `user/repo` (or `host/user/repo`) shorthand into a clone URL. */
export function guessRepoUrl(input: string, opts: { ssh?: boolean } = {}): string {
  const raw = input.trim();
  // Already a full URL, scp-style, or a local path — pass through untouched.
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || // http(s)://, ssh://, git://, file://
    /^[^/]+@[^/]+:/.test(raw) || // git@host:org/repo
    raw.startsWith("/") ||
    raw.startsWith(".") ||
    /^[a-zA-Z]:[\\/]/.test(raw) // Windows drive path
  ) {
    return raw;
  }
  // chezmoi-style shorthand. Default host is github.com.
  let host = "github.com";
  let path = raw;
  const parts = raw.split("/");
  if (parts.length >= 3) {
    // host/user/repo
    host = parts[0];
    path = parts.slice(1).join("/");
  }
  const repoPath = path.endsWith(".git") ? path : `${path}.git`;
  return opts.ssh ? `git@${host}:${repoPath}` : `https://${host}/${repoPath}`;
}

interface StepState {
  configExists: boolean;
  hasGit: boolean;
  hasKey: boolean;
  hasRemote: boolean;
  remoteUrl?: string;
  detectedNames: string[];
  detectedAdapterNames: string[];
  currentProfile?: string;
}

/** Render the doctor `Check[]` as plain lines via clack.log. */
function renderChecks(checks: Awaited<ReturnType<typeof collectDoctorChecks>>): void {
  const icons: Record<string, string> = { ok: "+", warn: "!", fail: "x" };
  for (const check of checks) {
    const line = `[${icons[check.status]}] ${check.name}: ${check.message}`;
    if (check.status === "fail") clack.log.error(line);
    else if (check.status === "warn") clack.log.warn(line);
    else clack.log.success(line);
  }
}

export const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description: "Guided first-run setup: detect tools, import, configure secrets, apply",
  },
  args: {
    from: {
      type: "string",
      description: "Clone an existing catalog from a git URL or user/repo shorthand",
    },
    ssh: { type: "boolean", description: "Use SSH for the --from shorthand clone", default: false },
    tools: { type: "string", description: "Comma-separated adapter names to target on apply" },
    profile: { type: "string", description: "Profile to create / select (default: 'default')" },
    "no-apply": {
      type: "boolean",
      description: "Stop before writing native configs (skip the apply step)",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing non-default profile or a drifted apply",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Non-interactive: accept all defaults, never prompt",
      default: false,
    },
    "non-interactive": {
      type: "boolean",
      description: "Non-interactive: resolve from flag > env > config > default, never prompt",
      default: false,
    },
    json: {
      type: "boolean",
      description: "JSON output (emits the doctor Check[])",
      default: false,
    },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    const quiet = Boolean(args.quiet);

    // ── Step 0: mode resolution ──────────────────────────────────────
    const interactive =
      Boolean(process.stdin.isTTY) &&
      !args.yes &&
      !args["non-interactive"] &&
      !json &&
      !process.env.CI;

    const log = (msg: string): void => {
      if (interactive) clack.log.message(msg);
      else if (!json && !quiet) console.log(msg);
    };

    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    if (interactive) {
      clack.intro("agent-manager setup");
    }

    try {
      // ── Step 1: state probe (idempotency) ──────────────────────────
      await mkdir(configDir, { recursive: true });
      const existing = await tryReadConfig(configPath);
      const detected = await resolveDetectedAdapters();
      let hasGit = false;
      let hasRemote = false;
      let remoteUrl: string | undefined;
      try {
        const status = await getStatus(configDir);
        hasGit = true;
        hasRemote = status.remotes.length > 0;
        remoteUrl = status.remotes[0]?.url;
      } catch {
        // Not a git repo yet — first-run.
      }
      const key = await loadKey(configDir);

      const state: StepState = {
        configExists: existing !== null,
        hasGit,
        hasRemote,
        remoteUrl,
        detectedNames: detected.map((a) => a.meta.displayName),
        detectedAdapterNames: detected.map((a) => a.meta.name),
        hasKey: key !== null,
        currentProfile: existing?.settings?.default_profile,
      };

      if (interactive) {
        const summary = [
          `Config:   ${state.configExists ? "present" : "not yet created"} (${configDir})`,
          `Git repo: ${state.hasGit ? "initialized" : "not yet initialized"}`,
          `Remote:   ${state.hasRemote ? state.remoteUrl : "none"}`,
          `Key:      ${state.hasKey ? "present" : "none"}`,
          `Tools:    ${state.detectedNames.length > 0 ? state.detectedNames.join(", ") : "none detected"}`,
        ].join("\n");
        clack.note(summary, state.configExists ? "Existing setup (review)" : "Fresh machine");
      } else {
        log(
          `setup probe: config=${state.configExists ? "present" : "absent"}, git=${state.hasGit}, remote=${state.hasRemote}, key=${state.hasKey}, tools=[${state.detectedNames.join(", ")}]`,
        );
      }

      // ── Step 2: fresh vs clone-from-remote ─────────────────────────
      let cloned = false;
      // Determine the clone source: explicit --from, or an interactive prompt
      // when no config exists yet.
      let fromUrl: string | undefined = args.from
        ? guessRepoUrl(args.from, { ssh: Boolean(args.ssh) })
        : undefined;

      if (!fromUrl && interactive && !state.configExists) {
        const wantsClone = await clack.confirm({
          message: "Clone an existing catalog from a git remote (new-machine setup)?",
          initialValue: false,
        });
        if (clack.isCancel(wantsClone)) return cancel(interactive);
        if (wantsClone) {
          const url = await clack.text({
            message: "Git URL or user/repo shorthand:",
            placeholder: "user/agent-manager-config",
            validate: (v) => (v.trim() ? undefined : "A URL or shorthand is required"),
          });
          if (clack.isCancel(url)) return cancel(interactive);
          fromUrl = guessRepoUrl(String(url), { ssh: Boolean(args.ssh) });
        }
      }

      if (fromUrl) {
        if (state.configExists && !args.force) {
          // Idempotency: never clobber an existing catalog. Surface clearly
          // and continue with the existing config (review mode).
          log(
            `Config already exists at ${configPath}; skipping clone of ${fromUrl} (re-run with --force to replace). Continuing with existing config.`,
          );
        } else if (state.hasGit && !args.force) {
          log(
            `${configDir} is already a git repo; skipping clone of ${fromUrl} (re-run with --force to replace).`,
          );
        } else {
          const spin = interactive ? clack.spinner() : null;
          spin?.start(`Cloning ${fromUrl}`);
          try {
            await cloneRepo(configDir, fromUrl);
            cloned = true;
            spin?.stop(`Cloned ${fromUrl}`);
            log(`Cloned catalog from ${fromUrl} into ${configDir}`);
          } catch (err) {
            spin?.stop("Clone failed");
            throw new Error(
              `Could not clone ${fromUrl}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      // Re-probe config after a potential clone.
      const afterClone = await tryReadConfig(configPath);

      // Fresh config when neither an existing config nor a clone produced one.
      if (!afterClone) {
        // First-run: initialize the git repo (idempotent guard) + write the
        // default Config under the controller's lock. Mirrors init.ts. We use
        // noCommit so a fresh repo stays at exactly one commit (the init
        // commit) — matching `am init` semantics and keeping `am undo` honest.
        if (!state.hasGit) {
          await initRepo(configDir);
        }
        const profileName = resolveProfileName(args, state, interactive);
        await withConfig(
          configDir,
          async (draft) => {
            if (draft) {
              // Raced into existence — never clobber.
              return { result: undefined, changed: false };
            }
            const newConfig: Config = {
              settings: { default_profile: profileName },
              servers: {},
              profiles: {
                [profileName]: { description: `Default profile — all servers (${profileName})` },
              },
            };
            return { result: undefined, changed: true, updated: newConfig };
          },
          { noCommit: true },
        );
        log(`Initialized agent-manager config at ${configDir}`);
      }

      // Refresh the profile view from whatever now lives on disk (a clone may
      // carry its own default_profile; a fresh write set ours). This keeps the
      // profile-bootstrap step (5) from clobbering a cloned catalog's default.
      const onDisk = await tryReadConfig(configPath);
      state.currentProfile = onDisk?.settings?.default_profile ?? state.currentProfile;
      state.configExists = onDisk !== null;

      // ── Step 3: secrets (AES legacy only — age fenced for v1) ──────
      let keyGenerated = false;
      if (!state.hasKey && !cloned) {
        if (interactive) {
          const choice = await clack.select({
            message: "Secret encryption (AES-256-GCM):",
            options: secretsBackendOptions(),
            initialValue: "generate",
          });
          if (clack.isCancel(choice)) return cancel(interactive);
          if (choice === "generate") {
            await saveKey(configDir, await generateKey());
            keyGenerated = true;
            clack.note(
              `Encryption key saved to ${resolveKeyPath()}\nSave this — it lives OUTSIDE the git-tracked config dir and is gitignored.\nUse \`am secret set <name> <value>\` to encrypt secrets.`,
              "Key generated",
            );
          }
        }
        // Non-interactive: do NOT silently generate a key — that would write a
        // machine secret without consent. Leave it absent (doctor warns).
      } else if (state.hasKey) {
        log(`Encryption key present at ${resolveKeyPath()}`);
      }

      // ── Step 4: tool selection ─────────────────────────────────────
      let selectedTools: string[] = state.detectedAdapterNames;
      if (args.tools) {
        selectedTools = String(args.tools)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (interactive && state.detectedAdapterNames.length > 0) {
        const picked = await clack.multiselect<string>({
          message: "Which tools should agent-manager manage?",
          options: detected.map((a) => ({ value: a.meta.name, label: a.meta.displayName })),
          initialValues: state.detectedAdapterNames,
          required: false,
        });
        if (clack.isCancel(picked)) return cancel(interactive);
        selectedTools = picked as string[];
      }

      // ── Step 5: profile bootstrap ──────────────────────────────────
      const profileName = resolveProfileName(args, state, interactive);
      let profileChosen = profileName;
      if (interactive && !args.profile) {
        const entered = await clack.text({
          message: "Profile to use:",
          placeholder: "default",
          initialValue: state.currentProfile ?? "default",
        });
        if (clack.isCancel(entered)) return cancel(interactive);
        profileChosen = String(entered).trim() || "default";
      }

      // Materialize an explicit profile so apply does not fail-open the whole
      // catalog (P1-H default-passthrough). Never clobber an existing
      // non-default profile without --force.
      await withConfig(configDir, async (draft) => {
        if (!draft) return { result: undefined, changed: false };
        if (!draft.settings) draft.settings = {};
        if (!draft.profiles) draft.profiles = {};
        const exists = draft.profiles[profileChosen] !== undefined;
        if (exists && !args.force) {
          // Just ensure it's the default profile; do not overwrite its body.
          if (draft.settings.default_profile !== profileChosen) {
            draft.settings.default_profile = profileChosen;
            return {
              result: undefined,
              changed: true,
              commitMessage: `setup: select profile ${profileChosen}`,
            };
          }
          return { result: undefined, changed: false };
        }
        draft.settings.default_profile = profileChosen;
        draft.profiles[profileChosen] = draft.profiles[profileChosen] ?? {
          description: `Profile ${profileChosen}`,
        };
        return {
          result: undefined,
          changed: true,
          commitMessage: `setup: bootstrap profile ${profileChosen}`,
        };
      });

      // ── Step 6: apply (dry-run preview → confirm → write) ──────────
      let applied = false;
      if (!args["no-apply"]) {
        const target = selectedTools.length === 1 ? selectedTools[0] : undefined;
        // Dry-run preview first (ADR-0038 envelope) so the user sees what would
        // change before any write.
        const preview = await applyResolved(configDir, {
          dryRun: true,
          profile: profileChosen,
          diff: true,
          target,
        });
        const wouldWrite = preview.results.reduce(
          (n, r) => n + r.files.filter((f) => f.path).length,
          0,
        );
        if (interactive) {
          const lines = preview.results.map(
            (r) => `${r.adapter}: ${r.files.length} file(s)${r.diff ? ` [${r.diff.status}]` : ""}`,
          );
          clack.note(
            lines.length > 0 ? lines.join("\n") : "No tools detected to apply to.",
            "Apply preview (dry-run)",
          );
          for (const notice of preview.notices) clack.log.warn(notice);
          const go = await clack.confirm({
            message: `Write native configs for ${preview.results.length} tool(s)?`,
            initialValue: true,
          });
          if (clack.isCancel(go)) return cancel(interactive);
          if (!go) {
            log("Apply skipped by user. Run `am apply` later.");
          } else {
            const real = await applyResolved(configDir, {
              profile: profileChosen,
              diff: true,
              force: Boolean(args.force),
              target,
            });
            applied = true;
            reportApply(real, log);
          }
        } else {
          // Non-interactive: apply directly (the run was explicitly requested
          // via --yes / --non-interactive / --json).
          const real = await applyResolved(configDir, {
            profile: profileChosen,
            diff: true,
            force: Boolean(args.force),
            target,
          });
          applied = true;
          if (!json) {
            log(
              `Applied profile "${profileChosen}" — ${real.succeeded.length} succeeded, ${real.skipped.length} skipped, ${real.failed.length} failed (${wouldWrite} file(s) previewed)`,
            );
          }
        }
      }

      // ── Step 7: green health check ─────────────────────────────────
      const checks = await collectDoctorChecks(configDir);
      const hasFailures = checks.some((c) => c.status === "fail");

      if (json) {
        // The structured contract: emit the doctor Check[] result.
        console.log(
          JSON.stringify(
            {
              action: "setup",
              configDir,
              cloned,
              keyGenerated,
              profile: profileChosen,
              tools: selectedTools,
              applied,
              healthy: !hasFailures,
              checks,
            },
            null,
            2,
          ),
        );
      } else if (interactive) {
        renderChecks(checks);
        if (hasFailures) {
          clack.log.error("Health check: FAIL");
        } else {
          clack.outro("Setup complete — health check passed.");
        }
      } else {
        const icons: Record<string, string> = { ok: "+", warn: "!", fail: "x" };
        if (!quiet) {
          for (const c of checks) log(`  [${icons[c.status]}] ${c.name}: ${c.message}`);
          log(hasFailures ? "Health check: FAIL" : "Health check: OK");
        }
      }

      if (hasFailures) {
        process.exitCode = 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) {
        console.error(JSON.stringify({ error: msg }));
      } else if (interactive) {
        clack.cancel(msg);
      } else {
        console.error(`error: ${msg}`);
      }
      process.exitCode = 1;
    }
  },
});

/**
 * Resolve the profile name per the ADR-0003 precedence: flag > existing
 * config's default > literal "default". Used both for the fresh-config write
 * and the profile-bootstrap step so they agree.
 */
function resolveProfileName(
  args: { profile?: string },
  state: StepState,
  _interactive: boolean,
): string {
  if (args.profile && String(args.profile).trim()) return String(args.profile).trim();
  if (state.currentProfile) return state.currentProfile;
  return "default";
}

/** Print an apply result via the surface's log function. */
function reportApply(
  result: Awaited<ReturnType<typeof applyResolved>>,
  log: (msg: string) => void,
): void {
  for (const s of result.succeeded) log(`  applied: ${s}`);
  for (const s of result.skipped) log(`  skipped: ${s}`);
  for (const f of result.failed) log(`  failed: ${f.adapter} — ${f.error}`);
}

/** Handle a clack cancel: print and set a non-zero exit code. */
function cancel(interactive: boolean): void {
  if (interactive) clack.cancel("Setup cancelled.");
  process.exitCode = 1;
}

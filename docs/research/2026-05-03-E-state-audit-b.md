# E-state audit B: can a novice install and get value today?

Verdict: **not reliably**. The source CLI can initialize cleanly, but the advertised distribution story is split across unverified/stale channels, and the first-run UX reaches a dead end unless the user already has supported tools installed.

## 1. The 10-minute novice test

1. `curl install.sh | sh`
   - `install.sh` exists and defaults to `~/.local/bin` (`install.sh:52-57`).
   - It calls GitHub `releases/latest`, strips `v`, then downloads `checksums.sha256`, `am-${os}-${arch}`, and `am-acp-shell-${os}-${arch}` (`install.sh:105-121`, `install.sh:152-164`, `install.sh:187-217`).
   - Dry-run on Linux/x64 with `AM_VERSION=0.5.0-rc6` targets:
     - `.../v0.5.0-rc6/am-linux-x64`
     - `.../v0.5.0-rc6/am-acp-shell-linux-x64`
     - `.../v0.5.0-rc6/checksums.sha256`
   - Full install could not complete inside this sandbox: DNS failed at `github.com`. Remote tag presence was confirmed through the GitHub connector by fetching `package.json` at `v0.5.0-rc6`; local tags also show `v0.5.0-rc6`, `rc5`, `rc4`, `v0.4.0`, `v0.3.0`, `v0.2.0`.
   - Product status: **structurally plausible, not proven end-to-end**. The project log still says install-path E2E is blocked and needs verification (`docs/deep-work-log.md:19-26`, `docs/deep-work-log.md:401-402`).

2. `npm install -g agent-manager`
   - I attempted it with a temp prefix. This sandbox failed at DNS: `EAI_AGAIN registry.npmjs.org`.
   - Repo evidence says npm is still blocked on the missing GitHub Actions `NPM_TOKEN`; the publish step fails with `ENEEDAUTH`, and `npm install -g agent-manager` serves stale `0.5.0-rc3` (`docs/deep-work-log.md:13-17`, `docs/reviews/2026-04-18-acp-shell-wrapper/SESSION-EXIT-SUMMARY.md:83-92`).
   - `package.json` has the right bin mapping (`am`, `agent-manager`, `am-acp-shell`) and public publish config (`package.json:7-20`), but publishing is not current.

3. `am init`
   - Run as `HOME=/tmp/am-novice-home... AM_CONFIG_DIR=/tmp/am-novice-config... bun run src/cli.ts init`.
   - Interactive prompts:
     - “Generate an encryption key for secrets?” defaults Yes.
     - “Git remote URL for sync (leave empty to skip)” displays a GitHub placeholder even when the user presses Enter.
   - Result: `Initialized agent-manager at /tmp/am-novice-config...`.
   - Confusing moment: with no detected tools, it prints no next step. Code only suggests `am import auto` when `detectedNames.length > 0` (`src/commands/init.ts:154-158`). The created `config.toml` has an empty `servers = {}` and a default profile.

4. `am apply`
   - Fresh output: `No tools detected. Nothing to apply.`
   - This is accurate but not useful. The branch exits immediately at `src/commands/apply.ts:43-46`, with no hint like “install a supported tool,” “add an MCP server,” or “run `am agent list --runnable`.”

5. `am run claude "hello"`
   - In a PATH without `claude`, the source CLI printed `Connecting to claude...`, waited on ACP initialization, then failed: `Agent run failed: EPERM: operation not permitted, send`.
   - That is not graceful. `claude` resolves to `npx -y @agentclientprotocol/claude-agent-acp@latest` (`src/core/agent-registry.ts:91-99`). `am run` has a good preflight only for tier-2 `am-acp-shell` (`src/commands/run.ts:467-486`), but no native-agent preflight before spawning. The catch-all error is at `src/commands/run.ts:612-615`.

Likely first-message-after-install sequence:

```text
$ am init
Generate an encryption key for secrets? Yes
Git remote URL for sync (leave empty to skip):
Initialized agent-manager at ~/.config/agent-manager
$ am apply
No tools detected. Nothing to apply.
$ am run claude "hello"
Connecting to claude...
error: Agent run failed: EPERM: operation not permitted, send
```

## 2. Distribution status matrix

| Method | Works today? | Blocked on what? | ETA to ship? |
|---|---:|---|---|
| `curl | sh` | **Partial / unproven** | Needs live E2E against GitHub release assets; sandbox DNS blocked full run. `install.sh` now expects both binaries. | Same day if release assets are present; otherwise cut fresh rc and run E2E. |
| `npm install -g agent-manager` | **No** | Missing `NPM_TOKEN`; npm serves stale `0.5.0-rc3`. | Minutes after secret is added plus release job rerun/cut. |
| `brew tap Codeseys-Labs/am && brew install am` | **No for rc6 parity** | Checked-in `Formula/am.rb` installs only `am`, not `am-acp-shell` (`Formula/am.rb:29-32`), while the workflow template has the fixed resource install (`.github/workflows/release.yml:198-206`). | Same day: publish updated tap formula from the current template. |
| Binary download from releases | **Likely yes for `am`; unproven for full pair** | Needs manual verification that release assets include `am-*`, `am-acp-shell-*`, and matching checksums. | Same day smoke test. |

## 3. Top 3 novice papercuts

1. **Fresh init/apply is a dead end.** `am init` with no detected tools prints only initialization; `am apply` says nothing to apply. Code references: `src/commands/init.ts:154-158`, `src/commands/apply.ts:43-46`.

2. **`am run claude` fails opaquely when the native stack is absent.** The command does not preflight the actual local Claude dependency and ends in `EPERM ... send`. Code references: `src/core/agent-registry.ts:91-99`, `src/commands/run.ts:467-486`, `src/commands/run.ts:612-615`.

3. **Docs advertise channels that are not equally shippable.** README lists shell, Homebrew, and npm as peers (`README.md:104-115`), but npm is stale/blocked and the checked-in Formula lacks `am-acp-shell`.

## 4. Single shippable-in-1-day UX improvement

Ship **“novice first-run recovery hints”**.

Done condition:
- `am init` with zero detected tools prints: “No supported tools detected yet” plus three next commands: `am agent list --runnable`, `am add server <name>`, and `am search <query>`.
- `am apply` with zero detected tools prints the same recovery hint instead of only “Nothing to apply.”
- `am run claude "hello"` preflights native-agent prerequisites and fails before spawn with: “Claude Code CLI not found on PATH. Install Claude Code or run `am agent list --runnable`.”
- Tests cover zero-detected `init`, zero-result `apply`, and missing-native-agent `run`.

This is one PR, mostly message/preflight code, not blocked on npm, Homebrew, GitHub releases, or external credentials.

# Research: Best-in-Class First-Run CLI Setup Wizard UX (`am setup`)

**Date:** 2026-05-31
**Audience:** designers/implementers of `am setup` for agent-manager (`am`)
**Stack constraints:** Bun + TypeScript, citty for routing, `@clack/prompts@^0.9.1` for prompts, `withConfig` controller (ADR-0040) for serialized config writes, isomorphic-git (no system git), AES-256-GCM / age secrets (ADR-0042).

---

## 0. TL;DR

- The strongest onboarding tools **decompose** the flow into independent, individually-rerunnable commands (auth / init-config / link-remote / start / status) and make `setup` an *orchestrator* that calls each step. AWS, Supabase, Firebase, and chezmoi all do this. Monolithic wizards (one big prompt chain that mutates one global file) are the anti-pattern.
- Every interactive prompt must have a **fully non-interactive equivalent**: a flag, an env var, or stdin. `--quiet`/`--yes` alone is insufficient — every *required* value needs an alternate input channel (gh `--with-token`, gcloud `--account/--project`, Vercel `VERCEL_TOKEN`, chezmoi `--promptString k=v`).
- **Show defaults in brackets and accept Enter** (AWS `[None]` pattern). When a config already exists, prepopulate prompt `initialValue` with the *current* value so re-running setup is a non-destructive review.
- **End on a green health check.** `gh auth status`, `supabase status`, AWS cached-credential refresh, `firebase` post-setup all expose a validation surface. The wizard should run `am doctor`-style checks and print a green summary as its `outro`.
- For the **"clone from remote"** flow, chezmoi `init <repo>` is the gold standard: guess the git URL from shorthand, clone into the source dir, render a config template, then optionally `--apply`. `am` already has the analog (`am init` + git remote + `am apply`); `am setup` should expose a "I already have a catalog in git" branch.

---

## 1. How each tool structures onboarding (evidence)

### 1.1 `gh auth login` — the auth-wizard reference

Interactive prompt sequence (from cli/cli source, `pkg/cmd/auth/login/login.go` + `pkg/cmd/auth/shared/login_flow.go`):

1. **Hostname** — "GitHub.com" vs "Other"; if Other, prompt for hostname. Skipped if `--hostname` given.
2. **Git protocol** — HTTPS vs SSH. Skipped if `--git-protocol` given.
   - HTTPS → offer to configure `gh` as a git credential helper.
   - SSH → (unless `--skip-ssh-key`) offer to upload an existing key or generate a new one.
3. **Auth method** — "Login with a web browser" (OAuth device/web flow) vs "Paste an authentication token".

**Existing-auth detection:** before prompting, checks `GH_TOKEN`/`GH_ENTERPRISE_TOKEN`. If set, it uses the token and *prints a message that the env var is in use*, suppressing prompts. If you log in to an already-configured host it prints a warning rather than silently clobbering (additive multi-account model).

**Non-interactive:** `--with-token` (token on stdin), `GH_TOKEN`/`GH_ENTERPRISE_TOKEN`, `--hostname`, `--git-protocol`, `--web`, `--skip-ssh-key`, `--insecure-storage`.

**Success verification (the green check):** validates the token has minimum scopes (`repo`, `read:org`, `gist`) by inspecting the `X-Oauth-Scopes` response header, calls `GetCurrentLogin` to fetch the username via API, stores the token (OS keyring or plaintext with `--insecure-storage`), then prints a confirmation with the logged-in user. A separate `gh auth status` re-validates anytime (state, active account, protocol, token, scopes).

Sources: https://cli.github.com/manual/gh_auth_login ; cli/cli source via DeepWiki.

### 1.2 `aws configure` / `aws configure sso` — defaults echoing + session decomposition

`aws configure` is linear and minimal: Access Key ID, Secret Key, default region, default output format. **Defaults are shown in brackets and Enter accepts them**, e.g.:

```
$ aws configure
AWS Access Key ID [None]: AKIA...
AWS Secret Access Key [None]: ...
Default region name [us-west-2]: 
Default output format [json]: 
```

`aws configure sso` is a richer wizard: SSO session name → start URL → SSO region → browser authorization → account selection → role selection → default client region → output format → profile name.

**Decomposition / idempotency:** `aws configure sso-session` configures *only* the shared session block; multiple profiles can reference one session. State is split across `~/.aws/config`, `~/.aws/credentials`, and `~/.aws/sso/cache`. Continuation after first config is a *separate* command: `aws sso login --profile X`, which refreshes the cached token; the CLI auto-renews while signed in. This "config once, refresh credentials separately" split is exactly the model `am` should copy for secrets/passphrase unlock.

Sources: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-quickstart.html ; https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html ; https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-wizard.html

### 1.3 `gcloud init` — named configurations as the idempotency unit

`gcloud init` does: authorize account → select/create a *named configuration* → select project → set default region/zone. The key idea: a **configuration is a first-class named object** (`default` plus any you create), so re-running setup targets a named config instead of mutating a single global state — reruns are non-destructive by construction.

**Non-interactive:** `--quiet` (disable all prompts, use defaults, error if a required default is missing), `--account`, `--project`, `--configuration`, `--no-browser`/`--no-launch-browser`, `--skip-diagnostics`, `--flags-file`. CI auth is a *different* command (`gcloud auth activate-service-account`) — again, decomposition.

Sources: https://docs.cloud.google.com/sdk/docs/initializing ; https://docs.cloud.google.com/sdk/gcloud/reference/init

### 1.4 `firebase init` — checkbox feature-picker + merge-not-overwrite

`initAction` sequence: load existing `firebase.json`/`.firebaserc` → warn if in `$HOME` or already inside a Firebase project → **checkbox multiselect of features** (Firestore, Functions, Hosting, Storage, Emulators, …) unless a feature arg was passed → always-add the "project" pseudo-feature → account selection if multiple accounts → per-feature `askQuestions` → `actuate` (write files) → `postSetup`. Writes `firebase.json` (merged, per-section), `.firebaserc`, feature files (`firestore.rules`, etc.), and a `.gitignore` if absent.

**Re-run handling:** when `firebase.json` exists it **merges per-section** rather than overwriting the whole file, and prompts before overwriting any individual file that already exists. This is the model for `am setup` re-runs: detect existing catalog, merge additively, confirm before clobbering specific artifacts.

**Non-interactive:** triggered by `--non-interactive`, `--json`, *or* `process.stdin.isTTY === false`. In that mode, prompts with a default use it; prompts *without* a default throw `FirebaseError`. `--project` / `FIREBASE_PROJECT` skip project selection. Internal `actuate({ force: true })` skips confirmations (no public `--force` on init).

Source: firebase/firebase-tools via DeepWiki; https://firebase.google.com/docs/cli

### 1.5 `supabase` — narrow `init`, separate `login`/`link`/`start`/`status`

`supabase init` only writes `supabase/config.toml`. Flags: `--force` ("Overwrite existing supabase/config.toml"), `-i/--interactive` (configure IDE settings), `--use-orioledb`; workdir via `--workdir`/`SUPABASE_WORKDIR`. Without `--force` it refuses to clobber an existing config. Auth (`supabase login`, PAT), remote attach (`supabase link`, password via `SUPABASE_DB_PASSWORD`), local bring-up (`supabase start`), and validation (`supabase status`) are all *separate commands*. This is the cleanest decomposition in the set.

Sources: https://supabase.com/docs/reference/cli/supabase-init ; https://supabase.com/docs/reference/cli/introduction

### 1.6 `vercel` — flag-beats-env precedence

`vercel login` vs `vercel init` (example bootstrap) are distinct. CI auth via `VERCEL_TOKEN` env or `--token`, with **`--token` taking precedence over the env var** — the canonical precedence order (flag > env > config > default).

Sources: https://vercel.com/docs/cli ; https://vercel.com/docs/cli/init

### 1.7 `chezmoi init` — the clone-from-remote gold standard

Step order: (1) init source dir — clone the given *repo* or create a fresh repo if none given; (2) if `.chezmoi.$FORMAT.tmpl` exists, render it to generate the config file (this is where prompting happens); (3) run `chezmoi apply` **only if `--apply`**; (4) `--purge` removes source/config/cache; (5) `--purge-binary` self-removes.

**Repo URL guessing** (HTTPS default, SSH with `--ssh`), disable with `--guess-repo-url=false`:

| shorthand | guessed HTTPS URL |
|---|---|
| `user` | `https://user@github.com/user/dotfiles.git` |
| `user/repo` | `https://user@github.com/user/repo.git` |
| `site/user/repo` | `https://user@site/user/repo.git` |

**Prompting model (copy this for non-interactive):** the config template calls `promptString`/`promptBool`/`promptInt`/`promptChoice`/`promptMultichoice`. These can be **pre-seeded from the CLI** as comma-separated `prompt=value` pairs: `--promptString email=me@x.com,name=Me`. `--promptDefaults` makes every prompt with a declared default return that default without asking (the "accept all defaults" switch). `prompt*Once` variants skip when a value already exists (idempotency) unless `--prompt` forces re-asking. `--one-shot` = `--apply --depth=1 --force --purge --purge-binary` (an ephemeral bootstrap macro). Escape hatches: `--keep-going` (continue after errors), `--no-tty` (read prompt answers from stdin), `--interactive`/`--less-interactive` (confirmation granularity).

Source: https://chezmoi.io/reference/commands/init ; https://chezmoi.io/reference/command-line-flags/global

---

## 2. Cross-tool patterns distilled (the rules)

1. **Decompose, then orchestrate.** `am setup` should *call* `am init`, secrets unlock, adapter selection, optional remote clone, `am apply`, and `am doctor` — each independently re-runnable. Do not write a 600-line monolith.
2. **Every prompt has a non-interactive twin.** Flag, env var, or stdin. A `--non-interactive` mode that can't supply a required value must error clearly (firebase's `FirebaseError`), not hang.
3. **Detect non-TTY automatically.** `!process.stdin.isTTY` (firebase) / `TERM=dumb` (huh) / explicit `--ci`/`--yes` (create-t3-app) → switch to defaults-or-error. clack's `isCancel`/`onCancel` is *not* a non-TTY guard — guard before you ever call a prompt.
4. **Echo `[default]` and Enter-to-accept.** Use clack `defaultValue` for "Enter → this" and `initialValue` to *prefill the current value* on re-runs (so setup becomes a non-destructive review).
5. **Idempotent + resumable.** Re-running detects existing state and merges per-section (firebase), targets a named profile (gcloud), or refuses-without-`--force` (supabase). Never silently clobber; prompt before overwriting a specific artifact.
6. **Escape hatches everywhere.** Skip a step (`--skip-ssh-key`), abort cleanly (clack `onCancel` → `cancel()` + `process.exit`), continue-on-error (`--keep-going`), and "just give me defaults" (chezmoi `--promptDefaults`, t3 `--default/-y`).
7. **Clone-from-remote as a first-class branch.** Guess the URL, clone, render/merge config, optionally apply. `am` already has the pieces.
8. **End on a green check.** Run health checks and print a green `outro`. Offer the exact next command.
9. **Precedence is flag > env > local-file > shared-file > default** (Vercel `--token` beats `VERCEL_TOKEN`; matches `am`'s ADR-0003 hierarchy).

---

## 3. clack primitives to use (the toolkit)

`@clack/prompts` API confirmed against bombshell-dev/clack and bomb.sh docs. Note `am` is pinned at `^0.9.1`; a few options below (`spinner({indicator})`, `note(..., {format})`, `confirm({vertical})`, `selectKey`) landed in later 0.9.x/1.0 — **verify against the installed version before using**; the core set (`intro/outro/text/password/confirm/select/multiselect/group/spinner/note/log/cancel/isCancel/tasks`) is present in 0.9.1.

| Primitive | Use in `am setup` | Signature highlights |
|---|---|---|
| `intro(title)` | Banner: `intro("am setup")` | second arg `{ withGuide }` |
| `outro(msg)` | Green closing line after health check | |
| `group(prompts, { onCancel })` | The whole prompt chain; later prompts read earlier answers via `({ results }) => ...` | `onCancel: () => { cancel("Setup cancelled."); process.exit(1); }` |
| `text({ message, placeholder, defaultValue, initialValue, validate })` | git remote URL, profile name, config dir | `defaultValue` = Enter value; `initialValue` = prefill current; `validate` returns string err or `undefined` |
| `password({ message, validate, mask })` | age/secrets passphrase (ADR-0042) | masked input |
| `confirm({ message, initialValue })` | "Clone an existing catalog from git?", "Apply now?" | returns `boolean \| symbol` |
| `select({ message, options, initialValue })` | git protocol (HTTPS/SSH), default profile, "fresh vs clone" branch | `options: [{ value, label, hint }]`, `hint` for `[default]`-style annotations |
| `multiselect({ message, options, required, initialValues })` | **which adapters/IDE tools to manage** (firebase-style feature picker) | prefill detected tools via `initialValues` |
| `spinner()` → `{ start, stop, message }` | git clone, `am apply`, doctor checks | `s.start("Cloning catalog…"); s.message("…"); s.stop("Catalog cloned")` |
| `tasks([{ title, task }])` | Sequenced terminal steps (clone → apply → verify) with per-task spinner; `task(message)` updates mid-run | returning a string sets the completion line |
| `note(message, title)` | Print resolved config summary / next-steps box | |
| `log.{info,success,warn,error,step}(msg)` | Per-check status outside a spinner | `log.success`/`log.error` for green/red |
| `cancel(msg)` | On abort, before `process.exit` | |
| `isCancel(value)` | **After every standalone prompt** (outside `group`) | `if (isCancel(v)) { cancel("…"); process.exit(1); }` |

**Canonical `group()` with result-passing + onCancel** (bomb.sh docs):

```ts
const account = await p.group(
  {
    email: () => p.text({ message: "Email?", validate: (v) => (!v ? "required" : undefined) }),
    username: ({ results }) =>
      p.text({
        message: "Username?",
        placeholder: results.email?.replace(/@.+$/, "").toLowerCase() ?? "",
      }),
    password: () => p.password({ message: "Define your password" }),
  },
  { onCancel: () => { p.cancel("Setup cancelled."); process.exit(1); } },
);
```

**Conditional prompts in a group** (create-t3-app): spread-include a prompt only when needed, and return `undefined` to skip:

```ts
const project = await p.group(
  {
    ...(!cliProvidedName && { name: () => p.text({ message: "Project name?" }) }),
    database: () => p.select({ message: "DB?", options: [...] }),
    dbProvider: ({ results }) => {
      if (results.database === "none") return; // skipped
      return p.select({ message: "Provider?", options: [...] });
    },
  },
  { onCancel() { process.exit(1); } },
);
```

**Spinner / tasks** (README):

```ts
const s = p.spinner();
s.start("Cloning catalog");
await cloneRepo(url);
s.stop("Catalog cloned");

await p.tasks([
  { title: "Applying config to detected tools", task: async () => { await apply(); return "Applied"; } },
  { title: "Running health check", task: async (msg) => { msg("doctor…"); await doctor(); return "All green"; } },
]);
```

### 3.1 Why clack over huh here

`am` is already on clack — no reason to add Go/huh. But huh's two ideas are worth porting in spirit:
- **Auto non-TTY → accessible/defaults** (huh checks `TERM=dumb`). Mirror with `!process.stdin.isTTY`.
- **Multi-group = pages.** clack's `group()` is the analog; you can run *several* `group()` calls in sequence to form "pages" (e.g., page 1 = identity/git, page 2 = adapters, page 3 = secrets), each guarded.

Source: charmbracelet/huh via DeepWiki.

---

## 4. Concrete spec for `am setup`

### 4.1 Goals & non-goals
- **Goal:** one command that takes a brand-new machine to a green `am doctor` — fresh catalog *or* cloned-from-remote — and writes native configs for the user's tools.
- **Non-goal:** replacing the granular commands. `am setup` orchestrates `am init`, secrets, `am apply`, `am doctor`. It must be safe to re-run.

### 4.2 Flags (citty `args`)
```
am setup
  --from-remote <url|shorthand>   Clone an existing catalog from git (chezmoi-style guess if shorthand)
  --ssh                           Guess SSH URL instead of HTTPS for --from-remote shorthand
  --profile <name>                Default profile to create/activate            (default: "default")
  --tools <a,b,c>                 Comma-list of adapters to manage (skip the multiselect)
  --apply / --no-apply            Run `am apply` at the end                      (default: apply)
  --yes, -y                       Accept all defaults; no prompts (needs every required value via flags/env)
  --non-interactive               Hard non-interactive: defaults-or-error, never prompt (implied when !isTTY)
  --json                          Structured output (implies --non-interactive)
  --quiet, -q / --verbose, -v     Standard output controls
  --force                         Permit overwriting an existing catalog/config (else merge/skip)
```
Env twins (precedence flag > env > file > default): `AM_SETUP_REMOTE`, `AM_PROFILE`, `AM_ENCRYPTION_KEY` (existing), `AM_CONFIG_DIR` (existing), `CI`/`!isTTY` → auto `--non-interactive`.

### 4.3 Step sequence (orchestration)

```
0. Preflight & mode resolution
   - opts = { json, quiet, verbose }
   - interactive = process.stdin.isTTY && !args.yes && !args.nonInteractive && !args.json && !process.env.CI
   - if (!interactive) → defaults-or-error mode (firebase/gcloud pattern)
   - p.intro("am setup")  (interactive only)

1. Detect current state (idempotency probe)  — reuse doctor/status checks
   - configDir = resolveConfigDir(); exists = tryReadConfig(configPath) !== null
   - detectedAdapters = getDetectedAdapters()
   - gitRemote present? key/secrets configured?
   - note(summary)  — show what already exists so re-run is a review, not a surprise

2. Branch: fresh vs clone-from-remote
   - if args.fromRemote OR confirm("You already have an am catalog in git — clone it?"):
       a. resolve URL (guessRepoUrl(shorthand, { ssh }) chezmoi-style)
       b. spinner: initRepo + addRemote + pull (isomorphic-git)
       c. existing config wins; skip the "create default config" path
   - else (fresh):
       a. if exists && !force → MERGE additively / skip writing default (firebase pattern); never clobber
       b. else → withConfig(configDir, …, { noCommit:true })  (mirror am init's first-run path)

3. Identity / git (only what's missing)
   - group({
       gitProtocol: () => select({ message:"Git protocol for syncing your catalog?",
                                    options:[{value:"https",label:"HTTPS"},{value:"ssh",label:"SSH"}],
                                    initialValue: current ?? "https" }),
       remote: ({results}) => existingRemote ? undefined
               : text({ message:"Catalog git remote (optional, Enter to skip)", defaultValue:"" }),
     }, { onCancel })

4. Secrets / passphrase (ADR-0042) — separate, refreshable (aws sso pattern)
   - if no key present:
       method = select(["Generate a new key", "Enter an age passphrase", "Skip (set later with `am secret`)"])
       if passphrase → password({ message:"Passphrase", validate: minLen })
       generateKey()/saveKey() as today; offer OS-keychain cache (ADR-0042)
   - Non-interactive: AM_ENCRYPTION_KEY or skip with a warning.

5. Tool selection (firebase feature-picker)
   - tools = args.tools ?? multiselect({
       message:"Which AI tools should am manage?",
       options: allAdapters.map(a => ({ value:a.name, label:a.displayName,
                  hint: detected.has(a.name) ? "detected" : undefined })),
       initialValues: [...detectedAdapterNames],   // preselect what's installed
       required: false,
     })
   - persist selection into the profile/config (under withConfig)

6. Profile
   - profile = args.profile ?? text({ message:"Default profile name", defaultValue:"default",
                                       initialValue: current?.settings?.default_profile ?? "default" })

7. Apply (chezmoi --apply; default on, --no-apply to stop short)
   - if (apply) tasks([{ title:"Writing native configs", task: async()=>{ await applyToTools(selected); return "Applied"; } }])
   - else log.info("Skipped apply. Run `am apply` when ready.")

8. Green health check (the close)
   - reuse doctor's Check[] runner; render with log.success/log.error
   - if all ok → outro("✓ Setup complete. Active profile: <p>. Run `am status` anytime.")
   - if any fail → log.error per failed check + note("Fix the above, then re-run `am setup` (safe to re-run).") + process.exitCode=1
```

### 4.4 Idempotency & resumability rules
- **Probe before prompt** (step 1). Prefill `initialValue` from current state so a re-run shows current values and changes nothing on all-Enter.
- **Merge, don't clobber** (firebase): adapter/profile additions union into existing config; writing an artifact that exists asks first unless `--force`.
- **Per-step independence:** if `am apply` fails, `am setup` is safe to re-run and resumes at apply (nothing earlier is undone).
- **Single writer:** all config mutations go through `withConfig` (ADR-0040 AsyncMutex) so concurrent `am setup` can't race — mirror `am init`'s `{ noCommit: true }` first-run path so a fresh repo stays at one commit.

### 4.5 Non-interactive / CI contract
- Trigger: `--non-interactive`, `--json`, `--yes`, `CI` env, or `!process.stdin.isTTY`.
- Behavior: each step uses flag → env → existing-config → declared default. A *required* value with no source → **structured error and non-zero exit** (never hang; never half-write). Example required values: remote URL when `--from-remote` has no arg; passphrase when method=passphrase and no `AM_ENCRYPTION_KEY`.
- `--json` emits a machine-readable record of every step's outcome and the final doctor `Check[]` array (reuse `src/lib/output.ts` `output()`), exit code reflects health.

### 4.6 Escape hatches
- **Abort:** `group({…},{ onCancel: () => { cancel("Setup cancelled — nothing was applied."); process.exit(1); } })`; `isCancel()` after any standalone prompt.
- **Skip a step:** Enter on optional `text` (empty `defaultValue`), a "Skip" option in selects, `--no-apply`, secrets "Skip" choice.
- **Accept all defaults:** `--yes`/`-y` (t3 pattern) and the implicit non-interactive path.
- **Force overwrite:** `--force` (supabase `--force` semantics) to permit clobbering instead of merge.

### 4.7 Output / copy conventions
- `[default]` echoing via clack `defaultValue` + `hint`. On re-run, prefilled `initialValue` shows current values.
- Final box (`note`) lists: config dir, active profile, managed tools, git remote, secrets status — then `outro` with the single most useful next command (`am status`).
- Green/red: `log.success` / `log.error` for each health check; overall exit code = health.

---

## 5. Copy-adaptable skeleton (TypeScript / clack 0.9.x)

```ts
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { getDetectedAdapters, listAdapters, getAdapter } from "../adapters/registry";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { withConfig } from "../core/controller";
import { output, info, error } from "../lib/output";

export const setupCommand = defineCommand({
  meta: { name: "setup", description: "Guided first-run setup (safe to re-run)" },
  args: {
    fromRemote: { type: "string", description: "Clone an existing catalog from git" },
    ssh: { type: "boolean", default: false },
    profile: { type: "string", default: "default" },
    tools: { type: "string", description: "Comma-list of adapters to manage" },
    apply: { type: "boolean", default: true },
    yes: { type: "boolean", alias: "y", default: false },
    nonInteractive: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const interactive =
      Boolean(process.stdin.isTTY) &&
      !args.yes && !args.nonInteractive && !args.json && !process.env.CI;

    if (interactive) p.intro("am setup");

    // 1. PROBE existing state (idempotency)
    const configDir = resolveConfigDir();
    const existing = await tryReadConfig(`${configDir}/config.toml`).catch(() => null);
    const detected = await getDetectedAdapters();

    // 2..6. Prompts (only what's missing) — guard non-interactive first
    let answers: { profile: string; tools: string[] };
    if (!interactive) {
      answers = {
        profile: args.profile,
        tools: args.tools ? args.tools.split(",") : detected.map((a) => a.meta.name),
      };
      // required-value validation → structured error, non-zero exit (no hang)
    } else {
      const r = await p.group(
        {
          tools: () =>
            p.multiselect({
              message: "Which AI tools should am manage?",
              options: listAdapters().map((n) => ({
                value: n,
                label: n,
                hint: detected.some((d) => d.meta.name === n) ? "detected" : undefined,
              })),
              initialValues: detected.map((a) => a.meta.name),
              required: false,
            }),
          profile: () =>
            p.text({
              message: "Default profile name",
              defaultValue: "default",
              initialValue: existing?.settings?.default_profile ?? "default",
            }),
        },
        { onCancel: () => { p.cancel("Setup cancelled — nothing was applied."); process.exit(1); } },
      );
      answers = r as typeof answers;
    }

    // 7. APPLY + 8. HEALTH CHECK via tasks/spinner, then green outro
    if (args.apply) {
      await p.tasks([
        { title: "Writing native configs", task: async () => { /* applyToTools(answers.tools) */ return "Applied"; } },
        { title: "Running health check", task: async (msg) => { msg("doctor…"); /* runDoctor() */ return "All green"; } },
      ]);
    }

    if (args.json) { output({ status: "ok", profile: answers.profile, tools: answers.tools }, opts); return; }
    if (interactive) p.outro(`✓ Setup complete. Active profile: ${answers.profile}. Run \`am status\` anytime.`);
  },
});
```

(Wire the `withConfig` write, secrets, and `--from-remote` clone branches per §4.3; reuse the `Check[]` runner from `src/commands/doctor.ts` for step 8.)

---

## 6. Sources

- gh: https://cli.github.com/manual/gh_auth_login + cli/cli source (DeepWiki)
- AWS: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-quickstart.html ; .../cli-configure-sso.html ; .../cli-usage-wizard.html
- gcloud: https://docs.cloud.google.com/sdk/docs/initializing ; https://docs.cloud.google.com/sdk/gcloud/reference/init
- firebase: firebase/firebase-tools (DeepWiki) ; https://firebase.google.com/docs/cli
- supabase: https://supabase.com/docs/reference/cli/supabase-init ; .../introduction
- vercel: https://vercel.com/docs/cli ; https://vercel.com/docs/cli/init
- chezmoi: https://chezmoi.io/reference/commands/init ; https://chezmoi.io/reference/command-line-flags/global
- clack: https://bomb.sh/docs/clack/packages/prompts/ ; bombshell-dev/clack README + DeepWiki
- huh: charmbracelet/huh (DeepWiki)
- real-world clack+CI: https://github.com/t3-oss/create-t3-app/blob/main/cli/src/cli/index.ts

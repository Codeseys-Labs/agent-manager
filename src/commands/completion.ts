/**
 * CLI: am completion — Generate shell completion scripts.
 *
 * Subcommands:
 *   am completion bash  — output bash completion script
 *   am completion zsh   — output zsh completion script
 *   am completion fish  — output fish completion script
 */

import { defineCommand } from "citty";

// ── Command & subcommand definitions ───────────────────────────

/** Top-level commands available in `am`. */
export const TOP_LEVEL_COMMANDS = [
  "init",
  "add",
  "list",
  "use",
  "apply",
  "status",
  "config",
  "profile",
  "push",
  "pull",
  "undo",
  "log",
  "search",
  "install",
  "uninstall",
  "update",
  "agent",
  "run",
  "wiki",
  "import",
  "adapter",
  "doctor",
  "secret",
  "session",
  "version",
  "mcp-serve",
  "tui",
  "serve",
  "flow",
  "marketplace",
  "completion",
] as const;

/** Commands that have subcommands, with their subcommand lists. */
export const SUBCOMMANDS: Record<string, readonly string[]> = {
  agent: ["list", "add", "remove", "ping", "delegate", "cancel"],
  wiki: [
    "init", "search", "add", "show", "delete", "harvest", "ingest",
    "lint", "graph", "synthesize", "briefing", "export", "import",
  ],
  config: ["validate", "show"],
  profile: ["list", "show", "create", "delete"],
  secret: ["set", "get", "list", "scan", "install-scanner", "generate-key", "import-key"],
  session: ["list", "export", "search"],
  adapter: ["list"],
  run: ["agents", "session"],
  flow: ["run", "list", "status"],
  marketplace: ["add", "list", "install", "update", "remove", "search", "uninstall"],
};

/** Global flags shared across all commands. */
const GLOBAL_FLAGS = ["--json", "--quiet", "--verbose", "--help", "--profile"];

// ── Bash ───────────────────────────────────────────────────────

export function generateBashCompletion(): string {
  const subcommandCases = Object.entries(SUBCOMMANDS)
    .map(
      ([cmd, subs]) =>
        `        ${cmd})\n            COMPREPLY=($(compgen -W "${subs.join(" ")}" -- "$cur"))\n            return 0\n            ;;`,
    )
    .join("\n");

  return `# bash completion for am (agent-manager)
# Add to ~/.bashrc:  eval "$(am completion bash)"

_am_completions() {
    local cur prev commands flags
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    commands="${TOP_LEVEL_COMMANDS.join(" ")}"
    flags="${GLOBAL_FLAGS.join(" ")}"

    # Complete subcommands for known parent commands
    if [[ \${COMP_CWORD} -eq 2 ]]; then
        case "\${COMP_WORDS[1]}" in
${subcommandCases}
        esac
    fi

    # Complete top-level commands or flags
    if [[ \${COMP_CWORD} -eq 1 ]]; then
        if [[ "$cur" == -* ]]; then
            COMPREPLY=($(compgen -W "$flags" -- "$cur"))
        else
            COMPREPLY=($(compgen -W "$commands" -- "$cur"))
        fi
        return 0
    fi

    # Default: complete flags
    if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$flags" -- "$cur"))
    fi

    return 0
}

complete -F _am_completions am
`;
}

// ── Zsh ────────────────────────────────────────────────────────

export function generateZshCompletion(): string {
  const subcommandCases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `        ${cmd})\n            compadd -- ${subs.join(" ")}\n            ;;`)
    .join("\n");

  return `#compdef am
# zsh completion for am (agent-manager)
# Add to ~/.zshrc:  eval "$(am completion zsh)"

_am() {
    local -a commands flags
    commands=(
        ${TOP_LEVEL_COMMANDS.map((c) => `'${c}'`).join("\n        ")}
    )
    flags=(
        ${GLOBAL_FLAGS.map((f) => `'${f}'`).join("\n        ")}
    )

    if (( CURRENT == 2 )); then
        _describe 'command' commands
        return
    fi

    if (( CURRENT == 3 )); then
        case "\${words[2]}" in
${subcommandCases}
        esac
        return
    fi

    _values 'flags' \${flags}
}

_am "\$@"
`;
}

// ── Fish ───────────────────────────────────────────────────────

export function generateFishCompletion(): string {
  const topLevelCompletions = TOP_LEVEL_COMMANDS.map(
    (cmd) =>
      `complete -c am -f -n '__am_needs_command' -a '${cmd}'`,
  ).join("\n");

  const subcommandCompletions = Object.entries(SUBCOMMANDS)
    .flatMap(([cmd, subs]) =>
      subs.map(
        (sub) =>
          `complete -c am -f -n "__am_using_command ${cmd}" -a '${sub}'`,
      ),
    )
    .join("\n");

  const flagCompletions = GLOBAL_FLAGS.map(
    (flag) => `complete -c am -l '${flag.replace(/^--/, '')}'`,
  ).join("\n");

  return `# fish completion for am (agent-manager)
# Add to ~/.config/fish/completions/am.fish

function __am_needs_command
    set -l cmd (commandline -opc)
    test (count $cmd) -eq 1
end

function __am_using_command
    set -l cmd (commandline -opc)
    test (count $cmd) -gt 1; and test $cmd[2] = $argv[1]
end

# Top-level commands
${topLevelCompletions}

# Subcommands
${subcommandCompletions}

# Global flags
${flagCompletions}
`;
}

// ── CLI subcommands ────────────────────────────────────────────

const bashSubcommand = defineCommand({
  meta: { name: "bash", description: "Output bash completion script" },
  run() {
    process.stdout.write(generateBashCompletion());
  },
});

const zshSubcommand = defineCommand({
  meta: { name: "zsh", description: "Output zsh completion script" },
  run() {
    process.stdout.write(generateZshCompletion());
  },
});

const fishSubcommand = defineCommand({
  meta: { name: "fish", description: "Output fish completion script" },
  run() {
    process.stdout.write(generateFishCompletion());
  },
});

export const completionCommand = defineCommand({
  meta: { name: "completion", description: "Generate shell completion scripts" },
  subCommands: {
    bash: () => Promise.resolve(bashSubcommand),
    zsh: () => Promise.resolve(zshSubcommand),
    fish: () => Promise.resolve(fishSubcommand),
  },
});

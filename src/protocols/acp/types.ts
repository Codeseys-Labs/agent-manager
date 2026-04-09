/**
 * ACP (Agent Client Protocol) Types — Minimal config-only types.
 *
 * am does not implement ACP; it configures ACP agent registrations
 * in IDE adapters (Kiro, JetBrains) that support ACP natively.
 * See ADR-0017 for rationale.
 */

/** ACP agent registration for IDE adapter config generation. */
export interface ACPAgentRegistration {
  name: string;
  description: string;
  endpoint: string;
  capabilities: string[];
  authentication?: {
    type: string;
    token?: string;
  };
}

/** Top-level ACP config section used in adapter TOML passthrough. */
export interface ACPConfig {
  agents: ACPAgentRegistration[];
}

/** ACP metadata stored in [agents.<name>.adapters.acp] passthrough. */
export interface ACPAdapterMetadata {
  slash_commands?: string[];
  context_awareness?: boolean;
  streaming?: boolean;
}

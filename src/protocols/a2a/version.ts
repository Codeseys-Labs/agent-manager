/**
 * A2A protocol version constants.
 *
 * v0.3 introduces:
 *   - Required `A2A-Version` HTTP header on every request and response
 *   - New AgentCard fields: protocolVersion, preferredTransport,
 *     securitySchemes, supportsAuthenticatedExtendedCard
 *   - Authoritative Agent Card URL at /.well-known/agent-card.json
 *     (legacy /.well-known/agent.json dual-published for v0.2 clients)
 *   - Server-generated taskIds for new tasks
 *   - Idempotent tasks/cancel
 *   - tasks/list with cursor pagination
 */

/** Current A2A protocol version we speak. */
export const A2A_PROTOCOL_VERSION = "0.3.0" as const;

/** HTTP header name used to signal A2A protocol version on every request/response. */
export const A2A_VERSION_HEADER = "A2A-Version";

/**
 * Preferred transport hint advertised in AgentCard.preferredTransport.
 * "http+jsonrpc" indicates JSON-RPC 2.0 over HTTP(S) POST.
 */
export const A2A_PREFERRED_TRANSPORT = "http+jsonrpc" as const;

/**
 * Types for community adapter loading (ADR-0027).
 *
 * Community adapters are standalone executables that speak JSON-RPC 2.0
 * over stdio, implementing the same Adapter interface as built-in adapters.
 */

/** Persisted entry in adapters.toml for a single community adapter. */
export interface CommunityAdapterConfig {
  source: string; // "npm:am-adapter-zed@0.2.0", "git+https://...", "local:./path"
  command: string; // path to the adapter executable
  installed_at: string; // ISO 8601 timestamp
  checksum?: string; // "sha256:abc123..."
  enabled?: boolean; // default true
}

/** The top-level shape of adapters.toml. */
export interface AdaptersToml {
  adapters: Record<string, CommunityAdapterConfig>;
}

/** Metadata returned from an adapter's package.json `am-adapter` field. */
export interface AdapterManifest {
  name: string;
  displayName: string;
  minAmVersion?: string;
  capabilities: string[];
}

/** JSON-RPC 2.0 request shape. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response shape. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Result from adapter/initialize handshake. */
export interface InitializeResult {
  protocolVersion: string;
  adapterVersion: string;
}

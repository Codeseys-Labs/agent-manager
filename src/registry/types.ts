/** MCP Registry package metadata */
export interface RegistryPackage {
  name: string;
  description: string;
  author: string;
  version: string;
  repository?: string;
  homepage?: string;
  license?: string;
  downloads?: number;
  verified: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
  server: RegistryServerConfig;
}

export interface RegistryServerConfig {
  command: string;
  args?: string[];
  env?: RegistryEnvVar[];
  transport?: "stdio" | "streamable-http" | "sse";
  url?: string; // For remote servers
}

export interface RegistryEnvVar {
  name: string;
  description: string;
  required: boolean;
  default?: string;
}

export interface RegistrySearchResult {
  packages: RegistryPackage[];
  /** Opaque cursor for the next page, when more results exist (v0 cursor pagination). */
  nextCursor?: string;
}

export interface RegistrySearchFilters {
  /**
   * Max results to return. The v0 API clamps this server-side to 100; the client
   * clamps it too so a caller-supplied value can't silently exceed the cap.
   */
  limit?: number;
  /** Opaque pagination cursor returned as `nextCursor` from a previous page. */
  cursor?: string;
}

/** Provenance metadata stored with registry-installed servers */
export interface RegistryProvenance {
  source: "mcp-registry";
  package: string;
  version: string;
  installed_at: string;
}

// ── Raw wire types (MCP registry v0 API) ────────────────────────
//
// These mirror the live `/v0/servers` response shape so the client can decode
// it before remapping to the internal RegistryPackage contract above. Field
// names match the API exactly (e.g. `isRequired`, NOT `required`) — the remap
// layer in client.ts is the single boundary where the rename happens.

/** A registry-managed input (env var or HTTP header). v0 `model.KeyValueInput`. */
export interface KeyValueInput {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  format?: string;
  choices?: string[];
}

/** A runtime/package argument. v0 `model.Argument`. */
export interface Argument {
  type?: "positional" | "named";
  name?: string;
  value?: string;
  valueHint?: string;
  description?: string;
  isRequired?: boolean;
  isRepeated?: boolean;
  default?: string;
}

/** Transport configuration — shared by `package.transport` and `remotes[]`. */
export interface Transport {
  type: "stdio" | "sse" | "streamable-http";
  url?: string;
  headers?: KeyValueInput[];
}

/** Remote endpoint entry (v0 `remotes[]`). Remote transports exclude stdio. */
export interface Remote {
  type: "streamable-http" | "sse";
  url: string;
  headers?: KeyValueInput[];
}

/** A downloadable package configuration. v0 `model.Package`. */
export interface Package {
  registryType: "npm" | "pypi" | "oci" | "nuget" | "cargo" | "mcpb";
  registryBaseUrl?: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport: Transport;
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
  environmentVariables?: KeyValueInput[];
}

/** Source-code repository metadata (v0 `model.Repository`). */
export interface Repository {
  url: string;
  source: string;
  id?: string;
  subfolder?: string;
}

/** Publisher-provided server detail (v0 `apiv0.ServerJSON`). */
export interface ServerDetail {
  name: string;
  description: string;
  title?: string;
  version: string;
  repository?: Repository;
  websiteUrl?: string;
  packages?: Package[];
  remotes?: Remote[];
  $schema?: string;
}

/** Registry-managed metadata under the official extension key. */
export interface RegistryOfficialMeta {
  status?: "active" | "deprecated" | "deleted";
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

/** A single server entry from the v0 API (`apiv0.ServerResponse`). */
export interface ServerResponse {
  server: ServerDetail;
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: RegistryOfficialMeta;
  };
}

/** The list envelope from GET /v0/servers (`apiv0.ServerListResponse`). */
export interface ServerListResponse {
  servers: ServerResponse[];
  metadata?: {
    nextCursor?: string;
    count?: number;
  };
}

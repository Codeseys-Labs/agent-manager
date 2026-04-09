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
  total: number;
  page: number;
  per_page: number;
}

export interface RegistrySearchFilters {
  tag?: string;
  verified?: boolean;
  limit?: number;
  page?: number;
}

/** Provenance metadata stored with registry-installed servers */
export interface RegistryProvenance {
  source: "mcp-registry";
  package: string;
  version: string;
  installed_at: string;
}

# Pillar 2 — MCP gateway review

## 1. What's GOOD today?

- **Universal entrypoint:** ADR-0009 made `am mcp-serve` a stdio MCP endpoint any agent can add without a bespoke API (ADRs/0009-mcp-server-mode.md:20-31,83-85).
- **Minimal by default:** the schema accepts six groups and `tools/list` filters by them, defaulting to `core`, so clients do not see all 38 tools unless configured (src/core/schema.ts:129-140; src/mcp/server.ts:321-362,2897-2915; ADRs/0021-mcp-tool-grouping-and-gateway.md:135-143).
- **Concurrency-safe by design:** MCP write paths use the shared controller mutex, and tests race concurrent writers/batches through real MCP handlers (src/core/controller.ts:91-140; test/mcp/concurrency.test.ts:62-166).
- **Write-tier auth is secure-by-default:** no token means write tools are hidden/refused unless unsafe local mode is explicit; configured tokens use fixed-size hash comparison (src/mcp/server.ts:212-319,2904-2909; src/commands/mcp-serve.ts:9-24).
- **Progress streaming is hardened:** handlers emit `notifications/progress`; payload strings are redacted with cycle/depth guards after the latest security critique (src/mcp/server.ts:87-101,155-191,2979-3011; docs/reviews/2026-05-02-adversarial-critique/synthesis.md:20-26).

## 2. What's ROUGH for a new MCP-client builder?

1. `tools/list` exposes only input schemas; outputs, `isError` shapes, error codes, retryability, and examples are not machine-readable (src/mcp/server.ts:75-83,3013-3038).
2. Error transport is bifurcated: unknown tools/methods use JSON-RPC errors, but validation/auth/handler failures are JSON strings inside tool `content` with `isError` (src/mcp/server.ts:2924-2975,3020-3038).
3. No JSON-Schema draft or strictness contract is advertised; runtime Zod permits passthrough `_am_token` and unknown fields (src/mcp/server.ts:541-554).
4. Progress-token semantics are mostly comments; only agent invocation hints at streaming, and no metadata says which tools emit progress or what variants look like (src/mcp/server.ts:91-96,2120-2156).
5. Deprecation aliases are descriptions plus stderr warnings, not structured metadata with replacement/removal version (src/mcp/server.ts:501-512,1759-1777,2027-2112).
6. Auth discovery is awkward: with a configured token, write tools appear to every client, but the list does not say which tools require a bearer token or where to put it (src/mcp/server.ts:219-225,2904-2915).

## 3. What's ROUGH at scale?

- **Context bloat returns:** enabling all groups exposes 38 tools plus legacy aliases; grouping is coarse, not task-adaptive (ADRs/0021-mcp-tool-grouping-and-gateway.md:135-143).
- **No backpressure/rate limits:** batch dispatch uses `Promise.all`; write locks protect config, but expensive reads/searches and long agent calls can pile up (src/mcp/server.ts:2720-2753,1128-1179).
- **Thin observability:** the dispatcher has validation/auth/progress hooks but no per-tool duration, slow-call log, queue depth, or trace id (src/mcp/server.ts:2919-3040).
- **Process-local locks:** two `am mcp-serve` processes against one config can still race; the lock docs call out the missing file lock (src/core/locks.ts:1-7).

## 4. Multi-tenant / multi-agent angle

Not today. One server process has one auth config and one global `settings.mcp_serve.tools` surface; `tools/list` is not caller-scoped, and `ProfileSchema` has no MCP tool policy. ADR-0021 explicitly rejected profile-scoped serving because MCP serve is global (src/core/schema.ts:115-140; src/mcp/server.ts:2670-2695,2897-2915; ADRs/0021-mcp-tool-grouping-and-gateway.md:110-112). Clients can spawn separate processes with different env/configs, but one process cannot give client A read-only wiki and client B write-local core.

## 5. Top 3 ACTIONABLE IMPROVEMENTS

1. **Problem:** builders reverse-engineer tiers, groups, outputs, errors, progress, and deprecations. **Fix:** add `x-am` metadata plus output/error schemas and examples. **Acceptance:** a snapshot test proves all 38 tools publish group, tier, auth, deprecation, progress, output, and error metadata.
2. **Problem:** tool failures are hard to classify. **Fix:** standardize `{ok, data|error:{code,message,hint,retryable}}` while preserving JSON-RPC errors for protocol failures. **Acceptance:** validation, auth, permission, and handler-error tests assert stable codes.
3. **Problem:** one shared server cannot serve agents with different permissions. **Fix:** add named client policies mapping bearer tokens to groups, tiers, and profile/config scope. **Acceptance:** two tokens against one `McpServer` see different `tools/list` surfaces and unauthorized calls are denied.

## References

ADRs/0009-mcp-server-mode.md:20-31,83-85; ADRs/0021-mcp-tool-grouping-and-gateway.md:110-143; src/core/schema.ts:115-140; src/core/controller.ts:91-140; src/core/locks.ts:1-7; src/mcp/server.ts:75-83,212-319,501-554,1128-1179,1759-2156,2670-3040; src/commands/mcp-serve.ts:9-24; test/mcp/concurrency.test.ts:62-166; docs/reviews/2026-05-02-adversarial-critique/synthesis.md:20-26.

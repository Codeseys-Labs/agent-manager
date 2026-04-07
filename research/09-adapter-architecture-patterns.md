---
tags: [research/agent-manager, patterns/adapters, architecture]
created: 2026-04-07
updated: 2026-04-07
---

# Adapter Architecture Patterns: Core + Plugin Systems

Research into how established tools implement core + adapter/provider/plugin architectures,
focused on how they draw the boundary between "core schema" and "adapter-specific extensions."
Goal: inform the design of agent-manager's universal core schema + pluggable adapters for each
IDE/agent tool.

---

## 1. Terraform Providers

### Core vs Provider Boundary

**Core owns:**
- HCL language parsing and evaluation
- Block types: `resource`, `data`, `variable`, `output`, `provider`, `module`, `locals`, `terraform`
- Plan/apply lifecycle orchestration (validate -> plan -> apply -> destroy)
- State management and serialization
- Dependency graph construction and execution ordering
- Provider discovery, installation, and version resolution
- Meta-arguments: `depends_on`, `count`, `for_each`, `provider`, `lifecycle`

**Providers own:**
- Concrete resource type names and their attribute schemas (e.g., `aws_instance`, `google_compute_instance`)
- Attribute semantics: which fields are Required/Optional/Computed/Sensitive
- Nested block structures within resources
- API call implementation (how attributes map to cloud API operations)
- State representation and upgrade logic
- Provider-level configuration schema (credentials, regions, endpoints)

### How Adapters Declare Capabilities

Providers implement a Go interface (`provider.Provider` in the Plugin Framework) with these required methods:

```go
type Provider interface {
    Metadata(ctx, req, resp)    // declares provider type name (e.g., "aws")
    Schema(ctx, req, resp)      // declares provider-level config schema
    Configure(ctx, req, resp)   // initializes shared clients from config
    Resources(ctx) []Resource   // returns list of resource type constructors
    DataSources(ctx) []DataSource
}
```

Each resource then declares its own schema:

```go
func (r *ExampleResource) Schema(ctx, req, resp) {
    resp.Schema = schema.Schema{
        Attributes: map[string]schema.Attribute{
            "name": schema.StringAttribute{Required: true},
            "count": schema.Int64Attribute{Optional: true, Default: 1},
        },
    }
}
```

### Core Handles Passthrough Via

- **gRPC protocol** (tfplugin5/tfplugin6): Core and provider run as separate processes communicating via Protocol Buffers
- **`GetProviderSchema` RPC**: Core calls this to discover all resource/data schemas at validate/plan/apply time
- **`DynamicValue` wire format**: Attribute values serialized via MessagePack between core and provider
- Core is fully schema-driven -- it validates HCL config against the provider-reported schema without knowing provider internals

### Storage/Serialization

- Provider schemas are communicated over gRPC at runtime, not stored in config files
- Terraform state (`.tfstate`) stores resource attribute values as JSON, keyed by resource address
- The state format is core-owned; providers supply values that core serializes
- Schema version field on resources enables state migration via `UpgradeResourceState` RPC

### Adding New Adapters

- **SDK**: Two options -- Terraform Plugin Framework (recommended, protocol v6) or Plugin SDK v2 (legacy, protocol v5)
- **Manifest**: `terraform-registry-manifest.json` declares `protocol_versions` (e.g., `["6.0"]`)
- **Distribution**: Published to Terraform Registry as signed GitHub releases with semver tags
- **Discovery**: `terraform init` uses Registry protocol to find/install provider binaries into `.terraform/providers/`
- **Muxing**: `tf5to6server` and `tf6muxserver` allow combining providers across protocol versions

### Versioning & Compatibility

- Provider protocol has major versions (5, 6) with additive minor versions
- Core negotiates protocol version at plugin startup
- Resource schema versioning enables state migration across provider updates
- Semantic versioning for provider releases; Registry resolves version constraints

### Key Pattern: **Schema-Driven gRPC Protocol**
Core is a generic orchestrator that discovers adapter schemas at runtime via a protocol. Adapters are separate processes with well-defined lifecycle RPCs. The boundary is crisp: core owns syntax + orchestration, adapters own types + semantics.

---

## 2. VS Code Extension API

### Core vs Extension Boundary

**Core owns:**
- The workbench UI framework (editor, sidebar, panel, status bar, activity bar)
- A fixed set of **contribution points** that extensions can populate
- The activation event system (lazy loading of extensions)
- Settings infrastructure (scopes, merging, precedence)
- The Extension Host process model (extensions run isolated from the main process)
- Command palette, keybinding resolution, menu system

**Extensions own:**
- Implementations of contributed commands, views, and providers
- Language-specific intelligence (completion, hover, diagnostics, formatting)
- Custom editor types, webview content
- Extension-specific settings schema and defaults
- Activation logic (what triggers the extension to load)

### How Adapters Declare Capabilities

The `package.json` manifest serves as the **static contract** between core and extensions:

```json
{
  "contributes": {
    "commands": [{ "command": "myExt.sayHello", "title": "Say Hello" }],
    "configuration": {
      "title": "My Extension",
      "properties": {
        "myExt.enabled": { "type": "boolean", "default": true }
      }
    },
    "views": {
      "explorer": [{ "id": "myView", "name": "My View" }]
    },
    "languages": [{ "id": "mylang", "extensions": [".ml"] }]
  },
  "activationEvents": ["onCommand:myExt.sayHello", "onLanguage:mylang"]
}
```

At runtime, extensions register implementations via the `vscode` API:

```typescript
export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('myExt.sayHello', () => { /* ... */ }),
        vscode.languages.registerCompletionItemProvider('mylang', provider)
    );
}
```

### Core Handles Passthrough Via

- **`contributes` in package.json**: Core reads this at install time to understand what an extension provides (UI elements, settings schema, languages) without activating it
- **Runtime API**: Extensions register behavior programmatically only after activation
- **Configuration schema**: Extensions declare JSON Schema for their settings in `contributes.configuration`; core merges these into the global settings system
- **When clauses**: Context-dependent visibility/enablement for commands, menus, views

### Storage/Serialization

- Extension manifest (`package.json`) is the primary declaration format
- Extension-specific settings stored in VS Code's settings JSON, namespaced by extension ID
- Extension state persisted via `ExtensionContext.globalState` / `workspaceState` (key-value)
- Marketplace metadata (badges, gallery banner) also in `package.json`

### Adding New Adapters

- **Manifest**: `package.json` with `engines.vscode` compatibility, `contributes`, `activationEvents`, `main`/`browser` entry point
- **SDK**: `@types/vscode` for TypeScript types; `vsce` CLI for packaging
- **Distribution**: VS Code Marketplace (`.vsix` packages)
- **Discovery**: Marketplace search + install; extensions auto-discovered from `~/.vscode/extensions/`

### Versioning & Compatibility

- `engines.vscode` in manifest specifies minimum VS Code version
- Proposed APIs require opt-in and are not stable
- Extensions can be web-compatible (pure declarative contributions) or Node.js-only
- Some activation events became implicit over time (views since 1.74, tasks since 1.76)

### Key Pattern: **Manifest + Runtime Registration**
Extensions declare static capabilities in a JSON manifest (for discoverability and UI) and register dynamic behavior via API calls at activation time. The manifest is the schema contract; the API is the runtime contract.

---

## 3. ESLint Plugin System

### Core vs Plugin Boundary

**Core owns:**
- Configuration loading and merging (flat config arrays, legacy `.eslintrc`)
- File traversal and glob matching
- The linting pipeline: parse -> traverse AST -> run rules -> collect reports
- Built-in rules (~300 rules in core)
- The rule context API (`context.report()`, `context.getSourceCode()`)
- Fix application and suggestion infrastructure
- AST format expectations (ESTree by default, extensible via language plugins)

**Plugins own:**
- Custom rules (same interface as core rules)
- Named config presets (e.g., `recommended`, `strict`)
- Processors (transform non-JS files into lintable JS)
- Language definitions (custom parsers, AST formats, traversal)
- Plugin-scoped metadata (name, version)

### How Adapters Declare Capabilities

A plugin is a plain JavaScript object with well-known properties:

```javascript
module.exports = {
  meta: { name: "example", version: "1.0.0" },
  rules: {
    "no-foo": {
      meta: {
        type: "problem",
        docs: { description: "disallow foo" },
        schema: [],        // JSON Schema for rule options
        messages: { avoid: "Don't use foo" }
      },
      create(context) {
        return {
          Identifier(node) {
            if (node.name === "foo") context.report({ node, messageId: "avoid" });
          }
        };
      }
    }
  },
  configs: {
    "flat/recommended": [
      { rules: { "example/no-foo": "error" } }
    ]
  },
  processors: { /* optional */ }
};
```

### Core Handles Passthrough Via

- **Flat config composition**: Plugins imported as JS modules, composed in arrays:
  ```javascript
  import example from "eslint-plugin-example";
  export default [
    ...example.configs["flat/recommended"],
    { rules: { "example/no-foo": "error" } }
  ];
  ```
- **Namespace prefix**: Plugin rules referenced as `pluginName/ruleName` in config
- **`plugins` map**: In flat config, plugins placed in `plugins: { example }` key
- **Rule options**: Each rule declares a JSON Schema for its options; core validates options against that schema

### Storage/Serialization

- Plugin configs are JavaScript objects (not serialized to a separate format)
- In flat config, everything is code -- imports, spreads, overrides
- Legacy `.eslintrc` used JSON/YAML with string-based plugin references
- Rule options stored inline in config alongside rule severity

### Adding New Adapters

- **Interface**: Export an object with `meta`, `rules`, `configs`, `processors`, `languages`
- **Package convention**: `eslint-plugin-<name>` (conventional but not enforced in flat config)
- **Distribution**: npm packages
- **No SDK required**: Pure JavaScript/TypeScript objects conforming to documented shapes
- **Dual format**: Plugins should export both legacy and flat config presets for migration

### Versioning & Compatibility

- ESLint v9 made flat config default; plugins need flat-compatible exports
- `FlatCompat` utility bridges legacy configs to flat config
- Language plugins (new in recent versions) enable linting non-JS languages
- Core rule interface is stable (meta + create pattern)

### Key Pattern: **Convention-Based Object Shape**
No formal interface/SDK -- plugins are plain objects with well-known property names. Core discovers capabilities by inspecting properties. Composition is explicit via JavaScript imports. Namespacing via `pluginName/ruleName` prevents collisions.

---

## 4. Prettier Plugin System

### Core vs Plugin Boundary

**Core owns:**
- The **Doc intermediate representation** (IR): a language-agnostic algebra of layout primitives
- The **pretty-printing engine**: Wadler's algorithm that decides line-breaking based on `printWidth`
- Doc builder primitives: `group`, `indent`, `line`, `softline`, `hardline`, `ifBreak`, `join`, `fill`, `breakParent`
- Comment attachment and printing coordination
- CLI, configuration resolution, and file traversal
- The `format()` pipeline: detect parser -> parse -> print to Doc -> render Doc to text

**Plugins own:**
- **Parsers**: Convert source text to an AST (declare `astFormat` to link to a printer)
- **Printers**: Convert AST nodes to Doc IR using the builder primitives
- **Languages**: File extension mapping, language metadata
- **Options**: Plugin-specific formatting options with schema and defaults
- Comment handling hooks (canAttachComment, printComment, etc.)
- Embedded language delegation via `embed` hook

### How Adapters Declare Capabilities

A plugin exports up to 5 top-level fields:

```javascript
export default {
  languages: [
    { name: "MyLang", parsers: ["mylang"], extensions: [".ml"] }
  ],
  parsers: {
    mylang: {
      parse(text, options) { return myAST; },
      astFormat: "mylang-ast",
      locStart: (node) => node.start,
      locEnd: (node) => node.end
    }
  },
  printers: {
    "mylang-ast": {
      print(path, options, print) {
        const node = path.getValue();
        return group([node.keyword, indent([line, print("body")])]);
      },
      embed(path, options) { /* for embedded languages */ }
    }
  },
  options: {
    myOption: { type: "boolean", default: false, description: "..." }
  },
  defaultOptions: { tabWidth: 4 }
};
```

### Core Handles Passthrough Via

- **`astFormat` linkage**: Parsers declare `astFormat` string; printers are keyed by `astFormat`. Core matches parser output to the correct printer.
- **Doc IR boundary**: Printers return Docs built from core primitives. Core doesn't understand ASTs -- it only understands Docs.
- **Options merging**: Plugin `options` and `defaultOptions` merged into Prettier's config resolution
- **`embed` hook**: Printers delegate embedded regions (CSS in HTML) by calling `textToDoc` with a different parser

### Storage/Serialization

- Plugin declarations are JavaScript module exports (ESM since v3.0)
- Configuration: `.prettierrc` references plugins by module specifier in `plugins` array
- No separate schema file -- the plugin module IS the schema declaration
- Options surfaced via `prettier.getSupportInfo()` at runtime

### Adding New Adapters

- **Interface**: Export `languages`, `parsers`, `printers`, `options`, `defaultOptions`
- **Loading**: `import()` since v3.0 (must be ESM-compatible); no auto-discovery
- **Package convention**: `prettier-plugin-<name>` (conventional)
- **Distribution**: npm packages
- **No SDK**: Just implement the documented export shape

### Versioning & Compatibility

- v3.0 was a major breaking change: ESM-only loading, async parse/print, removed auto-search
- v3.6 added plugin override of builtin parsers for file inference
- Later plugins override earlier ones (last-wins for same `astFormat`)
- Plugin ordering in config matters for conflict resolution

### Key Pattern: **IR Boundary with Format Linkage**
Core defines a language-agnostic intermediate representation (Doc). Plugins translate TO that IR (via printers) and FROM source text (via parsers). The `astFormat` string is the linkage point. Core never touches ASTs directly -- the Doc IR is the universal contract.

---

## 5. Docker/OCI Plugin System

### Core vs Plugin Boundary

**Core owns:**
- Container lifecycle (create, start, stop, rm)
- Image management and distribution (pull, push, build)
- The plugin discovery and lifecycle system (install, enable, disable, remove)
- Default drivers: `local` volume driver, `bridge`/`host`/`overlay` network drivers, `json-file` log driver
- Plugin protocol definition (JSON-over-HTTP RPC)
- Plugin sandboxing (rootfs isolation, capability restrictions)

**Plugins own:**
- Driver-specific logic for their type (volume, network, auth, log, metrics)
- HTTP endpoint implementations conforming to the plugin protocol
- Connection management to external systems (cloud APIs, storage backends, auth services)
- Plugin-specific configuration options and environment variables

### How Adapters Declare Capabilities

Plugins use a **two-artifact** model: `rootfs/` (filesystem) + `config.json` (manifest):

```json
{
  "Description": "A sample volume plugin for Docker",
  "Documentation": "https://docs.docker.com/engine/extend/plugins/",
  "Entrypoint": ["/usr/bin/sample-volume-plugin", "/data"],
  "Interface": {
    "Socket": "plugin.sock",
    "Types": ["docker.volumedriver/1.0"]
  },
  "Network": { "Type": "" },
  "Linux": {
    "Capabilities": ["CAP_SYS_ADMIN"],
    "AllowAllDevices": false
  },
  "Env": [
    { "Name": "DEBUG", "Value": "0", "Settable": ["value"] }
  ],
  "Mounts": [],
  "PropagatedMount": "/data"
}
```

The `Interface.Types` field declares what plugin protocol(s) the plugin implements:
- `docker.volumedriver/1.0`
- `docker.networkdriver/1.0`
- `docker.ipamdriver/1.0`
- `docker.authz/1.0`
- `docker.logdriver/1.0`
- `docker.metricscollector/1.0`

At activation, the plugin responds to `/Plugin.Activate` with its implemented types:

```json
{ "Implements": ["VolumeDriver"] }
```

Each type has a defined HTTP API (e.g., `/VolumeDriver.Create`, `/VolumeDriver.Mount`, `/VolumeDriver.Get`, `/VolumeDriver.Capabilities`).

### Core Handles Passthrough Via

- **JSON-over-HTTP RPC**: Docker daemon sends POST requests to the plugin's Unix socket
- **Plugin discovery**: Docker scans `/run/docker/plugins/` for `.sock` files, `/etc/docker/plugins/` for `.spec`/`.json` files
- **Settable env vars**: `config.json` defines `Env` entries with `Settable` flags; users can configure at install time via `docker plugin set`
- **Plugin options**: Volume plugins receive `Opts` map on `/VolumeDriver.Create`; these are opaque key-value pairs passed through from `docker volume create --opt`

### Storage/Serialization

- Plugin config: `config.json` manifest (JSON, stored in plugin data directory)
- Plugin rootfs: filesystem image (like a minimal container)
- Distribution: plugins stored as Docker images on Docker Hub or private registries
- Plugin state: managed by Docker daemon (enabled/disabled, settings)

### Adding New Adapters

- **Two paths**: Managed plugins (v2, recommended) vs Legacy plugins (v1, deprecated)
  - **Managed**: `docker plugin create <name> <plugin-data-dir>` from rootfs + config.json
  - **Legacy**: Standalone process with socket/spec file in plugin directory
- **Distribution**: `docker plugin push` to registry, `docker plugin install` to consume
- **No SDK required**: Implement HTTP endpoints for the plugin type protocol
- **Plugin helpers**: Docker provides a Go SDK (`github.com/docker/go-plugins-helpers`) with handler interfaces

### Versioning & Compatibility

- Plugin API versioned via Accept header: `application/vnd.docker.plugins.v1+json`
- Interface types are versioned (e.g., `docker.volumedriver/1.0`)
- Managed plugins work in Swarm mode; legacy plugins do not
- Config format versioned as Plugin V2 config v1

### Key Pattern: **Process Isolation + HTTP Protocol**
Plugins are isolated processes (or containers) communicating via a typed HTTP RPC protocol. The manifest declares capabilities and sandbox constraints. Core routes requests to plugins based on declared interface types. Configuration is opaque key-value pairs passed through to the plugin.

---

## 6. Backstage (Spotify)

### Core vs Plugin Boundary

**Core owns:**
- The `app` (frontend) shell: routing, navigation, theming, provider tree
- The `backend` host: service lifecycle, dependency injection, configuration, logging, auth, database, HTTP routing, scheduler, cache
- Core services (`coreServices.*`): logger, httpRouter, rootConfig, discovery, auth, httpAuth, scheduler, rootLifecycle
- Core features as first-party plugins: Catalog, Scaffolder, TechDocs, Search (but these are themselves plugins)
- Extension point system: `createExtensionPoint` mechanism for plugin-to-plugin composition

**Plugins own:**
- Frontend: UI pages, entity cards/views, navigation items, custom APIs (via `ApiRef`/`ApiFactory`)
- Backend: HTTP routers, scheduled tasks, processors, custom auth providers, scaffolder actions
- Entity model extensions: custom entity kinds, processors for validation/enrichment
- Configuration schema for their specific settings

### How Adapters Declare Capabilities

**Frontend** plugins use factory helpers:

```typescript
// Plugin declaration
export const myPlugin = createPlugin({
  id: 'my-plugin',
  apis: [
    createApiFactory({
      api: myApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) => new MyApiClient({ discoveryApi, fetchApi }),
    }),
  ],
  routes: { root: rootRouteRef },
});

// Extension (page)
export const MyPluginPage = myPlugin.provide(
  createRoutableExtension({
    name: 'MyPluginPage',
    component: () => import('./components/MyPage'),
    mountPoint: rootRouteRef,
  }),
);
```

**Backend** plugins use the new backend system:

```typescript
export const myPlugin = createBackendPlugin({
  pluginId: 'my-plugin',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        config: coreServices.rootConfig,
      },
      async init({ logger, httpRouter, config }) {
        const router = Router();
        router.get('/health', (_, res) => res.json({ status: 'ok' }));
        httpRouter.use(router);
      },
    });
  },
});
```

**Backend modules** extend plugins via extension points:

```typescript
export const myModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'my-processor',
  register(env) {
    env.registerInit({
      deps: { catalog: catalogProcessingExtensionPoint },
      async init({ catalog }) {
        catalog.addProcessor(new MyCustomProcessor());
      },
    });
  },
});
```

### Core Handles Passthrough Via

- **Frontend DI**: `ApiRef` + `ApiFactory` pattern -- typed dependency injection resolved at app startup
- **Backend DI**: `coreServices.*` ServiceRefs resolved by the backend host; deps declared in `registerInit`
- **Extension points**: `createExtensionPoint` creates typed contracts; modules consume them via `deps`
- **Route indirection**: `RouteRef` objects decouple plugins from concrete URL paths
- **Catalog model**: Generic entity store; processors handle kind-specific validation/enrichment

### Storage/Serialization

- Frontend: plugins are NPM packages, composed in the app's `App.tsx`
- Backend: plugins are NPM packages, composed via `backend.add(import('...'))`
- Entity model: YAML descriptors in catalog, stored in catalog database
- Configuration: `app-config.yaml` with plugin-specific sections

### Adding New Adapters

- **Frontend**: Create NPM package exporting `createPlugin()` result + extensions
- **Backend**: Create NPM package exporting `createBackendPlugin()` result
- **Modules**: Extend existing plugins via `createBackendModule()` targeting a `pluginId`
- **Package naming**: `@backstage/plugin-<name>` (frontend), `@backstage/plugin-<name>-backend` (backend)
- **Distribution**: NPM packages; installed via package.json dependencies

### Versioning & Compatibility

- TypeScript typing enforces API contracts at compile time
- Circular service factory dependencies rejected at startup
- Modules must be co-deployed with the plugin they extend (same backend instance)
- Migration from legacy to new backend system via `@backstage/backend-test-utils`

### Key Pattern: **Typed Dependency Injection + Extension Points**
Both frontend and backend use typed DI (ApiRef/ServiceRef) with factory functions. Plugins declare dependencies and receive injected services. Extension points allow plugin-to-plugin composition without tight coupling. The catalog's generic entity model + pluggable processors is a clean example of core-schema + adapter-extensions.

---

## 7. Grafana Data Source Plugins

### Core vs Plugin Boundary

**Core owns:**
- Dashboard engine: panel rendering, layout, variables, annotations, transformations
- The **DataFrame** model: universal data structure (fields with typed arrays) that all panels consume
- Alerting engine and notification templates
- Plugin discovery, loading, signature validation, and sandboxing
- Query execution pipeline: receives DataQueryRequest, routes to data source, returns DataQueryResponse
- Configuration UI framework (settings pages, Save & Test flow)

**Plugins own:**
- **Query language and editor UI**: React components for constructing queries
- **Connection configuration**: auth credentials, endpoints, connection options
- **Query execution**: translating queries into API calls and returning DataFrames
- **Health checks**: `testDatasource` (frontend) / `CheckHealth` (backend)
- **Data transformation**: converting native API responses into Grafana DataFrames
- Optional: streaming data, annotations, variable support, CallResource endpoints

### How Adapters Declare Capabilities

**`plugin.json` manifest** declares plugin metadata and capability flags:

```json
{
  "id": "myorg-mydatasource",
  "type": "datasource",
  "name": "My Data Source",
  "backend": true,
  "executable": "gpx_mydatasource",
  "info": { "version": "1.0.0", "author": { "name": "MyOrg" } },
  "dependencies": { "grafanaDependency": ">=10.0.0" },
  "metrics": true,
  "logs": true,
  "streaming": true,
  "alerting": true,
  "annotations": true
}
```

**Frontend** registration uses TypeScript generics:

```typescript
interface MyQuery extends DataQuery {
  queryText?: string;
  metric?: string;
}

interface MyDataSourceOptions extends DataSourceJsonData {
  endpoint?: string;
}

export const plugin = new DataSourcePlugin<MyDataSource, MyQuery, MyDataSourceOptions>(
  MyDataSource
)
  .setQueryEditor(QueryEditor)
  .setConfigEditor(ConfigEditor);
```

**Backend** (Go) implements SDK handler interfaces:

```go
type MyDataSource struct{}

func (d *MyDataSource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
    // Execute queries, return DataFrames
}

func (d *MyDataSource) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
    return &backend.CheckHealthResult{Status: backend.HealthStatusOk, Message: "OK"}, nil
}
```

### Core Handles Passthrough Via

- **DataFrame as universal contract**: Core never interprets query semantics; it only understands DataFrames. Plugins transform their native data into DataFrames with typed fields.
- **`plugin.json` capability flags**: Boolean flags (metrics, logs, streaming, alerting) toggle core UI and runtime behaviors
- **Generic query routing**: Core creates DataQueryRequest with plugin-typed query objects and routes to the correct plugin
- **`jsonData` / `secureJsonData`**: Plugin configuration stored as opaque JSON; `jsonData` accessible to frontend, `secureJsonData` encrypted and backend-only
- **gRPC transport**: Backend plugins run as separate processes; Grafana communicates via the plugin SDK's gRPC protocol

### Storage/Serialization

- Plugin manifest: `plugin.json` (static, in plugin directory)
- Data source instances: stored in Grafana's database as JSON (`jsonData` + encrypted `secureJsonData`)
- Query models: serialized as JSON in dashboard JSON (each panel stores its query objects)
- Plugin binaries: `dist/` directory with `module.js` (frontend) + compiled Go binary (backend)

### Adding New Adapters

- **Scaffold**: `npx @grafana/create-plugin` generates project structure
- **Frontend SDK**: `@grafana/data` (types), `@grafana/runtime` (services)
- **Backend SDK**: `grafana-plugin-sdk-go` (Go SDK with handler interfaces)
- **Signing**: Required for distribution; `GRAFANA_ACCESS_POLICY_TOKEN` + signing tool produces `MANIFEST.txt`
- **Distribution**: Grafana plugin catalog (signed) or self-hosted (can allow unsigned)

### Versioning & Compatibility

- `grafanaDependency` in `plugin.json` specifies minimum Grafana version
- Plugin signing levels: Private, Community, Commercial
- Angular plugins deprecated in v10; React/TS required for new plugins
- Frontend sandbox (public preview) for isolating plugin code

### Key Pattern: **DataFrame Universal Contract + Dual SDK**
Core defines a universal data model (DataFrame) that all panels consume. Plugins translate between their native data and DataFrames. Frontend (TypeScript) and backend (Go) SDKs provide typed interfaces. The `plugin.json` manifest declares capabilities as boolean flags that toggle core behaviors.

---

## 8. Home Assistant Integration Architecture

### Core vs Plugin Boundary

**Core owns:**
- The **state machine**: central store of all entity states and attributes
- **Entity model**: `Entity` base class + domain-specific entity classes (LightEntity, SwitchEntity, SensorEntity, ClimateEntity, CoverEntity, MediaPlayerEntity)
- **Registries**: entity registry (unique_id persistence), device registry (device grouping), area registry
- **Event bus** and **service registry**: event-driven architecture, service call dispatch
- **Config flow framework**: UI setup wizard infrastructure
- **DataUpdateCoordinator**: shared polling/push coordination utility
- **Domain definitions**: each domain (light, switch, sensor, etc.) defines standard attributes, services, states, and supported_features bitmasks

**Integrations own:**
- **Platform implementations**: Concrete subclasses of domain entity classes (e.g., `MyLightEntity(LightEntity)`)
- **Device communication**: API clients, protocols, polling/push logic
- **Config flow**: `config_flow.py` implementing setup wizard steps
- **Manifest**: `manifest.json` declaring metadata, dependencies, requirements
- **Service implementations**: `turn_on`, `set_temperature`, etc. -- translating HA service calls to device API calls

### How Adapters Declare Capabilities

**`manifest.json`** declares integration metadata:

```json
{
  "domain": "my_integration",
  "name": "My Integration",
  "version": "1.0.0",
  "config_flow": true,
  "requirements": ["mydevicelib==2.3.4"],
  "dependencies": ["mqtt"],
  "iot_class": "local_polling",
  "codeowners": ["@myuser"]
}
```

**Platform implementation** follows the entity class pattern:

```python
class MyLight(LightEntity):
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS, ColorMode.COLOR_TEMP}
    _attr_supported_features = LightEntityFeature.EFFECT | LightEntityFeature.TRANSITION

    def __init__(self, coordinator, device_id):
        self._attr_unique_id = f"{device_id}_light"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device_id)},
            manufacturer="MyBrand",
            model="SmartLight v2",
        )

    @property
    def brightness(self):
        return self.coordinator.data["brightness"]

    async def async_turn_on(self, **kwargs):
        await self._device.set_brightness(kwargs.get("brightness", 255))
```

**Registration** in `__init__.py`:

```python
PLATFORMS = [Platform.LIGHT, Platform.SENSOR, Platform.SWITCH]

async def async_setup_entry(hass, entry):
    client = await create_client(entry.data)
    coordinator = DataUpdateCoordinator(hass, _LOGGER, name=DOMAIN, update_method=client.fetch)
    await coordinator.async_config_entry_first_refresh()
    hass.data[DOMAIN][entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
```

### Core Handles Passthrough Via

- **Entity class inheritance**: Core defines abstract properties and methods on entity base classes (e.g., `brightness`, `color_temp`, `turn_on`). Integrations implement these.
- **`supported_features` bitmask**: Each entity declares what it supports; core UI renders controls based on these flags
- **`device_class` / `state_class`**: Standard enums that core uses for UI rendering, unit conversion, long-term statistics
- **Config entries**: Opaque `data` dict stored by core; integration defines schema via config flow
- **Service call kwargs**: When a user calls `light.turn_on`, core passes kwargs (brightness, color_temp, effect) to the entity's `async_turn_on`

### Storage/Serialization

- Integration package: Python package in `custom_components/<domain>/` or built-in `homeassistant/components/<domain>/`
- Config entries: stored in `.storage/core.config_entries` (JSON)
- Entity registry: `.storage/core.entity_registry` (JSON, maps unique_id to entity_id)
- Device registry: `.storage/core.device_registry` (JSON, groups entities by device)
- State: in-memory state machine, exposed via REST API and WebSocket

### Adding New Adapters

- **Directory structure**: `<domain>/manifest.json`, `__init__.py`, `config_flow.py`, `sensor.py`, `light.py`, etc.
- **No SDK beyond HA core**: Import from `homeassistant.components.<domain>` for entity base classes
- **Config flow**: Implement `ConfigFlow` subclass with `async_step_user`, `async_step_*` methods
- **Distribution**: HACS (community store) or built-in to HA core
- **Discovery**: Manifest declares `zeroconf`, `ssdp`, `bluetooth`, `dhcp` entries for auto-discovery

### Versioning & Compatibility

- `manifest.json` `version` field for integration version
- `requirements` auto-installs Python dependencies
- `dependencies`/`after_dependencies` control load order
- `iot_class` communicates connectivity model to users
- Entity lifecycle states: NOT_ADDED -> ADDING -> ADDED -> REMOVED

### Key Pattern: **Abstract Entity Classes + Platform Modules**
Core defines domain-specific abstract entity classes with standard properties, services, and feature flags. Integrations implement concrete subclasses that translate between the device API and the core entity model. The `supported_features` bitmask is the capability declaration mechanism. Discovery and setup are handled by the config flow framework.

---

## Synthesis for agent-manager

### Pattern Comparison Matrix

| System | Boundary Mechanism | Schema Declaration | Communication | Passthrough Config | Discovery |
|--------|-------------------|-------------------|---------------|-------------------|-----------|
| **Terraform** | gRPC protocol | Go interfaces (SDK) | Separate processes via gRPC | DynamicValue (MessagePack) | Registry + manifest |
| **VS Code** | Manifest + runtime API | `package.json` contributes | Extension Host process | JSON settings schema | Marketplace |
| **ESLint** | Convention objects | Plain JS object shape | In-process imports | Rule options (JSON Schema) | npm + imports |
| **Prettier** | IR boundary (Doc) | Module exports | In-process imports | Options object | npm + config |
| **Docker** | HTTP RPC protocol | `config.json` manifest | Separate process via HTTP | Opaque Opts map | Socket/spec files |
| **Backstage** | Typed DI + extension points | Factory functions | In-process (frontend/backend) | Config YAML sections | npm packages |
| **Grafana** | DataFrame contract + dual SDK | `plugin.json` manifest | Separate process via gRPC | jsonData/secureJsonData | Plugin catalog |
| **Home Assistant** | Abstract entity classes | Python class inheritance | In-process Python | Config entries (opaque dict) | manifest.json + HACS |

### Three Dominant Patterns Observed

#### Pattern 1: Schema-Driven Protocol (Terraform, Grafana, Docker)
Core and adapters are separate processes. Core discovers adapter capabilities via a protocol (gRPC/HTTP). Adapters declare their schemas at runtime via protocol RPCs. Config is passed through as opaque values.

**Best for**: Strong isolation, language-agnostic adapters, large ecosystem with untrusted plugins.

#### Pattern 2: Manifest + Runtime Registration (VS Code, Backstage, Grafana)
A static manifest declares capabilities and schema extensions (for UI, discoverability, validation). Runtime API calls register behavior/implementations. Two-phase: declare statically what you CAN do, register dynamically what you DO.

**Best for**: Rich UI integration, progressive disclosure, lazy loading.

#### Pattern 3: Convention Object Shape (ESLint, Prettier, Home Assistant)
Adapters are plain objects/classes conforming to well-known shapes. No formal protocol or manifest -- the object IS the contract. Core inspects adapter properties/methods to determine capabilities.

**Best for**: Simplicity, low ceremony, same-language ecosystem.

### Recommended Architecture for agent-manager

Given that agent-manager needs:
1. A **universal core schema** for AI agent configs
2. **Pluggable adapters** for each IDE/agent tool (Claude Code, Cursor, Windsurf, Copilot, etc.)
3. Adapters that can **extend the schema** with tool-specific fields
4. Config stored as **files on disk** (TOML/YAML)

The recommended approach is a **hybrid of Pattern 2 and Pattern 3**:

#### Core Schema (agent-manager owns)
Define a universal schema for agent configuration, analogous to Terraform's core block types or Home Assistant's entity base classes:

```toml
# Core schema fields that ALL adapters must support
[agent]
name = "my-agent"
model = "claude-sonnet-4"
instructions = "path/to/instructions.md"
tools = ["read", "write", "bash"]
max_tokens = 8192

[agent.permissions]
allow = ["Read", "Write(src/**)", "Bash(git *)"]
deny = ["Write(.env)"]

[agent.context]
include = ["src/**", "docs/**"]
exclude = ["node_modules/**", "dist/**"]
```

#### Adapter Extension Mechanism
Each adapter declares its capabilities and schema extensions using **convention objects** (like ESLint plugins) with a **manifest** (like VS Code/Grafana):

```typescript
// Adapter interface (convention-based, like ESLint plugin shape)
interface AgentManagerAdapter {
  meta: {
    name: string;           // "claude-code"
    version: string;
    supportedFeatures: string[];  // ["mcp", "hooks", "permissions", "skills"]
  };

  // Schema extension: adapter-specific fields
  schema: {
    properties: Record<string, SchemaProperty>;  // JSON Schema fragments
    defaults: Record<string, unknown>;
  };

  // Translators: core schema -> native config
  serialize(coreConfig: AgentConfig): NativeConfig;   // core -> .claude.json
  deserialize(nativeConfig: NativeConfig): AgentConfig; // .claude.json -> core

  // Validation
  validate(config: AgentConfig): ValidationResult;
}
```

#### Passthrough Mechanism (inspired by Terraform/Grafana)
Adapter-specific config stored in a namespaced section, passed through opaquely:

```toml
# Core schema (validated by agent-manager)
[agent]
name = "my-agent"
model = "claude-sonnet-4"

# Adapter-specific extensions (validated by adapter, passed through by core)
[agent.adapters.claude-code]
permission_mode = "allowEdits"
mcp_servers = ["fetch", "tavily"]
hooks.pre_tool_use = ["lint-check.sh"]

[agent.adapters.cursor]
rules_file = ".cursorrules"
composer_agent = true

[agent.adapters.copilot]
instructions_file = ".github/copilot-instructions.md"
```

#### Key Design Decisions

1. **Core schema is strict, adapter sections are opaque**: Like Terraform (core validates its blocks, providers validate theirs) and Grafana (core handles DataFrames, plugins handle queries). agent-manager validates the core `[agent]` section; each adapter validates its own `[agent.adapters.<name>]` section.

2. **Adapters are convention-based objects**: Like ESLint plugins -- plain TypeScript objects with well-known properties. No gRPC, no separate processes. Import and call.

3. **Manifest for discoverability**: Like VS Code's `package.json` or Grafana's `plugin.json`, each adapter package includes a manifest that declares supported features, schema extensions, and version compatibility. This enables CLI tooling to list available adapters and their capabilities.

4. **Feature flags over inheritance**: Like Grafana's boolean capability flags (`metrics`, `logs`, `streaming`) and Home Assistant's `supported_features` bitmask. Adapters declare capabilities as feature flags rather than implementing abstract classes.

5. **Bidirectional translation**: Unlike most systems studied (which are one-directional), agent-manager adapters must translate in BOTH directions -- reading existing native configs and writing updated native configs. This is closest to Terraform's `DynamicValue` serialization model.

6. **Namespace isolation**: Like ESLint's `pluginName/ruleName` and Docker's `docker.volumedriver/1.0` type namespacing. Adapter-specific config is always namespaced under `agent.adapters.<adapter-name>` to prevent collisions.

#### Implementation Priority

1. **Define the core schema** (TOML with JSON Schema validation) -- the universal fields all adapters share
2. **Adapter interface** (TypeScript convention object) -- serialize/deserialize/validate
3. **First adapters**: Claude Code, Cursor, Copilot -- validate the schema boundary
4. **CLI tooling** for adapter discovery and config generation
5. **Schema evolution** strategy -- semver for core schema, adapters pin compatible core versions

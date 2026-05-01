# Wiki Visual Browser — Design Document

**Date:** 2026-04-16
**Status:** Parked — no scheduled milestone as of 2026-05-01. Maps to Pillars 5+6
(LLM-wiki surfaced in the web UI). Retained as a design artifact; revisit when
the wiki has a user population that would benefit from graph navigation.
**Author:** agent (design agent)

## Overview

Add two new tabs — **Wiki** and **Graph** — to the existing `index.html` dashboard.
The current Servers view becomes the first tab. All three tabs share the same
single-file HTML pattern (embedded CSS + JS, no build step). The wiki browser
consumes the REST API endpoints already implemented in both `server.ts` (local)
and `worker.ts` (Cloudflare Worker).

## Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  agent-manager                                   [user-bar] │
│  MCP server configuration dashboard                         │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│  │ Servers  │ │  Wiki    │ │  Graph   │   ← tab bar        │
│  └──────────┘ └──────────┘ └──────────┘                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  WIKI TAB — List View                                       │
│  ┌─────────────────────────────┐ ┌────────────────────────┐ │
│  │ Project: [global ▾]        │ │ 🔍 Search pages...     │ │
│  └─────────────────────────────┘ └────────────────────────┘ │
│                                                             │
│  ┌──────┬──────────────────┬────────┬──────────┬──────────┐ │
│  │ Type │ Title            │ Tags   │ Updated  │ Conf.    │ │
│  ├──────┼──────────────────┼────────┼──────────┼──────────┤ │
│  │ entity│ aws-bedrock     │ infra  │ 2d ago   │ 0.95     │ │
│  │ concept│ agent-routing  │ arch   │ 5d ago   │ 0.80     │ │
│  │ ...  │                  │        │          │          │ │
│  └──────┴──────────────────┴────────┴──────────┴──────────┘ │
│                                                             │
│  WIKI TAB — Read View (after clicking a row)                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ← Back to list                              [project]  │ │
│  ├─────────────────────────────────────────────────────────┤ │
│  │ # aws-bedrock                                          │ │
│  │ Type: entity | Tags: infra, ml | Updated: 2026-04-10   │ │
│  │ Confidence: 0.95                                       │ │
│  │ ─────────────────────────────────────────────────────── │ │
│  │ Markdown body rendered here...                         │ │
│  │                                                        │ │
│  │ [[wikilinks]] rendered as clickable internal links     │ │
│  │ that navigate to the target page within the browser.   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
│  GRAPH TAB                                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           ┌───┐         ┌───┐                          │ │
│  │      ●────│ A │────●────│ B │                          │ │
│  │     /     └───┘    |    └───┘\                         │ │
│  │ ┌───┐            ┌───┐       ┌───┐                     │ │
│  │ │ C │            │ D │       │ E │     force-directed  │ │
│  │ └───┘            └───┘       └───┘     node layout     │ │
│  │                                                        │ │
│  │  Legend: ● entity  ◆ concept  ■ summary  ▲ synthesis   │ │
│  │  Edge: ── wikilink  ·· backlink  -- entity_mention     │ │
│  ├─────────────────────────────────────────────────────────┤ │
│  │ Click node → navigate to Wiki tab read view            │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Component Structure

### Tab System

```
<div class="tabs">
  <button class="tab active" data-tab="servers">Servers</button>
  <button class="tab" data-tab="wiki">Wiki</button>
  <button class="tab" data-tab="graph">Graph</button>
</div>
<div class="tab-content" id="tab-servers"> ... existing content ... </div>
<div class="tab-content" id="tab-wiki" style="display:none"> ... </div>
<div class="tab-content" id="tab-graph" style="display:none"> ... </div>
```

The existing status bar, profile switcher, server table, tool sync, and actions
sections are wrapped in `#tab-servers`. Switching tabs shows/hides via
`display:none` — no re-renders, state preserved.

### Wiki Tab Components

| Component | Element | Behavior |
|-----------|---------|----------|
| **Project Switcher** | `<select id="wiki-project">` | Dropdown populated from `/api/wiki/projects`. Options: "global" + each project name. Changing triggers page list reload. |
| **Search Bar** | `<input id="wiki-search">` | Debounced (300ms). Empty = show full list. Non-empty = call search endpoint. |
| **Page Table** | `<table id="wiki-pages">` | Columns: Type (badge), Title (clickable), Tags, Updated (relative), Confidence (bar). Sortable by clicking headers. |
| **Read Panel** | `<div id="wiki-reader">` | Hidden by default. Shows rendered markdown, metadata header, back button. Replaces page table when active. |
| **Type Filter** | `<select id="wiki-type-filter">` | Optional filter: all / entity / concept / summary / synthesis / decision. Applied client-side on loaded pages. |

### Graph Tab Components

| Component | Element | Behavior |
|-----------|---------|----------|
| **Canvas** | `<div id="graph-container">` | Full-width, 500px min-height. Contains the force-directed SVG. |
| **Legend** | `<div id="graph-legend">` | Color-coded node types + edge type line styles. |
| **Info Panel** | `<div id="graph-info">` | Shows hovered node details (title, type, connection count). |

## API Endpoint Mapping

### Local Server (`am serve` — same origin)

| View | Endpoint | Method | Params | Response |
|------|----------|--------|--------|----------|
| Project list | `GET /api/wiki/projects` | GET | — | `{ projects: string[] }` |
| Page list | `GET /api/wiki/pages` | GET | `?type=&global=true` | `{ pages: [{slug,title,type,tags,updated,confidence}] }` |
| Search | `GET /api/wiki/search` | GET | `?q=&limit=&global=true` | `{ query, results: [{slug,title,type,score,tags}] }` |
| Read page | `GET /api/wiki/pages/:slug` | GET | `?global=true` | `{ page: WikiPage }` (full content) |
| Graph | `GET /api/wiki/graph` | GET | `?global=true` | `{ nodes: [{id,label,type}], edges: [{source,target,type}] }` |

**Project scoping for local:** The `global` query param selects between the
global wiki dir and the project-scoped wiki dir (resolved from the current
config directory). For project-specific pages, omit `global=true` — the server
resolves the wiki dir from the active project context.

### CF Worker (cloud mode — `/:owner/:repo` prefix)

| View | Endpoint | Method | Params | Response |
|------|----------|--------|--------|----------|
| Project list | `GET /api/wiki/:owner/:repo/projects` | GET | — | `{ projects: string[] }` |
| Page list | `GET /api/wiki/:owner/:repo/pages` | GET | `?project=` | `{ pages: [{slug,type,path}] }` |
| Read page | `GET /api/wiki/:owner/:repo/pages/:slug` | GET | `?project=&type=` | `{ slug, type, content }` |
| Graph | *Not available* | — | — | — |

**Key difference:** The Worker reads from the git tree via the provider
abstraction (GitHub/GitLab/Gitea APIs). It does not have a local filesystem, so:
- `parseTree()` returns `{slug, type, path}` — no `title`, `tags`, `updated`, or `confidence`
- Search is not implemented server-side; the browser will do client-side filtering
- Graph endpoint does not exist; the Graph tab will be hidden in cloud mode

### API Adapter Layer (in-browser)

```js
const WikiAPI = {
  isCloud: false,
  owner: null,   // set in cloud mode
  repo: null,

  async projects() {
    return this.isCloud
      ? api(`/api/wiki/${this.owner}/${this.repo}/projects`)
      : api("/api/wiki/projects");
  },

  async pages(project) {
    if (this.isCloud) {
      const params = project ? `?project=${project}` : "";
      return api(`/api/wiki/${this.owner}/${this.repo}/pages${params}`);
    }
    const params = project ? "" : "?global=true";
    return api(`/api/wiki/pages${params}`);
  },

  async search(query, limit = 20) {
    if (this.isCloud) return null; // client-side only
    return api(`/api/wiki/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  },

  async read(slug, project, type) {
    if (this.isCloud) {
      const params = new URLSearchParams();
      if (project) params.set("project", project);
      if (type) params.set("type", type);
      return api(`/api/wiki/${this.owner}/${this.repo}/pages/${slug}?${params}`);
    }
    return api(`/api/wiki/pages/${slug}`);
  },

  async graph() {
    if (this.isCloud) return null;
    return api("/api/wiki/graph");
  },
};
```

## Graph Visualization Approach

### Library: d3-force (via CDN)

**Choice rationale:**
- **vis-network** (470 KB min) — too heavy for a single-file HTML
- **d3-force** (~30 KB for d3-force + d3-selection + d3-zoom) — modular, CDN-friendly, widely used
- **Pure SVG** — possible but would require reimplementing force simulation; fragile

Use `d3-force` for the physics simulation, render to inline SVG. Import only the
needed d3 modules via ESM CDN (e.g., `https://cdn.jsdelivr.net/npm/d3-force@3/+esm`).

**CDN imports (ESM, module script):**

```html
<script type="module">
  import { forceSimulation, forceLink, forceManyBody, forceCenter }
    from "https://cdn.jsdelivr.net/npm/d3-force@3/+esm";
  import { select } from "https://cdn.jsdelivr.net/npm/d3-selection@3/+esm";
  import { zoom } from "https://cdn.jsdelivr.net/npm/d3-zoom@3/+esm";
  import { drag } from "https://cdn.jsdelivr.net/npm/d3-drag@3/+esm";
</script>
```

Total additional payload: ~35 KB gzipped.

### Node Rendering

| Page Type | Shape | Color (light) | Color (dark) |
|-----------|-------|---------------|--------------|
| entity | circle (r=8) | `#2563eb` (blue) | `#3b82f6` |
| concept | diamond (rotated square) | `#7c3aed` (purple) | `#a78bfa` |
| summary | square (10x10) | `#16a34a` (green) | `#22c55e` |
| synthesis | triangle | `#ca8a04` (yellow) | `#eab308` |
| decision | hexagon | `#dc2626` (red) | `#ef4444` |

Each node displays a truncated label (max 20 chars) below the shape. On hover,
full title and connection count appear in `#graph-info`.

### Edge Rendering

| Edge Type | SVG Style | Opacity |
|-----------|-----------|---------|
| wikilink | solid line, 1.5px | 0.6 |
| backlink | dashed line, 1px | 0.3 |
| entity_mention | dotted line, 1px | 0.4 |
| related | solid line, 1px, gray | 0.2 |

### Interactions

- **Drag** nodes to reposition (simulation restarts with `alphaTarget`)
- **Zoom/pan** via d3-zoom on the SVG container
- **Click** a node to navigate to Wiki tab and load that page's read view
- **Hover** shows tooltip with title, type, and neighbor count
- Simulation auto-stops after settling (`alpha < 0.001`)

### Force Parameters

```js
forceSimulation(nodes)
  .force("link", forceLink(edges).id(d => d.id).distance(80))
  .force("charge", forceManyBody().strength(-200))
  .force("center", forceCenter(width / 2, height / 2))
  .force("collision", forceCollide().radius(20))
```

These values produce a readable layout for 10-200 nodes. For graphs over 200
nodes, increase charge strength and link distance proportionally.

## Interaction Flows

### Flow 1: Browse pages

```
[Load Wiki tab]
    |
    v
[Fetch /api/wiki/projects] → populate project dropdown
    |
    v
[Fetch /api/wiki/pages?global=true] → populate page table
    |
    v
[User selects project from dropdown]
    |
    v
[Fetch /api/wiki/pages] → replace table rows
    |
    v
[User clicks a page row]
    |
    v
[Fetch /api/wiki/pages/:slug] → show read panel (hide table)
    |
    v
[User clicks "Back to list"] → hide read panel, show table
```

### Flow 2: Search

```
[User types in search bar] → 300ms debounce
    |
    v
[query.length >= 2?]
    |── yes ──> [Fetch /api/wiki/search?q=...] → replace table with results
    |── no ───> [Fetch /api/wiki/pages] → show full list
```

In cloud mode (no search endpoint), filtering is done client-side against the
already-loaded page list, matching on slug and type.

### Flow 3: Graph explore

```
[Load Graph tab]
    |
    v
[Fetch /api/wiki/graph] → receive {nodes, edges}
    |
    v
[Initialize d3-force simulation] → render SVG
    |
    v
[User clicks a node]
    |
    v
[Switch to Wiki tab] → [Fetch /api/wiki/pages/:slug] → show read view
```

### Flow 4: Wikilink navigation

```
[User reads a page with [[wikilink]] in content]
    |
    v
[Renderer converts [[target]] to <a data-slug="target">]
    |
    v
[User clicks the link]
    |
    v
[Fetch /api/wiki/pages/target] → replace read panel content
    |
    v
[Browser history stack tracks slug for back navigation]
```

## Markdown Rendering

For the read view, markdown content needs to be rendered as HTML. Options:

1. **marked.js** (CDN, ~40 KB) — full-featured, fast, well-maintained
2. **Simple regex** — fragile, headers/lists/code only
3. **Server-side** — would require API changes

**Choice: marked.js via CDN.** One additional import:

```html
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
```

Custom renderer for `[[wikilinks]]`: pre-process the markdown to convert
`[[slug]]` to `<a href="#" class="wikilink" data-slug="slug">slug</a>` before
passing to marked. This avoids modifying the marked parser.

Security: Use `marked.setOptions({ sanitize: false })` combined with a
post-render pass that strips `<script>` tags and `on*` attributes. Since wiki
content is self-authored (not user-generated from untrusted sources), the XSS
risk is minimal, but the strip pass is defense-in-depth.

## Responsive Design

| Breakpoint | Layout Change |
|------------|---------------|
| >= 768px | Full table columns, graph at 500px height, side-by-side controls |
| < 768px | Table hides Tags and Confidence columns, graph at 300px height, controls stack vertically |
| < 480px | Table shows only Title + Type, search bar full-width above project selector |

```css
@media (max-width: 768px) {
  .wiki-col-tags, .wiki-col-confidence { display: none; }
  #graph-container { min-height: 300px; }
  .wiki-controls { flex-direction: column; }
}
@media (max-width: 480px) {
  .wiki-col-updated { display: none; }
  .wiki-controls > * { width: 100%; }
}
```

## Cloud vs Local Mode Differences

| Feature | Local (`am serve`) | Cloud (CF Worker) |
|---------|-------------------|-------------------|
| Project switcher | from `/api/wiki/projects` | from `/api/wiki/:o/:r/projects` |
| Page list | full metadata (title, tags, updated, confidence) | minimal (slug, type, path only) |
| Search | server-side BM25 via MiniSearch | client-side slug/type filter |
| Read page | full `WikiPage` object with frontmatter | raw markdown content string |
| Graph tab | fully functional | **hidden** (no endpoint) |
| Page title | from frontmatter | derived from slug (capitalize, replace hyphens) |

The `WikiAPI` adapter (shown above) abstracts these differences. Components
check `WikiAPI.isCloud` to adjust rendering (e.g., hide confidence column,
derive title from slug).

## File Changes

All changes in a single file: **`src/web/public/index.html`**

No new files. No server-side changes needed — all endpoints already exist.

## Estimated LOC

| Section | Lines |
|---------|-------|
| CSS additions (tabs, wiki, graph, responsive) | ~120 |
| HTML structure (tab bar, wiki panel, graph panel) | ~60 |
| JS: Tab system | ~25 |
| JS: WikiAPI adapter | ~50 |
| JS: Wiki list/search/filter | ~100 |
| JS: Wiki read panel + markdown render | ~80 |
| JS: Wikilink processing | ~20 |
| JS: Graph visualization (d3-force) | ~120 |
| JS: Graph interactions (drag, zoom, click) | ~40 |
| JS: Cloud/local mode integration | ~30 |
| JS: Responsive adjustments | ~15 |
| **Total** | **~660** |

Combined with the existing 548 lines, the final `index.html` will be
approximately **1,200 lines** — still manageable as a single file.

## External Dependencies (CDN)

| Library | Version | Size (gzip) | Purpose |
|---------|---------|-------------|---------|
| d3-force | 3.x | ~8 KB | Force simulation |
| d3-selection | 3.x | ~8 KB | SVG DOM manipulation |
| d3-zoom | 3.x | ~8 KB | Pan + zoom |
| d3-drag | 3.x | ~5 KB | Node dragging |
| marked | 12.x | ~40 KB | Markdown → HTML |
| **Total** | | **~69 KB** | |

All loaded via `cdn.jsdelivr.net` with pinned major versions. The page remains
functional (minus graph + markdown rendering) if the CDN is unreachable — the
page list and search work with vanilla JS only.

## Open Questions

1. **Graph performance ceiling:** d3-force handles ~500 nodes smoothly. For very
   large wikis, should we add a "show top N connected nodes" filter? Defer to
   implementation — add if needed.

2. **Page editing:** The current design is read-only. Adding inline editing would
   require new API endpoints (`PUT /api/wiki/pages/:slug`). Out of scope for v1.

3. **Graph in cloud mode:** The Worker could compute the graph by parsing
   wikilinks from the tree listing, but this would require multiple API calls
   per page. Deferred — show "Graph not available in cloud mode" message.

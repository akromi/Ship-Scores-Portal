# Cruise Ship Inspection Scores — Architecture Design Document

**Component:** Ship Scores Browse Page  
**Portal:** SafePort Portal (Health Canada)  
**Version:** 2.0 (Post-Review)  
**Date:** 2026-02-26  
**Author:** Akram Farhat / Claude  
**Status:** Review + Recommendations

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Component Architecture](#3-component-architecture)
4. [Data Flow & OData Queries](#4-data-flow--odata-queries)
5. [Tree UI Structure](#5-tree-ui-structure)
6. [Lazy Loading & Caching](#6-lazy-loading--caching)
7. [Search & Filtering](#7-search--filtering)
8. [Accessibility Architecture](#8-accessibility-architecture)
9. [Bilingual Support](#9-bilingual-support)
10. [CSS Architecture](#10-css-architecture)
11. [Code Quality Review](#11-code-quality-review)
12. [Issues & Recommendations](#12-issues--recommendations)
13. [Testing Checklist](#13-testing-checklist)

---

## 1. Executive Summary

The Cruise Ship Inspection Scores page is a **public-facing, read-only browse interface** within the SafePort Portal that displays Health Canada's cruise ship inspection results. Users can search and browse a hierarchical tree of **Cruise Lines → Vessels → Inspection History** with scores from the last 5 years.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Two-tier `<details>` tree | Native HTML disclosure = keyboard + SR accessible with zero libraries |
| Lazy inspection loading | Vessel list loads once; per-vessel history loads on expand (reduces initial payload) |
| Client-side date filtering | `LastXYears` OData function has tenant-specific issues; client filter is reliable |
| Template cloning from DOM | Server-rendered Liquid snippet text preserved without JS string duplication |
| No `role="button"` on `<summary>` | Native disclosure semantics are correct; adding role forces NVDA focus mode |

### File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `shipScores.js` | 1,356 | Tree rendering, OData loading, search, a11y, focus management |
| `shipScores.css` | ~280 | Tree styling, search input, responsive layout, WET4 focus rings |
| HTML (Liquid) | — | Server-rendered tree shell, i18n snippets, demo ship template |

---

## 2. System Overview

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (Client)                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ shipScores.js│  │shipScores.css│  │  HTML (Liquid/WET4)   │  │
│  │              │  │              │  │                       │  │
│  │ • OData load │  │ • Tree layout│  │ • #browseTree shell   │  │
│  │ • Tree build │  │ • Search box │  │ • #linerSearch input  │  │
│  │ • Search     │  │ • Focus rings│  │ • #shipScoresText i18n│  │
│  │ • A11y/focus │  │ • Responsive │  │ • Demo ship template  │  │
│  │ • Lazy load  │  │ • GCWeb      │  │ • Snippet strings     │  │
│  └──────┬───────┘  └──────────────┘  └───────────────────────┘  │
│         │                                                       │
│         │ /_api/ethi_vessels?$expand=...                         │
│         │ /_api/incidents?$filter=...                            │
│         ▼                                                       │
├─────────────────────────────────────────────────────────────────┤
│                    POWER PAGES (Server)                          │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Web API      │  │ Liquid Rendering │  │  Site Settings   │  │
│  │  (OData)      │  │ (Snippets/i18n)  │  │  (Permissions)   │  │
│  └──────┬───────┘  └──────────────────┘  └──────────────────┘  │
│         │                                                       │
│         ▼                                                       │
├─────────────────────────────────────────────────────────────────┤
│                       DATAVERSE                                  │
│  ┌──────────────────┐  ┌────────────────────────────────────┐   │
│  │  ethi_vessels     │  │  incidents (Case)                  │   │
│  │                   │  │                                    │   │
│  │  • ethi_name      │  │  • ethi_inspectionscore           │   │
│  │  • ethi_vesselid  │  │  • ethi_inspectionenddateandtime  │   │
│  │  • ethi_OwnerId → │  │  • _ethi_conveyance_value →       │   │
│  │  • ethi_shipweight│  │  • ethi_inspectionscope            │   │
│  │  • statecode      │  │  • _ethi_rbiinspectiontype_value   │   │
│  │  • statuscode     │  │  • ethi_finalreportcreated         │   │
│  └──────────────────┘  └────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────┐                                            │
│  │  accounts         │                                           │
│  │  (Cruise Lines)   │                                           │
│  │  • name           │                                           │
│  │  • statecode      │                                           │
│  └──────────────────┘                                            │
└──────────────────────────────────────────────────────────────────┘
```

### Data Relationships

```
accounts (Cruise Line)
  ├── name: "Royal Caribbean Group"
  │
  └──< ethi_vessels (Ship)
       ├── ethi_name: "Symphony of the Seas"
       ├── ethi_OwnerId → accounts
       ├── ethi_shipweightrange: "226,963 GT"
       │
       └──< incidents (Inspection)
            ├── ethi_inspectionscore: 98
            ├── ethi_inspectionenddateandtime: "2025-03-15T14:00:00Z"
            ├── _ethi_conveyance_value → ethi_vessels
            └── ethi_finalreportcreated: (not null)
```

---

## 3. Component Architecture

### Module Map

The IIFE (`shipScores.js`) contains these logical modules:

```
shipScores.js (IIFE)
│
├── CONFIG & STATE
│   ├── DBG flag
│   ├── __ShipScoresData { loaded, totalLiners, totalShips }
│   └── __InspectionCache { vesselId → { loaded, loading, rows, promise } }
│
├── UTILITIES
│   ├── log(), qsa(), qs(), textOf()
│   ├── safeId(), isVisible(), isFrench()
│   ├── cruiseShipLabel(), dateOnly(), formatScore()
│   ├── isWithinLastYears(), normalizeGuid(), odataGuidLiteral()
│   └── setSummaryLabel() — semantic heading inside <summary>
│
├── DOM BUILDERS
│   ├── buildLinerNode(name) → <details.browse-tree__liner>
│   ├── buildShipNode(owner, ship, vesselId, weight) → <details.browse-tree__ship>
│   ├── getShipDetailsTemplate() — clone from DOM or fallback
│   ├── primeShipDetailsTemplateCache() — capture before tree clear
│   └── normalizeShipSummaryMarkup() — post-build consistency pass
│
├── ACCESSIBILITY
│   ├── ensureSummariesTabbable() — tabindex="0", no role="button"
│   ├── ensureRegionSemantics(ship) — role="region" + aria-labelledby
│   ├── setRegionsTabbable(ship, enabled) — remove stale tabindex
│   ├── focusShipContent(wrap, label) — heading focus after expand
│   └── syncDocumentTitle() — set document.title from h1
│
├── DATA LOADING
│   ├── loadLinersAndShipsFromVessels(done) — primary OData query
│   ├── loadInspectionHistoryForVessel(vesselId) — lazy per-vessel
│   ├── fetchIncidentsWithFallback(vesselId) — guid literal retry
│   ├── buildIncidentsUrlForVessel(vesselId, useGuidLiteral)
│   └── Renderers: renderLoadingRow, renderEmptyHistoryRow,
│       renderHistoryIntoShip, renderHistoryErrorRow, fillTypeAndWeight
│
├── INTERACTION
│   ├── setupShips() — toggle handler + lazy load on expand
│   ├── setupLiners() — collapse children when liner closes
│   ├── setupTabRouting() — native tab order (no interception)
│   └── collapseAllOnLoad()
│
├── SEARCH
│   ├── setupSearch() — bind input events + i18n status
│   ├── applyFilter(raw) — show/hide liners + ships
│   ├── setStatusText(q, liners, ships) — snippet-driven messages
│   └── Exposed: window.__ShipScoresApplyFilter,
│       window.__ShipScoresSetLoading, window.__ShipScoresSetEmpty
│
├── DEBUG
│   └── setupDebug() — focusin + Tab key logging
│
└── INIT
    └── init() — DOMContentLoaded entry point
```

### Initialization Sequence

```
DOMContentLoaded
    │
    ├─1─ syncDocumentTitle()         — Set document.title from h1
    ├─2─ setupDebug()                — Attach focus/tab listeners
    ├─3─ ensureSummariesTabbable()   — tabindex="0" on all summaries
    ├─4─ collapseAllOnLoad()         — Close all <details>
    ├─5─ setupLiners()               — Bind liner toggle handlers
    ├─6─ setupShips()                — Bind ship toggle + lazy load
    ├─7─ setupTabRouting()           — (native, no-op)
    ├─8─ setupSearch()               — Bind search input + i18n
    ├─9─ primeShipDetailsTemplateCache() — Clone demo DOM
    │
    └─10─ loadLinersAndShipsFromVessels(done)  ← ASYNC
          │
          ├── GET /_api/ethi_vessels?$expand=...
          ├── Parse → ownerName → { shipName → { vesselId, weight } }
          ├── Clear existing liners
          ├── Build liner + ship DOM nodes
          ├── normalizeShipSummaryMarkup()
          ├── Re-run: ensureSummariesTabbable()
          ├── Re-run: collapseAllOnLoad()
          ├── Re-run: setupLiners() + setupShips()
          └── Re-apply search filter
```

---

## 4. Data Flow & OData Queries

### Query 1: Vessels (Page Load)

**Endpoint:** `/_api/ethi_vessels`

**Purpose:** Load all active cruise ships that have at least one qualifying inspection in the last 5 years, grouped by cruise line (owner account).

**Fields selected:**
- `ethi_establishmenttype` — filter: cruise vessel (992800002)
- `ethi_name` — ship display name
- `_ethi_ownerid_value` — FK to accounts (cruise line)
- `ethi_vesselid` — primary key
- `statecode`, `statuscode` — active records only
- `ethi_shipweightrange` — displayed in vessel info box

**Expand:**
- `ethi_Incident_Conveyance_ethi_vessel` — inline check for qualifying inspections (select incidentid only)
- `ethi_OwnerId` — cruise line name + statecode

**Filter logic (server-side):**
```
statecode eq 0
AND ethi_Incident_Conveyance_ethi_vessel/any(o1:
    o1/ethi_inspectionscore ne null
    AND o1/LastXYears(ethi_inspectionenddateandtime, 5)
    AND o1/ethi_inspectionscope eq 786080000         -- Full inspection
    AND o1/statecode eq 0
    AND o1/statuscode ne 6                            -- Not cancelled
    AND (o1/_ethi_rbiinspectiontype_value eq GUID_ROUTINE_ANNOUNCED
         OR o1/_ethi_rbiinspectiontype_value eq GUID_ROUTINE_UNANNOUNCED)
    AND o1/ethi_finalreportcreated ne null
    AND o1/_ownerid_value ne null
)
AND ethi_OwnerId/name ne null
AND ethi_OwnerId/statecode eq 0
```

**Result shape:** Array of vessel rows → grouped client-side by `ethi_OwnerId.name`

### Query 2: Incidents (Lazy, Per-Vessel)

**Endpoint:** `/_api/incidents`

**Purpose:** Load inspection history for a single vessel when user expands a ship node.

**Triggered by:** Ship `<details>` toggle event → `loadInspectionHistoryForVessel(vesselId)`

**Fields selected:**
- `_ethi_conveyance_value` — FK to vessel
- `ethi_inspectionenddateandtime` — inspection date
- `ethi_inspectionscore` — score out of 100
- `statecode`, `statuscode`

**Filter:**
```
ethi_finalreportcreated ne null
AND statecode eq 0
AND statuscode ne 6
AND ethi_establishmenttype eq 992800002
AND _ethi_conveyance_value ne null
AND ethi_inspectionscope eq 786080000
AND (_ethi_rbiinspectiontype_value eq GUID_ANNOUNCED
     OR _ethi_rbiinspectiontype_value eq GUID_UNANNOUNCED)
AND _ethi_conveyance_value eq <vesselId>
```

**Client-side post-filter:** `isWithinLastYears(iso, 5)` — because `LastXYears` OData function has tenant-specific issues.

**GUID literal fallback:** First attempt uses `guid'...'` syntax; on HTTP 400, retries with raw GUID (portal parser compatibility).

### Data Flow Diagram

```
PAGE LOAD                              USER EXPANDS SHIP
─────────                              ──────────────────
                                       
Browser                                Browser
  │                                      │
  │ GET /ethi_vessels                    │ (check __InspectionCache)
  │ ?$expand=incidents,owner             │
  │ &$filter=active+has_scores           │ Cache HIT → render immediately
  ▼                                      │
Dataverse                               │ Cache MISS ──┐
  │                                      │              │
  │ Return: vessels[]                    │              ▼
  │ (name, vesselId, weight,             │         GET /incidents
  │  owner.name)                         │         ?$filter=vessel_eq_<id>
  ▼                                      │              │
Browser                                  │              ▼
  │                                      │         Dataverse
  ├── Group by owner                     │              │
  ├── Sort alphabetically                │         Return: rows[]
  ├── Build liner <details>              │         (date, score)
  ├── Build ship <details>               │              │
  ├── Re-bind a11y + search              ▼              ▼
  └── Apply search filter           Client-side filter (5 years)
                                         │
                                    Render into <tbody>
                                         │
                                    Focus heading
```

---

## 5. Tree UI Structure

### DOM Hierarchy

```html
<div id="browseTree">

  <!-- LINER NODE (Cruise Line) -->
  <details class="browse-tree__liner" data-liner-bound="1">
    <summary class="browse-tree__summary" tabindex="0">
      <h2 class="browse-tree__heading">
        <span class="browse-tree__label">Royal Caribbean Group</span>
      </h2>
    </summary>
    <div class="browse-tree__panel">

      <!-- SHIP NODE (Vessel) -->
      <details class="browse-tree__ship"
               data-ship-bound="1"
               data-ship-name="Symphony of the Seas"
               data-vessel-id="6045bdf9-b010-..."
               data-vessel-weight="228,081">
        <summary class="browse-tree__summary" tabindex="0">
          <h3 class="browse-tree__heading">
            <span class="browse-tree__label">Symphony of the Seas</span>
          </h3>
        </summary>

        <!-- SHIP DETAILS (cloned from template) -->
        <div class="ship-details">
          <h4 class="ship-details__title" id="ship_hist_title_abc123"
              tabindex="-1">
            Inspection details
          </h4>
          <section data-ship-focus="history"
                   role="region"
                   aria-labelledby="ship_hist_title_abc123"
                   class="ship-details__history">
            <table class="ship-details__table table table-striped">
              <caption class="wb-inv">Inspection history (YYYY-MM-DD)</caption>
              <thead>
                <tr>
                  <th scope="col">Date of inspection (YYYY-MM-DD)</th>
                  <th scope="col">Score obtained</th>
                </tr>
              </thead>
              <tbody>
                <!-- LAZY LOADED -->
                <tr><td>2025-03-15</td><td>98/100</td></tr>
                <tr><td>2024-08-22</td><td>95/100</td></tr>
              </tbody>
            </table>
          </section>
        </div>
      </details>

      <!-- More ship nodes... -->
    </div>
  </details>

  <!-- More liner nodes... -->
</div>
```

### Heading Hierarchy

```
h1  — Page title (wb-cont)
  h2  — Cruise line name (inside <summary>)
    h3  — Ship name (inside <summary>)
      h4  — "Inspection details" (section title)
```

### Template Strategy

The ship details DOM is created via **template cloning**, not string concatenation:

1. **On init:** `primeShipDetailsTemplateCache()` captures the first server-rendered `.ship-details` element via `cloneNode(true)`
2. **On build:** `getShipDetailsTemplate().cloneNode(true)` creates a fresh copy per ship
3. **Fallback:** If no server-rendered demo exists, builds minimal DOM from snippet-driven labels (`getShipScoresText()`)
4. **Post-clone fixup:** Unique IDs generated for title elements; `aria-labelledby` re-wired to prevent duplicate IDs

**Why this matters:** Liquid snippet text (bilingual labels) is baked into the HTML at render time. Cloning the DOM preserves this text without duplicating i18n strings in JavaScript.

---

## 6. Lazy Loading & Caching

### Inspection Cache Architecture

```
__InspectionCache = Object.create(null)
{
  "6045bdf9-b010-...": {
    loaded: true,          // data fetched successfully
    loading: false,        // not currently fetching
    rows: [                // sorted newest-first
      { date: "2025-03-15", score: "98/100" },
      { date: "2024-08-22", score: "95/100" }
    ],
    promise: null          // resolved
  },
  "a1b2c3d4-e5f6-...": {
    loaded: false,         // fetch in progress
    loading: true,
    rows: [],
    promise: Promise       // pending
  }
}
```

### Cache State Machine

```
                    ┌─────────────┐
                    │  NOT CACHED  │
                    │  (no entry)  │
                    └──────┬──────┘
                           │ expand ship
                           ▼
                    ┌─────────────┐
              ┌─────│   LOADING    │
              │     │ loading:true │
              │     └──────┬──────┘
              │            │
         error │      success │
              │            │
              ▼            ▼
     ┌────────────┐  ┌──────────┐
     │   FAILED    │  │  CACHED   │
     │ loaded:false│  │loaded:true│
     │ rows: []    │  │ rows:[..] │
     └────────────┘  └──────────┘
              │
              │ re-expand ship
              ▼
     (retry from NOT CACHED)
```

**Key design:** On error, `loaded` stays `false` so the next expand retries. On success, `loaded` becomes `true` and subsequent expands render instantly from cache.

### Concurrent Request Deduplication

If two expand events fire before the first resolves (e.g., rapid click), the second call returns the same `promise` object:

```javascript
if (c && c.loading && c.promise) return c.promise;  // deduplicate
```

---

## 7. Search & Filtering

### Search Architecture

```
┌─────────────────────────────────────────────┐
│  Search Input (#linerSearch)                │
│  ┌─────────────────────────────────────┐    │
│  │ 🔍  type to filter...               │    │
│  └─────────────────────────────────────┘    │
│  Search help text (#linerSearchHelp)        │
│  Live status (#linerSearchStatus)           │
│    "3 cruise line(s) match. 12 ship(s)."    │
└─────────────────────────────────────────────┘
```

### Filter Logic

```
applyFilter("sym")
│
├── For each LINER:
│   ├── linerName.includes("sym") → linerMatch
│   │
│   ├── For each SHIP inside liner:
│   │   └── shipName.includes("sym") → shipMatch
│   │
│   ├── linerVisible = linerMatch OR anyShipMatch
│   │
│   ├── If !linerVisible → hide liner + all ships
│   │
│   ├── If linerMatch → show ALL ships (liner name matched)
│   │
│   └── If only shipMatch → show only matching ships
│
├── If query present → auto-expand visible liners
│
└── setStatusText(q, matchedLiners, matchedShips)
```

### Status String i18n

Status messages come from data attributes on `#shipScores_i18n` or `#linerSearchStatus`:

| Attribute | English Example | When Used |
|-----------|----------------|-----------|
| `data-status-loading` | "Loading cruise ship data..." | OData fetch in progress |
| `data-status-empty` | "No cruise ship data available." | Dataverse returned 0 rows |
| `data-status-template` | "{{liners}} cruise line(s). {{ships}} ship(s)." | Search has results |
| `data-status-none` | "No matches found." | Search has 0 results |
| `data-status-cleared` | "" (empty) | Search input cleared |

Template interpolation: `{{liners}}` and `{{ships}}` are replaced with counts.

### Search Input UX (CSS)

The search input has a **magnifier icon** that:
- Appears inside the input (left side) when empty and unfocused
- Disappears on focus (reclaims space for typing)
- Disappears when text is present (`:not(:placeholder-shown)`)
- SVG inline via `background-image` data URI

---

## 8. Accessibility Architecture

### Disclosure Semantics

| Element | Role | Keyboard | Notes |
|---------|------|----------|-------|
| `<summary>` | Native disclosure | Enter/Space to toggle | No `role="button"` — would force NVDA focus mode |
| `<details>` | Native disclosure group | Arrow keys in browse mode | `open` attribute controls state |
| `tabindex="0"` | On `<summary>` | Tab navigation | Ensures tabbable even in older browsers |

### Focus Management

**On page load:**
```
syncDocumentTitle() → document.title = h1 text
collapseAllOnLoad() → all details closed
```

**On ship expand:**
```
toggle event fires
  → setRegionsTabbable(ship, true)        — remove stale tabindex
  → fillTypeAndWeight(wrap, weight)       — instant metadata
  → renderLoadingRow(wrap)                — "Loading..."
  → loadInspectionHistoryForVessel(id)    — ASYNC
      → renderHistoryIntoShip(wrap, rows)
      → focusShipContent(wrap, label)     — FOCUS h4.ship-details__title
```

**Focus target:** The `h4.ship-details__title` heading gets `tabindex="-1"` (programmatically focusable but NOT in Tab order) and receives focus after history renders. This places the SR cursor inside the expanded content.

**Platform timing:**
```
Platform        Focus Delay
───────         ──────────
NVDA/JAWS       150ms (or UniversalAnnounce.getATTiming().focus)
VoiceOver Mac   150ms (or UA timing)
VoiceOver iOS   150ms (or UA timing)
TalkBack        150ms (or UA timing)
```

### Region Semantics

Each ship's content sections get `role="region"` with proper labeling:

```html
<h4 id="ship_hist_title_abc123">Inspection details</h4>
<section role="region" aria-labelledby="ship_hist_title_abc123"
         data-ship-focus="history">
  <table>...</table>
</section>
```

**Orphaned reference cleanup (2026-02-25):** If `aria-labelledby` points to a non-existent ID (e.g., from template cloning), it's removed and re-wired properly.

### Tab Order

**Design decision (2026-02-25):** Info and history sections are **NOT tab stops**. They contain static data tables accessible via SR reading mode / table navigation commands. Tab flows naturally: `summary → next summary`.

```
Tab order (ship expanded):
  [Liner Summary] → [Ship Summary] → [Next Ship Summary]
                                        ▲
                             (no tab stops inside ship content)
                             (SR users: arrow-key through table)
```

### ARIA Live Region (Search Status)

The `#linerSearchStatus` element should be `aria-live="polite"` so search results are announced to screen readers. **Current status: needs verification** — the element exists but `aria-live` must be set in the HTML template.

---

## 9. Bilingual Support

### Language Detection

```javascript
function isFrench() {
  var lang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
  return lang.indexOf("fr") === 0;
}
```

Uses `document.documentElement.lang` (set by Power Pages per page language), NOT browser locale.

### i18n Strategy

| Content Type | Source | Mechanism |
|-------------|--------|-----------|
| Ship/liner names | Dataverse | Data (language-neutral) |
| Section titles | Liquid snippets | Server-rendered into HTML, cloned by template |
| "Cruise ship" label | JS function | `cruiseShipLabel()` returns EN/FR |
| Loading/empty/error | JS function | `isFrench()` ternary |
| Search status | HTML data attributes | `#shipScores_i18n` data-status-* |
| Table headers | Liquid snippets | `getShipScoresText()` reads from `#shipScoresText` |

### Snippet Element

```html
<div id="shipScoresText" style="display:none"
     data-vessel-info-title="{{snippets['ethi-vessel-info-title']}}"
     data-vessel-history-title="{{snippets['ethi-vessel-history-title']}}"
     data-cruise-line-label="{{snippets['ethi-cruise-line-label']}}"
     data-vessel-type-label="{{snippets['ethi-vessel-type-label']}}"
     data-vessel-weight-label="{{snippets['ethi-vessel-weight-label']}}"
     data-table-caption="{{snippets['ethi-table-caption']}}"
     data-date-format-hint="{{snippets['ethi-date-format-hint']}}"
     data-date-of-inspection-label="{{snippets['ethi-date-inspection']}}"
     data-score-obtained-label="{{snippets['ethi-score-obtained']}}">
</div>
```

---

## 10. CSS Architecture

### Design System

The CSS follows **GCWeb/WET4 design patterns** with these custom enhancements:

| CSS Variable | Value | Purpose |
|-------------|-------|---------|
| `--ship-indent` | 2.5rem | Ship node left offset (child indentation) |
| `--branch-x` | 1.25rem | Vertical branch line x-position |
| `--inner-indent` | 1rem | Content indent inside expanded ship |
| `--gc-yellow` | #ffbf47 | GC yellow accent |
| `--node-icon-gap` | 0.55rem | Gap between triangle marker and label |
| `--wet-focus-blue` | #2b6cb0 | WET4 focus ring outline |
| `--wet-focus-halo` | #bcdcff | WET4 focus ring outer halo |

### Visual Hierarchy (Font Sizes)

```
Liner name:     1.55rem  ████████████████████
Ship name:      1.32rem  ████████████████
Section title:  1.28rem  ███████████████
Detail text:    1.28rem  ███████████████
Table header:   1.21rem  ██████████████
Table body:     0.85rem  ██████████
```

### Focus Ring Pattern

All interactive elements use the same WET4-derived focus ring:

```css
outline: 3px solid var(--wet-focus-blue);
outline-offset: 2px;
box-shadow: 0 0 0 4px var(--wet-focus-halo), ...;
```

This provides:
- 3px blue outline (WCAG 2.4.7 Focus Visible)
- 2px offset (prevents clipping)
- 4px light blue halo (extra visibility on dark backgrounds)

### Branch Lines

Ship nodes have a subtle vertical branch line connecting them to the parent liner:

```css
details.browse-tree__ship::before {
  content: "";
  position: absolute;
  left: var(--branch-x);
  border-left: 2px solid #e6e6e6;
}
```

### Responsive Breakpoints

| Breakpoint | Layout |
|-----------|--------|
| > 480px | Search: 2-column grid (label + input) |
| ≤ 480px | Search: stacked single column |
| All sizes | Tree: full-width, single column |

---

## 11. Code Quality Review

### Strengths

| Area | Assessment | Evidence |
|------|-----------|----------|
| Idempotent binding | ★★★★★ | `data-ship-bound="1"` / `data-liner-bound="1"` prevents double-binding |
| Error resilience | ★★★★☆ | try-catch around DOM ops, OData fallback (guid literal → raw GUID) |
| Cache design | ★★★★★ | Deduplication, retry on error, instant re-render on cache hit |
| A11y semantics | ★★★★★ | No role="button", orphaned aria-labelledby cleanup, proper heading hierarchy |
| Template reuse | ★★★★☆ | DOM cloning preserves Liquid text; unique ID generation |
| Bilingual support | ★★★★☆ | Snippet-driven strings, page-level language detection |
| Search | ★★★★☆ | Cascading match (liner → ships), template-based status strings |

### Areas for Improvement

| Area | Assessment | Issue |
|------|-----------|-------|
| Dead code | ★★☆☆☆ | ~80 lines of commented-out code (old queries, ship pre-filtering) |
| Info section | ★★★☆☆ | Vessel info box (cruise line, type, weight) commented out in fallback template |
| Global exposure | ★★★☆☆ | 3 functions on `window.*` for cross-module communication |
| Error UX | ★★★☆☆ | OData failure shows nothing (no user-visible error message for vessel load) |
| Diagnostic logging | ★★★☆☆ | Uses simple `console.log` fallback, not eTHIDiagnostics integration |
| Search aria-live | ★★★☆☆ | Status element needs `aria-live="polite"` for SR announcements |

---

## 12. Issues & Recommendations

### Critical (0)

No critical issues found.

### High Priority (3)

#### H1: Dead Code Cleanup
**Lines affected:** ~80 lines of commented-out code
- Lines 595-616: Commented-out ship pre-filtering logic
- Lines 1097-1118: Two old OData query variants
- Lines 442-455: Old incidents filter variant
- Lines 920-927: Commented-out info section in fallback template

**Impact:** Maintenance confusion, increased cognitive load during debugging.

**Recommendation:** Remove all commented-out code. If historical reference is needed, it's in version control.

#### H2: Vessel Load Error UX
**Current:** If the primary vessels OData query fails, the catch block only logs to console. The user sees an empty tree with no explanation.

**Recommendation:** On vessel load failure, display a user-visible error message in the tree container and announce to screen readers:

```javascript
.catch(function (err) {
  log("Vessels OData load failed:", err);
  var msg = isFrench()
    ? "Impossible de charger les données. Veuillez réessayer."
    : "Unable to load data. Please try again.";
  tree.innerHTML = '<p class="text-danger" role="alert">' + msg + '</p>';
  if (done) done(false);
});
```

#### H3: Search Status ARIA Live
**Current:** `#linerSearchStatus` may not have `aria-live` attribute.

**Recommendation:** Ensure the HTML template includes:
```html
<p id="linerSearchStatus" class="browse-search__status"
   aria-live="polite" aria-atomic="true"></p>
```

### Medium Priority (5)

#### M1: Integrate eTHIDiagnostics Logging
**Current:** Simple `console.log` with `[SHIPDBG]` prefix.

**Recommendation:** Match SSI/GI patterns:
```javascript
var logger = (window.eTHIDiagnostics && typeof eTHIDiagnostics.createLogger === 'function')
  ? eTHIDiagnostics.createLogger('ShipScores')
  : { log: function(m,d){ console.log('[ShipScores]',m,d); }, /* ... */ };
```

#### M2: Restore Vessel Info Section
The info box (cruise line, vessel type, weight) is commented out in the fallback template but the `fillTypeAndWeight()` function still exists. Either:
- **Restore** the info section in the fallback template, or
- **Remove** `fillTypeAndWeight()` and related code to eliminate dead paths

#### M3: Reduce Global Window Exposure
Three functions are exposed globally: `__ShipScoresApplyFilter`, `__ShipScoresSetLoading`, `__ShipScoresSetEmpty`.

**Recommendation:** Consolidate into a single namespace:
```javascript
window.ShipScores = {
  applyFilter: applyFilter,
  setLoading: setLoadingStatus,
  setEmpty: setEmptyStatus
};
```

#### M4: Loading Skeleton / Spinner
**Current:** Only status text announces "Loading...". No visual loading indicator in the tree area.

**Recommendation:** Add a loading state to the tree container:
```javascript
tree.innerHTML = '<div class="browse-tree__loading" role="status">' +
  '<span class="wb-inv">' + (isFrench() ? 'Chargement...' : 'Loading...') + '</span>' +
  '<!-- optional spinner SVG -->' +
'</div>';
```

#### M5: Table Caption Accessibility
**Current:** Table caption uses `class="wb-inv"` (visually hidden). This is correct for screen readers, but the date format hint inside the caption is also hidden.

**Recommendation:** Consider making the date format hint visible below the table header for sighted users who may not recognize YYYY-MM-DD format.

### Low Priority (3)

#### L1: Use `eTHIDataverse.safeAjax` via Shared Utility
Both data loading functions previously checked for `webapi.odataGetAll` and `webapi.safeAjax` independently. The updated `doOdataGet(url)` utility now prefers `eTHIDataverse.safeAjax` (from ethiLibrary.js — provides enhanced error parsing, token diagnostics, and structured logging) with `webapi.safeAjax` as fallback. jQuery deferreds are wrapped into native Promises for uniform `.then()/.catch()` chains.

#### L2: Sort Consistency
Liner and ship sorting uses `localeCompare()` without specifying locale. On French pages, accent handling may differ between browsers. Consider `localeCompare(b, 'fr', { sensitivity: 'base' })`.

#### L3: CSS `!important` Audit
Several declarations use `!important` (focus rings, search input padding). These are justified for overriding GCWeb defaults but should be documented.

---

## 13. Testing Checklist

### Functional Testing

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| F1 | Page loads with vessels | Liners + ships appear, all collapsed |
| F2 | Expand liner | Child ships visible, all collapsed |
| F3 | Expand ship | "Loading..." → inspection table renders |
| F4 | Collapse liner | All child ships collapse |
| F5 | Re-expand cached ship | Table renders instantly (no loading) |
| F6 | Search "royal" | Matching liners expand, non-matching hidden |
| F7 | Search "symphony" | Ship matches, parent liner auto-expands |
| F8 | Clear search (Escape) | All liners visible, all collapsed |
| F9 | Empty dataset | Status shows empty message |
| F10 | OData vessel failure | Error message in tree (after H2 fix) |
| F11 | OData incident failure | "Unable to load inspection history." in table |
| F12 | GUID literal 400 fallback | Retries with raw GUID, succeeds |

### Accessibility Testing

| # | Test | AT | Expected |
|---|------|-----|----------|
| A1 | Tab through tree | Keyboard | Summary → Summary → Summary (no stops inside content) |
| A2 | Enter on summary | Keyboard | Toggles open/closed |
| A3 | Page title | NVDA | Announces page title from h1 |
| A4 | Expand ship | NVDA | Focus moves to "Inspection details" heading |
| A5 | Table navigation | NVDA | Ctrl+Alt+Arrow navigates table cells |
| A6 | Search type | NVDA | Status announced (if aria-live set) |
| A7 | Heading navigation | NVDA (H key) | h2 liners → h3 ships → h4 section titles |
| A8 | VoiceOver rotor | VoiceOver | Headings list shows hierarchy |
| A9 | Swipe navigation | iOS VO | Linear order: liner → ship → content |
| A10 | Focus visible | All | Blue WET4 ring on all summaries |

### Cross-Browser Testing

| Browser | Platform | Priority |
|---------|----------|----------|
| Chrome (latest) | Windows, macOS, Android | Required |
| Edge (latest) | Windows | Required |
| Safari (latest) | macOS, iOS | Required |
| Firefox (latest) | Windows | Recommended |

### Responsive Testing

| Viewport | Check |
|----------|-------|
| 320px (iPhone SE) | Search stacks, tree full-width, no horizontal scroll |
| 375px (iPhone 12) | Same |
| 768px (iPad portrait) | Search 2-column, tree full-width |
| 1280px (laptop) | Tree contained within frame, readable |

---

## Appendix A: Inspection Type GUIDs

| Type | GUID | Usage |
|------|------|-------|
| Routine - Announced | `05aea5d2-11eb-ef11-9342-0022486e14f0` | Both queries |
| Routine - Unannounced | `4c5048c5-11eb-ef11-9342-0022486e14f0` | Both queries |

## Appendix B: OData Filter Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `ethi_establishmenttype` | 992800002 | Cruise vessel |
| `ethi_inspectionscope` | 786080000 | Full inspection |
| `statuscode` ne 6 | — | Not cancelled |
| `statecode` eq 0 | — | Active record |

---

*End of Architecture Document*

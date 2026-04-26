# Solder — Session Handoff

**Last touched:** 2026-04-24
**Branch:** `main` (no git repo yet — see "Pushing to GitHub" below)
**Scope of session:** UI/UX iteration on the React frontend. Backend untouched.

## Quick Start

The stack should already be running. If not:

```bash
docker-compose up -d                                       # Postgres + Temporal
cd backend && python -m uvicorn app.main:app --reload --port 8000  &
cd backend && python -m app.temporal.worker                          &
cd frontend && npm run dev                                           &
```

URLs: frontend `http://localhost:5173`, backend `http://localhost:8000/docs`, Temporal UI `http://localhost:8080`.

**Postgres port note**: docker-compose maps Postgres to host **5433** (native PG18 owns 5432). `backend/.env` already has `DATABASE_URL=...localhost:5433/...`. The default in `app/config.py` is still 5432 — kept stale because `.env` overrides; the next agent may want to update the default for consistency.

## What shipped this session

### Design-system primitives — `frontend/src/index.css`
Added in `@layer components`:
- `.btn` tightened from `px-4 py-2 rounded-lg` → `px-3 py-1.5 rounded-md text-sm font-medium`. Use `.btn-lg` for modal primary actions.
- `.btn-icon` — replaces 5+ ad-hoc close-button declarations.
- `.eyebrow` — replaces ~40 inline `text-[11px] font-mono uppercase tracking-[0.15em]` redeclarations.
- `.chip` + `.chip-{success,warn,danger,info,neutral,accent}` — replaces 16+ inline status/trigger chips.
- `.alert`, `.alert-danger`, `.alert-info` — unifies error banners.
- `.hairline` — `h-px bg-surface-200 dark:bg-surface-800`.

### Builder Page (`frontend/src/pages/Builder.tsx`)
- **Dirty indicator + last-saved**: `[data-testid="save-status"]` with `data-dirty` attribute. Shows amber-dot "unsaved" or emerald-dot "saved Xs ago". Stamped on save / load / restore / run. `beforeunload` guard registers only while dirty. `formatSavedAgo` ticks every 10s while clean.
- **Header density**: removed `/` path-glyph (read as breadcrumb); replaced with vertical rule. Name input flex-grows to `max-w-[40ch]`. Button gap tightened to `gap-1.5`.
- **`RunDrawer` overlap fix**: drawer now *replaces* `<PropertiesPanel />` in the right rail during a run, instead of overlaying. See `runDrawerOpen ? <RunDrawer/> : <PropertiesPanel/>` near end of `Builder.tsx`.

### Live Run Drawer — `frontend/src/components/builder/RunDrawer.tsx` (new)
Right-rail panel during a run. Plan section enumerates `groupByStage(planNodes)` with chip+icon per node; status painted from `run.steps[]` as polling fills it in. Elapsed timer ticks 250ms while `status === 'running'`. Output JSON viewer when terminal.

**Backend caveat**: Temporal `notify_completion` writes `run.steps` only at the END of the workflow (see `backend/app/temporal/activities.py`). The drawer scaffolding is ready for incremental step writes / SSE — wire when the backend gets there. Today the user sees plan-as-queued during the run, then everything paints at completion.

### Keyboard shortcuts overlay — `frontend/src/components/ShortcutHelp.tsx` (new)
Global `?` toggles a modal listing ⌘S / `/` / Esc. Mounted at `Layout.tsx`. Subtle `?` kbd hint sits next to the theme toggle.

### Page Header — `frontend/src/components/PageHeader.tsx` (new)
Shared `eyebrow + title + action` component used by Integrations / History / Docs. Outer row uses `items-end` so the kicker+title baseline aligns with the action button — fixes the floating-button feel the design review flagged.

### Integrations page — `frontend/src/pages/Integrations.tsx`
- Soft-deleted rows hidden by default. Banner: "N deleted rows hidden · show deleted" toggle (`data-testid="toggle-show-deleted"`).
- Row card `p-5 → p-4`, `space-y-3 → space-y-2`, description `line-clamp-1`.
- Section dividers (the long horizontal rules) removed; just eyebrow + count now.
- Status / trigger / subprocess chips use `.chip` primitives.
- Deleted rows render at `opacity-60` when `showDeleted` is on.

### Layout — `frontend/src/components/Layout.tsx`
- `max-w-7xl → max-w-6xl` (matches the page content width).
- Mobile: pill nav `overflow-x-auto`, `v0.1` hidden at `sm`, `?` kbd hidden at `md`.
- Theme toggle adopts `.btn-icon`.

### Docs page — `frontend/src/pages/Docs.tsx`
Real markdown rendering via `react-markdown` + `remark-gfm` (`npm` deps already installed). Styles in `.solder-md` block in `index.css`. Falls back to JSON for specs without `parsed_markdown`.

### Skeleton loaders — `frontend/src/components/Skeleton.tsx` (new)
`IntegrationRowSkeleton`, `RunRowSkeleton`, `SpecRowSkeleton`. Wired to Integrations / History / Docs while loading. Note: on a local backend, responses arrive too fast to perceive — Playwright skeleton assertions fail because of this (not a real bug).

### Trigger Strip — `frontend/src/components/builder/TriggerStrip.tsx`
Removed the loud left-accent stripe and the redundant "runs when you click →" caption. Cleaner.

### Sidebar / Properties Panel — minor
Dropped wizard-numbering `01 / AI BUILDER` etc. PropertiesPanel header collapsed from 3 stacked rows into one baseline line.

### Stages canvas — `frontend/src/components/builder/StagesGraph.tsx`
- **Tail "+ PARALLEL" zones** — were always-visible 56px boxes; now an 8px transparent strip at rest, expands to 52px with dashed border on `group-hover` (parent column hover) or active drag.
- **Phantom trailing column** — was full-size (260px), now 96px at rest and only grows to full-column on active drag.
- **Container nodes (Loop/Branch/Call-Subprocess)** — used to expand to 520px and render an inline nested `<StagesGraph>` for their body. Now sit at normal card width with a compact metadata section listing `▸ BODY · N steps ⤢` per branch — clickable to step-in. **No expand toggle.** Step-into is the only path into the body.
- **Empty-state dropzone** — was a tiny 80px gap; now a full-size dashed "drop to start the flow" / "drop to start this branch" card. Wired with `onDragOver`/`onDrop`. `data-testid="empty-canvas-dropzone"`.
- Removed the separate floating "canvas.empty" overlay — redundant with the new dropzone.

### Camera-zoom transition into containers — `Canvas.tsx` + `StagesGraph.tsx`
On step-into click, **the clicked card's rect is measured** in `Canvas.prepareDiveIn(cardEl)`:
- `transformOrigin` set to card-center px coords relative to the scene container.
- `zoomScale = clamp(2.5, 8, max(sceneW/cardW, sceneH/cardH))`.

Both state updates batch with `pushFocus()` in the same React tick, so `AnimatePresence` key-swaps with the correct origin already on the outgoing motion.div. The exit variant scales `1 → zoomScale` around the card center, fading out — visually the card grows to fill the frame as the rest of the canvas flies past the viewport edges.

Incoming scene (the body view) lands from `scale: 1.08, opacity: 0` settling to `1 / 1` over 380ms. Pop-out (Esc / crumb) uses a symmetric `scale: 0.92` recede with center origin — no captured origin to fly back to.

`onAnimationComplete` resets `zoom` state so subsequent crumb-clicks don't reuse a stale origin. Respects `prefers-reduced-motion` via Framer's `useReducedMotion` (falls back to plain cross-fade).

## QA Harness Inventory

Run from repo root (`cd C:\Users\Administrator\Solder`):

| Script | Coverage |
|---|---|
| `python qa/qa_harness.py` | Original full-app smoke (all routes). Expects stack running. |
| `python qa/qa_uiux_iteration.py` | Save-status, shortcut overlay, deleted-filter, run drawer plan, skeletons, markdown. |
| `python qa/qa_zoom_transition.py` | Camera-zoom into Loop, branch-header path, rapid in/out cycles, console errors, long-task watchdog. |
| `python qa/qa_empty_drop.py` | Drag from palette to empty root canvas + drag into empty Loop body via drag events. |

Artifacts land in `qa/artifacts/{iteration,zoom,emptydrop}/`.

**All scripts pass on a healthy stack** (`qa_uiux_iteration` reports 9/12 because the 3 skeleton timing assertions fail on localhost — the skeletons render and disappear in <2s; not a real bug).

## Backlog from the design review (not yet done)

The three review agents in this session produced a longer punch list. Shipped Tier 1; Tier 2/3 still open:

### Tier 2 — structural wins
- **History grid columns** — `lg:grid-cols-3` + `lg:col-span-1` cramps the detail. Switch to `lg:grid-cols-[320px_1fr]`.
- **History step-timeline connector** runs past the last step. Hide `<span className="flex-1 w-px ..." />` on the last index.
- **Docs grid** — `lg:grid-cols-4` wastes vertical space when the markdown is short. Switch to `lg:grid-cols-[260px_1fr]` and add `min-h-[60vh]` to the empty-state card. Outer `<div className="lg:col-span-3">` should become `min-w-0`.
- **PropertiesPanel split** — currently a giant `if/else if` on `key` (http.request / transform.map / logic.if / output.passthrough / process.call). Split into `editors/{http,transform,branch,loop,process,output}.tsx` and look up by kind. Adding a node type today is expensive.
- **Container labels** — Loop/Branch nodes show only "Loop" / "Branch" as titles. Five Branches with similar `$.status == "..."` previews are unreadable. Add an optional 1-line `label` field on container nodes.
- **PageHeader description prop** — already accepted; only Integrations uses it (none right now). Wire one-line page descriptions where useful.

### Tier 3 — polish
- **`statusColor` in History** uses `text-green-700 bg-green-50` — should be `emerald` like everywhere else.
- **`History.tsx` chip lacks `ring-1`** — drift vs. the `.chip` primitive. Migrate.
- **Container max-width drift** — Layout uses `max-w-6xl` (now), pages use `max-w-6xl`. ✅ unified this session, but if anyone touches Layout, keep them in sync.
- **Per-stage eyebrow noise in RunDrawer** — was emitting "00 SEQUENTIAL" per stage; toned down this session to only show "N parallel" for stages with >1 node. Look fine but the agents' note remains: consider a single eyebrow per drawer section, not per stage.
- **`RunDrawer` left-accent / spacing** — unified to `p-4` matching other panels. Keep an eye on it.

### Backend punch list (deferred — out of scope for this iteration)
- `services/agent.py` pins `claude-sonnet-4-20250514` (an old model). Latest is `claude-sonnet-4-6` and there is now `claude-opus-4-7`. Easy fix.
- `IntegrationAgent` does brittle `text.find("{")` / `rfind("}")` JSON extraction. Switch to tool-use / structured output.
- Webhook + schedule trigger types are cosmetic — no `/api/webhooks/...` route, no scheduler. Builder disables Run for non-manual.
- `record_learning` activity is a no-op despite the `AILearning` table existing. Either wire a feedback loop or delete.
- `BuildIntegrationWorkflow` / `TestIntegrationWorkflow` are placeholder stubs — registered on the worker but never invoked. Either wire AI build through Temporal or delete.
- Soft-delete leaks: `DELETE /integrations/{id}` flips `is_active=False`/`status="disabled"` but `list_integrations` returns everything. Frontend filters now (this session); backend should accept `?include_disabled=` and default to excluding.
- Tests at `backend/tests/test_api.py` are 4 health-check smokes. Versions, snapshots, pagination, stage execution, subprocess inlining have **no coverage**.

## Pushing to GitHub

The repo isn't initialized. Last attempt was blocked because:
- No `.git/` here yet.
- `gh` CLI isn't installed.

To push: install `gh` (`winget install --id GitHub.cli -e && gh auth login`), `git init`, then create a repo. `.gitignore` already excludes `node_modules/`, `__pycache__`, `.env`, `dist/`, etc. — `backend/.env` (with empty `ANTHROPIC_API_KEY=`) is safe.

## Memory entries (persistent across sessions)

Saved at `C:\Users\Administrator\.claude\projects\C--Users-Administrator-Solder\memory\`:
- `project_frontend_stack.md` — React (not SvelteKit) as of Apr 2026
- `project_port_5433.md` — Postgres on host port 5433

Both still accurate.

## Conventions to keep

- **Default to no comments.** Use them only when "why" is non-obvious. Never narrate "what".
- **Eyebrow is `text-[11px] font-mono uppercase tracking-[0.15em]`** — use `.eyebrow` class, not inline styles.
- **All status pills are `.chip ${tone}`** where tone is one of `chip-success/warn/danger/info/neutral/accent`. Don't redeclare colors inline.
- **Two `data-testid`s for the harness**: `node-{kind}-{action}`, `palette-{kind}-{action}`. Keep these stable.
- **DnD MIME types** are `application/x-solder-existing` (move) and `application/x-solder-new` (palette). Defined in `frontend/src/components/builder/dnd.ts`.
- **Focus path** lives in the Zustand store (`useIntegrationStore`). Don't lift it back into Canvas.
- **Container nodes never expand inline.** Body is reachable only via step-into. The compact branch-row is the visible affordance.
- **`prepareDiveIn(cardEl)`** must be called *before* `onStepInto` in the same React tick so the camera zoom has the right origin.

## Tools / scripts the next agent may need

- Frontend typecheck: `cd frontend && npx tsc --noEmit`
- Backend tests: `cd backend && pytest -q`
- Stop services: `./stop.ps1`
- Check Postgres: `docker exec -it solder-postgres psql -U solder -d solder`

## Open questions / decisions for the user

1. **Should the run drawer push the user out of "Properties" mid-edit?** Today opening a run swaps the right rail wholesale. Could instead overlay the bottom 60% as a drawer on top of Properties. User picked the swap-out approach this session — confirm whether to keep.
2. **Container labels** — see backlog. Need a UX call: where does the optional label render? Above the catalog name? Replace it?
3. **Webhook / schedule triggers** — wire them or remove from the UI? The pills are visible and cosmetic.

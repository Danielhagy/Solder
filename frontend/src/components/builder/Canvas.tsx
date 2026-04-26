import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  useIntegrationStore,
  type SolderNode,
  type FocusSegment
} from '@/stores/integration';
import { CATALOG, lookupCatalog } from '@/catalog';
import { DND_MIME_EXISTING, DND_MIME_NEW, type NewNodePayload } from './dnd';
import StagesGraph, { type DropTarget, type GraphOwner } from './StagesGraph';

/**
 * Custom payload passed to variant functions — combines direction (+1 step
 * in, -1 pop out) with the dynamic zoom factor measured from the clicked
 * card. zoomScale is only meaningful when direction = +1 and a card was
 * the trigger; absent = the fallback cross-fade (used when a crumb click
 * or sibling-branch jump caused the focus change).
 */
interface SceneCustom {
  dir: number;
  zoomScale: number | null;
}

/**
 * Framer Motion variants for the scene-level flight transition.
 *
 * Step-in (dir = +1) with zoomScale set: the outgoing scene scales up around
 * the clicked card (transform-origin set inline on the motion.div). That
 * visually "zooms the camera in" until the card fills the frame — the rest
 * of the canvas flies radially past the viewport edges. The incoming body
 * view then emerges at a small oversize (1.08) and settles to 1.0, reading
 * as "we landed inside and are pulling focus".
 *
 * Pop-out (dir = -1): symmetric but without a card origin (we don't know
 * which card the user is flying back to), so the camera pulls back with a
 * uniform center origin.
 *
 * Reduced-motion users get a plain cross-fade.
 */
const sceneVariants = {
  initial: (c: SceneCustom) => ({
    opacity: 0,
    scale: c.dir > 0 ? 1.08 : 0.92
  }),
  animate: {
    opacity: 1,
    scale: 1
  },
  exit: (c: SceneCustom) => ({
    opacity: 0,
    scale:
      c.dir > 0
        ? // Dive-in exit: scale to the measured zoom factor (covers the
          // viewport) or fall back to a subtle 1.06 when no card origin
          // was captured (e.g. jumping into a sibling branch via a crumb).
          c.zoomScale ?? 1.06
        : 0.92
  })
} as const;

const reducedSceneVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
} as const;

/**
 * Walk the focus path to resolve which node list should render. Returns the
 * scoped list plus a breadcrumb label per segment for the UI.
 */
function resolveScope(
  rootNodes: SolderNode[],
  path: FocusSegment[]
): { scopedNodes: SolderNode[]; trail: Array<{ label: string; branchLabel: string }> } {
  let cur = rootNodes;
  const trail: Array<{ label: string; branchLabel: string }> = [];
  for (const seg of path) {
    const parent = cur.find((n) => n.id === seg.parentId);
    if (!parent || !parent.branches) {
      // Path broken — return what we have so far (will render empty below).
      return { scopedNodes: [], trail };
    }
    const meta = lookupCatalog(parent.kind, parent.action);
    const branchEntry = meta.containerBranches?.find((b) => b.key === seg.branchKey);
    trail.push({
      label: meta.label,
      branchLabel: branchEntry?.label ?? seg.branchKey.toUpperCase()
    });
    cur = parent.branches[seg.branchKey] ?? [];
  }
  return { scopedNodes: cur, trail };
}

/**
 * Canvas is now a thin shell: it owns top-level state (hotZone, drag payload
 * wiring) and delegates stage/column/node rendering to `<StagesGraph>`.
 * Container nodes render their own nested `<StagesGraph>` recursively.
 */
export default function Canvas() {
  const nodes = useIntegrationStore((s) => s.nodes);
  const selectedNodeId = useIntegrationStore((s) => s.selectedNodeId);
  const selectNode = useIntegrationStore((s) => s.selectNode);
  const removeNode = useIntegrationStore((s) => s.removeNode);
  const moveNodeCrossScope = useIntegrationStore((s) => s.moveNodeCrossScope);
  const addNodeToStage = useIntegrationStore((s) => s.addNodeToStage);
  const addNodeToBranchStage = useIntegrationStore((s) => s.addNodeToBranchStage);

  const [hotZone, setHotZone] = useState<string | null>(null);
  // Focus path lives in the store so the Sidebar's handleAdd can route clicks
  // into the deepest focused branch (drag routing goes through the drop handler
  // which already carries the owner explicitly).
  const focusPath = useIntegrationStore((s) => s.focusPath);
  const setFocusPath = useIntegrationStore((s) => s.setFocusPath);
  const popFocus = useIntegrationStore((s) => s.popFocus);
  const pushFocus = useIntegrationStore((s) => s.pushFocus);

  // Track direction of focus change so the scene transition can animate
  // correctly. Entering deeper (direction = +1): new scene lands from "behind"
  // the viewport — the old content accelerates past the camera. Popping
  // (direction = -1): reverse. The ref is compared against current depth on
  // each render and updated in a post-commit effect so the variant function
  // sees the right sign when AnimatePresence swaps.
  const prevDepthRef = useRef(focusPath.length);
  const direction = focusPath.length >= prevDepthRef.current ? 1 : -1;
  useEffect(() => {
    prevDepthRef.current = focusPath.length;
  }, [focusPath.length]);
  const reduceMotion = useReducedMotion();

  // Camera-zoom state. When the user clicks step-into on a container, we
  // measure the card's rect relative to the scene, store (a) the origin for
  // transform-origin so the zoom pivots around the card's center, and (b)
  // the scale factor needed for the card to fill the scene viewport. Set to
  // null when no zoom is in flight; the motion.div falls back to a generic
  // center origin and 1.04 scale (used for non-dive focus changes like
  // clicking a crumb).
  const sceneContainerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ origin: string; scale: number } | null>(null);

  // Scrolling-canvas refs/state.
  //
  // The canvas surface scrolls horizontally as the user navigates through a
  // wide integration (many stages). We re-map mouse-wheel deltaY → scrollLeft
  // so a vertical wheel gesture pans the integration left/right (the user's
  // explicit ask — most builder canvases use horizontal flow). The ember
  // strip overlay reads scrollLeft to translate itself in lockstep,
  // producing the "embers slide across the bottom" effect even though the
  // strip lives outside the scroller (so it stays visually pinned to the
  // canvas viewport instead of scrolling off as part of the scene).
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);

  // Wheel re-mapping. Native listener with passive:false so we can call
  // preventDefault and own the gesture. We only redirect when there's
  // horizontal room to scroll — otherwise we leave the default vertical
  // scroll alone so a stage column that overflows vertically is still
  // reachable via wheel.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    function onWheel(this: HTMLDivElement, e: WheelEvent) {
      if (e.deltaY === 0) return;
      if (this.scrollWidth <= this.clientWidth) return;
      e.preventDefault();
      this.scrollLeft += e.deltaY;
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Track scrollLeft + clientWidth so the ember overlay can translate +
  // tile correctly. Throttled to rAF — raw scroll events fire faster than
  // we can usefully render, and React state updates at scroll rate would
  // pile up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      setScrollLeft(el.scrollLeft);
      setViewportWidth(el.clientWidth);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(sync);
    };
    sync();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  /**
   * Called by a NodeCard immediately before it fires onStepInto. The same
   * render batch also pushes the focus, so by the time AnimatePresence
   * key-swaps, the outgoing motion.div already has the correct
   * transform-origin + target scale. Without this, the exit plays with
   * center origin and only a mild scale — the current "cross-fade" feel.
   */
  const prepareDiveIn = useCallback((cardEl: HTMLElement) => {
    const scene = sceneContainerRef.current;
    if (!scene) return;
    const cardRect = cardEl.getBoundingClientRect();
    const sceneRect = scene.getBoundingClientRect();
    // Origin: card center expressed in px relative to scene. CSS
    // transform-origin accepts px pairs.
    const ox = cardRect.left + cardRect.width / 2 - sceneRect.left;
    const oy = cardRect.top + cardRect.height / 2 - sceneRect.top;
    // Scale: how much the scene must grow for the card to fill the frame.
    // Use max of the two ratios so the card covers both axes. Capped so the
    // transform doesn't become absurd for very small cards in very large
    // viewports (would flatten the animation with a compositing fit).
    const scale = Math.min(
      8,
      Math.max(
        2.5,
        Math.max(sceneRect.width / cardRect.width, sceneRect.height / cardRect.height)
      )
    );
    setZoom({ origin: `${ox}px ${oy}px`, scale });
  }, []);

  // Reset the zoom record after the exit finishes so the next non-dive
  // focus change (e.g. clicking `main` in the crumb) doesn't reuse a stale
  // origin. We clear on the *incoming* scene's animate-complete because
  // that's strictly after the exit finishes in mode="wait".
  const handleAnimationComplete = useCallback(() => {
    setZoom(null);
  }, []);

  // Stable key for AnimatePresence — a change triggers the enter/exit pair.
  // Includes the full path so switching between sibling branches (e.g. Branch
  // TRUE → FALSE at the same depth) also animates.
  const sceneKey =
    focusPath.length === 0
      ? 'root'
      : focusPath.map((s) => `${s.parentId}.${s.branchKey}`).join('>');

  const { scopedNodes, trail } = useMemo(
    () => resolveScope(nodes, focusPath),
    [nodes, focusPath]
  );
  // If the focused container was deleted from underneath us, the trail is
  // shorter than focusPath — sync back to whatever is resolvable.
  useEffect(() => {
    if (trail.length < focusPath.length) setFocusPath(focusPath.slice(0, trail.length));
  }, [trail.length, focusPath, setFocusPath]);

  // Escape pops one level of focus (unless a text input or dialog has focus).
  useEffect(() => {
    if (focusPath.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      popFocus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusPath.length, popFocus]);

  const activeOwner: GraphOwner =
    focusPath.length > 0 ? focusPath[focusPath.length - 1] : null;

  function handleDragStart(e: ReactDragEvent, nodeId: string) {
    e.dataTransfer.setData(DND_MIME_EXISTING, nodeId);
    e.dataTransfer.effectAllowed = 'move';
  }

  /**
   * Compute the stage value that the store should see for a drop target.
   * For an "insert before/after" drop, we use a fractional offset (±0.5)
   * so the resulting list sorts strictly between the surrounding stages —
   * e.g. dropping AFTER stage 1 with stage 2 already present produces 1.5,
   * which `compact()` renumbers to 2 while bumping the old stage 2 to 3.
   *
   * The previous `targetStage * 10 ± 5` scheme only worked at the trailing
   * edge: a marker of 15 with stages [1, 2] present sorts AFTER 2, so the
   * "between" semantics collapsed back to "append". Visible to the user as
   * "drag onto inter-stage gap does nothing".
   */
  function stageMarker(target: DropTarget): number {
    if (target.newStage === 'before') return target.stage - 0.5;
    if (target.newStage === 'after') return target.stage + 0.5;
    return target.stage;
  }

  function handleDropInto(
    target: DropTarget,
    owner: GraphOwner,
    e: ReactDragEvent
  ) {
    e.preventDefault();
    e.stopPropagation();
    setHotZone(null);

    // Branch 1: palette → canvas (create a new node).
    const newPayload = e.dataTransfer.getData(DND_MIME_NEW);
    if (newPayload) {
      try {
        const parsed = JSON.parse(newPayload) as NewNodePayload;
        const entry = CATALOG.find(
          (c) => c.kind === parsed.kind && c.action === parsed.action
        );
        if (!entry) return;

        const seed = {
          kind: entry.kind,
          action: entry.action,
          config: { ...entry.defaultConfig }
        };
        if (owner) {
          addNodeToBranchStage(
            owner.parentId,
            owner.branchKey,
            stageMarker(target),
            seed
          );
        } else {
          addNodeToStage(stageMarker(target), seed);
        }
        return;
      } catch {
        // Malformed payload — fall through to the existing-node path.
      }
    }

    // Branch 2: existing-node move.
    const nodeId = e.dataTransfer.getData(DND_MIME_EXISTING);
    if (!nodeId) return;

    const stageArg = stageMarker(target);
    const slotArg =
      target.newStage === 'before' || target.newStage === 'after'
        ? 0
        : target.slot;

    // Root-scope moves can use the purpose-built action (cheaper — doesn't
    // walk the whole tree). Cross-scope moves go through moveNodeCrossScope
    // which extracts from wherever the node lives and inserts at the target.
    if (!owner) {
      // Use moveNodeCrossScope regardless: it also handles the root case
      // and gracefully relocates nodes currently living in a branch.
      moveNodeCrossScope(nodeId, null, stageArg, slotArg);
      return;
    }
    moveNodeCrossScope(nodeId, owner, stageArg, slotArg);
  }

  // Bubble-catcher on the canvas body: if a drop lands on empty canvas
  // chrome (not on a zone), still accept it so the browser doesn't reject
  // the drag visually.
  function handleCanvasDragOver(e: ReactDragEvent) {
    const hasPayload =
      Array.from(e.dataTransfer.types).includes(DND_MIME_EXISTING) ||
      Array.from(e.dataTransfer.types).includes(DND_MIME_NEW);
    if (!hasPayload) return;
    e.preventDefault();
  }

  // Embers strip — render enough 1:1 video tiles to fill the viewport plus
  // ~2 tiles of buffer on each side so the wrap-around translate never
  // exposes an empty edge. The strip is OUTSIDE the scroller so it stays
  // pinned to the canvas viewport bottom (vertical scroll won't pull it
  // off-screen); horizontal motion is faked by translating the row by
  // -scrollLeft modulo a single tile width, which loops seamlessly because
  // every tile is the same looping clip.
  const EMBER_TILE_PX = 128; // matches h-32 (square video → square tile)
  const emberTileCount = Math.max(8, Math.ceil(viewportWidth / EMBER_TILE_PX) + 4);
  // Safe modulo (handles scrollLeft = 0 and any positive value).
  const emberOffset = ((scrollLeft % EMBER_TILE_PX) + EMBER_TILE_PX) % EMBER_TILE_PX;

  return (
    <div className="flex-1 relative">
      <div
        ref={scrollerRef}
        className="absolute inset-0 solder-canvas-surface overflow-auto"
        onClick={() => selectNode(null)}
        onDragOver={handleCanvasDragOver}
      >
        {/*
         * Scene-level "camera zoom" transition.
         *
         * Each focus level gets its own motion.div inside an AnimatePresence
         * keyed by the focus path. On step-in, the OUTGOING scene scales up
         * around the clicked card's center (origin set via inline style,
         * captured by prepareDiveIn before the focus push) until the card
         * fills the frame. The INCOMING scene emerges from a slight oversize
         * (scale 1.08 → 1) giving the impression we just arrived inside.
         *
         * On pop-out, there's no card to zoom back to, so we do a symmetric
         * recede: outgoing shrinks, incoming swells from small.
         *
         * Respects prefers-reduced-motion (falls back to a plain cross-fade).
         *
         * `w-max min-w-full` lets the scene size to its content (so wide
         * integrations push horizontal overflow up to the scroller above),
         * while still filling the viewport when the integration is narrow.
         * Removing the previous `overflow-hidden` here is intentional — the
         * scroller above already clips anything outside the viewport, and
         * keeping the scene's overflow visible is what allows the layout to
         * propagate up and engage horizontal scroll.
         */}
        <div
          ref={sceneContainerRef}
          className="relative min-h-full w-max min-w-full"
        >
          <AnimatePresence
            mode="wait"
            custom={{ dir: direction, zoomScale: zoom?.scale ?? null }}
            initial={false}
          >
            <motion.div
              key={sceneKey}
              custom={{ dir: direction, zoomScale: zoom?.scale ?? null }}
              variants={reduceMotion ? reducedSceneVariants : sceneVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{
                // Exit (the big camera zoom) gets more time to sell the
                // motion; enter is snappy so the new scene lands crisp, not
                // languid.
                duration: reduceMotion ? 0.15 : 0.38,
                ease: [0.32, 0.72, 0.32, 1]
              }}
              onAnimationComplete={handleAnimationComplete}
              className="min-h-full flex items-start p-8 gap-2 will-change-transform"
              style={{ transformOrigin: zoom?.origin ?? 'center 45%' }}
            >
              {/*
               * StagesGraph is ALWAYS mounted — even on an empty canvas — so
               * palette drags always have a drop target. Its own empty-stages
               * branch renders a single lead StageGap with a "new stage"
               * label that accepts the first drop. If we gated on
               * `scopedNodes.length` and rendered a plain <div> instead,
               * drags would silently fail.
               */}
              <StagesGraph
                nodes={scopedNodes}
                owner={activeOwner}
                selectedNodeId={selectedNodeId}
                onSelect={selectNode}
                onDelete={removeNode}
                hotZone={hotZone}
                setHotZone={setHotZone}
                onDragStart={handleDragStart}
                onDropInto={handleDropInto}
                onStepInto={(parentId, branchKey) =>
                  pushFocus({ parentId, branchKey })
                }
                onPrepareDiveIn={prepareDiveIn}
                depth={0}
              />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/*
       * Breadcrumb — hoisted out of the scroller so horizontal scrolling
       * doesn't drag it off-screen. Stays pinned to the canvas top with a
       * translucent backdrop-blur so the scene reads through it. z-30 keeps
       * it above the ember strip too.
       */}
      <AnimatePresence initial={false}>
        {focusPath.length > 0 && (
          <motion.div
            key="breadcrumb"
            className="absolute top-0 left-0 right-0 z-30 flex items-center gap-2 px-4 py-2 bg-black/70 border-b border-surface-800 backdrop-blur-sm text-xs font-mono overflow-hidden pointer-events-auto"
            onClick={(e) => e.stopPropagation()}
            data-testid="canvas-breadcrumb"
            initial={reduceMotion ? {} : { y: -24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduceMotion ? {} : { y: -24, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <button
              type="button"
              onClick={() => setFocusPath([])}
              className="text-surface-400 hover:text-surface-50 transition-colors uppercase tracking-[0.15em]"
            >
              main
            </button>
            {trail.map((seg, i) => (
              <Fragment key={i}>
                <span className="text-surface-700">›</span>
                <button
                  type="button"
                  onClick={() => setFocusPath(focusPath.slice(0, i + 1))}
                  className={`uppercase tracking-[0.15em] transition-colors ${
                    i === trail.length - 1
                      ? 'text-surface-50'
                      : 'text-surface-400 hover:text-surface-50'
                  }`}
                >
                  {seg.label}
                  <span className="ml-1 text-surface-500">·</span>
                  <span className="ml-1">{seg.branchLabel}</span>
                </button>
              </Fragment>
            ))}
            <span className="ml-auto text-[10px] text-surface-600">
              esc to return
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/*
       * Ember strip — looping fire video tiled along the bottom of the
       * canvas. The strip is `pointer-events-none` so it never blocks drags
       * or clicks on the scene below. `mix-blend-mode: screen` (in the
       * `.solder-embers-strip` class) drops the video's near-black backdrop
       * against our deep-black canvas so only the bright embers paint.
       *
       * Horizontal motion: we render `tileCount` copies side-by-side and
       * translate the row by `-emberOffset` (scrollLeft mod tileWidth). As
       * the user scrolls the integration left/right via the wheel, the
       * embers slide in lockstep and wrap seamlessly because each tile is
       * the same loop. The mp4's own playback adds the natural flicker on
       * top, so the embers feel alive even when the user isn't scrolling.
       */}
      <div
        className="solder-embers-strip absolute bottom-0 left-0 right-0 h-32 overflow-hidden pointer-events-none z-20"
        aria-hidden="true"
      >
        <div
          className="flex h-full will-change-transform"
          style={{ transform: `translate3d(${-emberOffset}px, 0, 0)` }}
        >
          {Array.from({ length: emberTileCount }).map((_, i) => (
            <video
              key={i}
              src="/solder-embers.mp4"
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
              className="h-full flex-none object-cover"
              style={{ width: `${EMBER_TILE_PX}px` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  useIntegrationStore,
  type SolderNode,
  type FocusSegment
} from '@/stores/integration';
import { CATALOG, lookupCatalog, resolveBranches } from '@/catalog';
import { DND_MIME_EXISTING, DND_MIME_NEW, type NewNodePayload } from './dnd';
import StagesGraph, { type DropTarget, type GraphOwner } from './StagesGraph';
import EmberCanvas from './EmberCanvas';

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
  /**
   * Pixel offset to translate the outgoing scene by during a dive so
   * the clicked card drifts toward viewport center while growing —
   * makes the move read as a real dolly-in toward the action, not a
   * radial zoom that leaves the card pinned to its starting position.
   */
  dx: number | null;
  dy: number | null;
}

/**
 * Framer Motion variants for the scene-level flight transition.
 *
 * The transition layers three signals so a step-into reads as a real
 * camera move through depth, not just a CSS rescale:
 *
 *   - **scale**  carries the geometric "we got closer / further".
 *   - **opacity** carries "the old place is behind us / new place is
 *     arriving".
 *   - **filter: blur(...)** carries the depth-of-field rack — the lens
 *     defocuses as the camera drives in, refocuses as it lands. This is
 *     the single most important addition; without it the geometry alone
 *     reads as a UI shrug, not a cinematic move.
 *
 * Easing is asymmetric on purpose:
 *
 *   - exit accelerates (ease-in cubic) — the camera *picks up speed* as
 *     it dives toward the card.
 *   - enter decelerates (expo-out) — the camera *settles* into the new
 *     scene like a landing, not a snap.
 *
 * Step-in (dir = +1, zoomScale set): the outgoing scene scales toward
 * the clicked card (origin baked in via inline transform-origin), bluring
 * out as it goes. The incoming body view emerges from a slight oversize
 * (1.15, blurred) and racks into focus at 1.0. The two halves share the
 * same blur peak at the swap moment, which masks AnimatePresence's hard
 * cut between exit and enter.
 *
 * Pop-out (dir = -1): symmetric scale recede with the same blur rack.
 * No card origin (we don't know which card the user is returning to), so
 * the camera pulls back from a center origin instead.
 *
 * Reduced-motion: plain opacity cross-fade. No scale, no blur — both
 * cues that wouldn't be respectful of the user's preference.
 */

const EXIT_EASE = [0.65, 0, 0.85, 0.2] as const;     // accelerating dive
const ENTER_EASE = [0.16, 1, 0.3, 1] as const;       // decelerating landing
const EXIT_DURATION = 0.45;
const ENTER_DURATION = 0.5;
/**
 * Cap the dive's terminal scale. Tuned for a *subtle* dive — the eye
 * needs to register depth motion without the scene visibly stretching
 * across half the viewport. The geometric "card fills the viewport"
 * value can climb over 8x for tiny cards on big screens, which read as
 * a teleport. 2.0x peak (paired with the blur rack) is enough to feel
 * like a deliberate dolly-in without being intrusive.
 */
const ZOOM_SCALE_CAP = 2.0;

const sceneVariants = {
  initial: (c: SceneCustom) => ({
    opacity: 0,
    // Subtle on both sides: dive-in lands the new scene from a 1.06
    // oversize (was 1.15); pop-out enters from a 0.97 undersize (was
    // 0.94). Smaller magnitudes keep the transition feeling like a
    // restrained focus pull rather than a camera lurch.
    scale: c.dir > 0 ? 1.06 : 0.97,
    filter: 'blur(6px)'
  }),
  animate: {
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      duration: ENTER_DURATION,
      ease: ENTER_EASE,
      // Fade slightly faster than the scale/blur so the new scene
      // commits visually before its motion fully settles — reads as
      // "we're here, now adjusting" rather than "still in transit".
      opacity: { duration: ENTER_DURATION * 0.8, ease: ENTER_EASE }
    }
  },
  exit: (c: SceneCustom) => ({
    opacity: 0,
    scale:
      c.dir > 0
        ? Math.min(c.zoomScale ?? 1.3, ZOOM_SCALE_CAP)
        : 0.96,
    // Drift the scene so the clicked card lands at viewport center
    // during the dive — only on dive-in (dir > 0); pop-out has no
    // card target. Both default to 0 if no card was captured (e.g.
    // sibling-branch jump from the context panel).
    x: c.dir > 0 ? c.dx ?? 0 : 0,
    y: c.dir > 0 ? c.dy ?? 0 : 0,
    filter: 'blur(7px)',
    transition: {
      duration: EXIT_DURATION,
      ease: EXIT_EASE,
      opacity: { duration: EXIT_DURATION * 1.1, ease: EXIT_EASE }
    }
  })
} as const;

const reducedSceneVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } }
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
    // Use the dynamic resolver so Switch's case_* keys resolve to their
    // configured labels rather than just the upper-cased key.
    const branchEntry = resolveBranches(parent)?.find((b) => b.key === seg.branchKey);
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
  const [zoom, setZoom] = useState<{
    origin: string;
    scale: number;
    /** Translate offset in viewport px to drift the card toward viewport center during the dive. */
    dx: number;
    dy: number;
  } | null>(null);

  // Scrolling-canvas refs.
  //
  // The canvas surface scrolls horizontally as the user navigates through a
  // wide integration (many stages). We re-map mouse-wheel deltaY → scrollLeft
  // so a vertical wheel gesture pans the integration left/right (the user's
  // explicit ask — most builder canvases use horizontal flow). The ember
  // particle field reads scrollLeft via a ref every animation frame; using
  // a ref instead of React state keeps the parent from re-rendering on
  // every wheel tick — the canvas paints itself directly.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollLeftRef = useRef(0);

  // Bottom inset of the ember strip (px) — height of the horizontal
  // scrollbar so flames don't render under it. Tracked dynamically
  // because OS scrollbars vary (Windows ~17px, macOS overlay 0), but
  // it doesn't move during normal hover/UI-state changes — only on
  // window resize and overflow-status flips.
  const [emberBottom, setEmberBottom] = useState(0);

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

  // Mirror the live scroll position into a ref. EmberCanvas reads this on
  // its own rAF loop, so we don't even need to throttle here — but we
  // still install the scroll listener as passive: true so it doesn't
  // block scrolling itself.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const sync = () => {
      scrollLeftRef.current = el.scrollLeft;
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    return () => el.removeEventListener('scroll', sync);
  }, []);

  // Track horizontal scrollbar height so the ember strip can sit just
  // above it. We deliberately do NOT observe the scroller's scrollable
  // content here — that would fire on every hover-driven height change
  // inside the stages and we want the ember field to behave as a
  // stable backdrop, independent of UI state. A ResizeObserver on the
  // scroller's *outer* box only fires on real layout events (window
  // resize, sidebar toggle), which is what we want.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const update = () => {
      setEmberBottom(scroller.offsetHeight - scroller.clientHeight);
    };

    update();

    const ro = new ResizeObserver(update);
    ro.observe(scroller);
    window.addEventListener('resize', update);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
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
    // Scale the dive to ZOOM_SCALE_CAP at most. We deliberately ignore
    // the geometric "fill the viewport" value (sceneRect / cardRect can
    // be 8-10x) because at that magnitude the scene visibly stretches
    // and the move reads as intrusive. A flat 1.4–2.0 range, modulated
    // slightly by card size, keeps the dive a gentle dolly-in. Smaller
    // cards still get a touch more zoom (more "we crossed depth") via
    // a soft mix between the cap and a 1.4 floor.
    const fillRatio = Math.max(
      sceneRect.width / cardRect.width,
      sceneRect.height / cardRect.height
    );
    // Map the ratio (typically 4–10) into our 1.4–2.0 working range.
    // log compression keeps the curve gentle: a 10x card and a 4x card
    // get scales ~1.95 vs ~1.55, not 2.0 vs 1.4.
    const t = Math.min(1, Math.max(0, (Math.log2(fillRatio) - 2) / 2));
    const scale = 1.4 + t * (ZOOM_SCALE_CAP - 1.4);
    /*
     * Directional drift — translate the scene during the dive so the
     * card ends at viewport center (slightly above, ~42% Y, to match
     * the existing "center 45%" framing). Without this, scaling around
     * the card's own origin keeps the card pinned at its starting
     * position and everything else radiates outward — which reads as a
     * radial zoom, not a camera dolly toward the action. Adding the
     * translate makes the card grow AND drift to where the user's eye
     * is pointed, which is what "dolly-in" actually looks like in
     * cinema.
     */
    const cardCenterVpX = cardRect.left + cardRect.width / 2;
    const cardCenterVpY = cardRect.top + cardRect.height / 2;
    const targetVpX = window.innerWidth / 2;
    const targetVpY = window.innerHeight * 0.42;
    const dx = targetVpX - cardCenterVpX;
    const dy = targetVpY - cardCenterVpY;
    setZoom({ origin: `${ox}px ${oy}px`, scale, dx, dy });
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

  return (
    <div className="relative w-full h-full">
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
            custom={{
              dir: direction,
              zoomScale: zoom?.scale ?? null,
              dx: zoom?.dx ?? null,
              dy: zoom?.dy ?? null
            }}
            initial={false}
          >
            <motion.div
              key={sceneKey}
              custom={{
              dir: direction,
              zoomScale: zoom?.scale ?? null,
              dx: zoom?.dx ?? null,
              dy: zoom?.dy ?? null
            }}
              variants={reduceMotion ? reducedSceneVariants : sceneVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              onAnimationComplete={handleAnimationComplete}
              className="min-h-full flex items-start pt-[7.5rem] pb-8 pr-[21rem] gap-2 will-change-transform"
              style={{
                transformOrigin: zoom?.origin ?? 'center 45%',
                /*
                 * Read the live sidebar width Sidebar.tsx publishes onto
                 * <body>. Falls back to expanded width on first paint so
                 * cards land in the right place before the effect fires.
                 * Animated via CSS transition so collapse drags the cards
                 * left in lockstep with the sidebar's own width animation
                 * (200ms / linear) — without this, the canvas is dead
                 * weight and the collapse leaves a visible empty band.
                 */
                paddingLeft: 'var(--solder-sidebar-w, 17rem)',
                transition: 'padding-left 200ms ease'
              }}
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
       * In-canvas breadcrumb removed in the layered-chrome pass — the
       * NestedContextPanel in the sidebar now carries this load with
       * richer per-level context (title, headline, branch caption,
       * loop reduce caption) and click-to-jump-back. Keeping a second
       * breadcrumb here would just duplicate that information AND
       * collide visually with the floating topbar above the canvas.
       * `esc to return` keyboard shortcut still works (handled by the
       * effect below).
       */}

      {/*
       * Ember field — a fixed-share strip pinned to the bottom of the
       * canvas viewport. Independent of stage layout: hover effects,
       * focus dives, and node count don't move it. Stages live in the
       * top half (motion.div uses items-start), embers live in the
       * bottom half — natural separation without runtime measurement.
       *
       * `bottom: emberBottom` keeps flames clear of the horizontal
       * scrollbar; `pointer-events-none` keeps the strip from
       * blocking drags or clicks. See EmberCanvas.tsx for the
       * particle system.
       *
       * `w-full` is load-bearing: <canvas> is a replaced element with
       * intrinsic ratio 300×150, which beats `left:0; right:0` for
       * sizing — without explicit width the canvas would shrink to a
       * fraction of the viewport.
       */}
      <EmberCanvas
        scrollLeftRef={scrollLeftRef}
        className="absolute left-0 w-full h-1/2 pointer-events-none z-20"
        style={{ bottom: emberBottom }}
      />
    </div>
  );
}


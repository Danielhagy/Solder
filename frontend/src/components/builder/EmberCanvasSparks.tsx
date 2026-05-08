import { useEffect, useRef, type CSSProperties } from 'react';

/**
 * EmberCanvasSparks — grid-locked sparks animation.
 *
 * Conceptually different from EmberCanvas (the "classic" particle field):
 * here every spark ignites from a real grid cell on the canvas's
 * background dot grid, rises while cooling, and burns out. The CSS grid
 * (`.solder-canvas-surface` background, `radial-gradient` repeated at
 * 24px) supplies the gray dot underneath at rest. To make individual
 * dots feel "consumed" by their spark, we paint a small surface-colored
 * disc over each ignited cell (in source-over composite, before the
 * additive spark pass) — the CSS dot underneath is faint enough that an
 * opaque patch of the parent background color blanks it cleanly. The
 * patch holds full opacity for the spark's lifetime + a short tail, then
 * fades out so the gray dot "respawns" in place. No second canvas
 * needed; the cover IS the per-cell mask.
 *
 * Trade-offs vs. classic:
 *   ✓ Grid-locked spawn → reads as "the page itself catches fire" rather
 *     than a foreign particle layer hovering above the surface.
 *   ✓ Sparser by design (~5 simultaneous sparks) → quieter and more
 *     intentional; reads as drafted-paper-with-heat instead of wall-of-fire.
 *   ✓ No parallax math, no depth-of-field, no scroll-driven motion →
 *     simpler render, lower CPU.
 *   ✗ Loses the 3D depth illusion (depth tiers + screen-space gaussian
 *     blur). Sparks live on a single plane, all crisp.
 *   ✗ Loses the dramatic "wall of embers" intensity. If we later want
 *     a celebratory burst (run completion, etc.) we can crank
 *     TARGET_SIMULTANEOUS or temporarily swap back to classic.
 *
 * Reduce-motion: blank canvas → CSS grid shows through unchanged. No
 * animation queued.
 */

interface Props {
  className?: string;
  style?: CSSProperties;
}

/* Must match `.solder-canvas-surface` `background-size: 24px 24px` and the
 * `circle at 1px 1px` offset in `index.css`. If the CSS grid spec changes,
 * update both in lockstep — sparks must align *exactly* to the gray dots. */
const GRID_PX = 24;
const GRID_OFFSET = 1;

/* Aim for ~2 sparks alive at any time — quiet, contemplative pace. The
 * Poisson scheduler (mean inter-arrival = SPARK_LIFETIME_MS / target) gives
 * one ignition roughly every 4.5 seconds on average. To dial up: raise
 * TARGET_SIMULTANEOUS; to slow further: raise SPARK_LIFETIME_MS (which also
 * slows the rise speed since arc distance is fixed in CSS px). */
const TARGET_SIMULTANEOUS = 2;
/* 9 seconds per spark — roughly 2.5× the original 3.5s. The arc distance
 * is unchanged, so the rise reads as much slower (~slow drift up) instead
 * of "spark rocket". Works with the longer cool phase to give a real
 * "ember floats up and dies" arc rather than "spark hops". */
const SPARK_LIFETIME_MS = 9000;
const HARD_CAP = 6; // safety lid; well above target so the Poisson tail still fits
/* Initial burst on mount. Smaller than before because density is much
 * lower — 2 sparks backdated across early lifecycle is enough that the
 * first frame isn't empty without crowding the floor. */
const INITIAL_BURST = 2;
/* How many bottom-most rows are ignition candidates. 5 rows × 24px = 120px
 * deep "hot zone" against the floor of the strip. */
const HOT_ROWS = 5;
/* Peak radius of a spark at maximum heat, in CSS pixels. Bigger = more
 * dramatic blooms, lower = more drafted/restrained. 22 is the smallest
 * that still reads as "fire" against pure-black with 8 simultaneous. */
const PEAK_RADIUS = 22;

/* Phase fractions (of total lifetime, 0..1):
 *   [0, IGNITE]      heating in place, gray → white-hot, no movement.
 *   [IGNITE, HOT]    rising + at peak heat, slow ascent.
 *   [HOT, 1]         cooling + fading + faster ascent, white → red → fade.
 *
 * The HOT band is intentionally long (55% of lifetime) so the spark
 * holds at peak luminance while it does most of the rising. Short HOT
 * + long COOL reads as "dim red dots floating up" rather than "fire";
 * long HOT + medium COOL keeps the spark clearly luminous through its
 * arc and reserves the fade for the final ascent.
 */
const PHASE_IGNITE = 0.06;
const PHASE_HOT = 0.6;

/* Cover lifecycle (relative to spark ignition):
 *   [0, SPARK_LIFETIME_MS + DIM_TAIL_MS]   full-opacity cover (gray dot gone)
 *   [..., ... + DIM_FADE_MS]               opacity ramps 1 → 0 (gray dot fades back)
 *
 * The tail is a deliberate beat of empty after the spark dies — without
 * it the dot would pop back in the same instant the spark vanishes,
 * which breaks the "this dot got carried away" illusion. The fade is
 * intentionally slow (3s) so the dot's return reads as "ash settling"
 * rather than a switch flip. */
const DIM_TAIL_MS = 1500;
const DIM_FADE_MS = 3000;
/* Cover radius in CSS px. The CSS dot is 1px with a 1.4px transparent
 * threshold (~2px effective disc). 3px blankets it with a hairline of
 * margin so anti-aliased edges don't poke through. */
const COVER_RADIUS = 3;

interface Spark {
  /** Grid cell origin in CSS px (matches a CSS dot exactly). */
  cellX: number;
  cellY: number;
  /** perf.now() when ignition started — drives the phase calculation. */
  startedAt: number;
  /** Total upward travel in CSS px before fade-out completes. */
  riseAmount: number;
  swayAmp: number;
  swayFreq: number;
  swayPhase: number;
  flickerPhase: number;
}

/* Single shared sprite — pre-rendered once. White-hot core + warm halo;
 * we drive perceived "temperature" by alpha + radius rather than swapping
 * sprites. Far simpler than a per-phase sprite atlas and it reads correctly
 * because the human eye registers "dimmer & smaller" as "cooler". */
function makeSparkSprite(): HTMLCanvasElement {
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const r = size / 2;

  // Outer halo — soft warm glow. Keeps the spark reading as a luminous
  // volume rather than a cookie-cutter dot.
  const halo = ctx.createRadialGradient(r, r, 0, r, r, r);
  halo.addColorStop(0.0, 'rgba(255, 90, 30, 0.55)');
  halo.addColorStop(0.20, 'rgba(220, 30, 10, 0.30)');
  halo.addColorStop(0.50, 'rgba(160, 10, 0, 0.09)');
  halo.addColorStop(1.0, 'rgba(120, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  // Hot core — additive on top so the center peaks toward white naturally.
  // Tight radius (~16% of sprite) keeps the spark with a legible focal point.
  ctx.globalCompositeOperation = 'lighter';
  const core = ctx.createRadialGradient(r, r, 0, r, r, r * 0.16);
  core.addColorStop(0.0, 'rgba(255, 220, 170, 1.0)');
  core.addColorStop(0.5, 'rgba(255, 130, 50, 0.7)');
  core.addColorStop(1.0, 'rgba(255, 60, 20, 0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  return c;
}

export default function EmberCanvasSparks({ className, style }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sprite = makeSparkSprite();
    let cssWidth = 0;
    let cssHeight = 0;
    /* Precomputed grid coords on resize. Sparks pick from these arrays so
     * ignition is O(1) and never lands off-grid. Recomputed on resize so
     * the strip can grow/shrink with the canvas viewport. */
    let gridXs: number[] = [];
    let hotRowYs: number[] = [];
    const sparks: Spark[] = [];
    /* Cells with an active "dot is gone" cover. Key = `${cellX},${cellY}`,
     * value = perf.now() at ignition. Entries are removed once the cover
     * has fully faded back. Bounded by HARD_CAP × (lifetime + tail + fade)
     * worth of ignitions — a handful at a time in normal operation. */
    const dimmedCells = new Map<string, number>();
    /* Background color used to blank the CSS gray dot. Read from the
     * canvas's nearest surface ancestor's computed style so it tracks
     * light/dark themes without a separate listener. Cached at resize. */
    let surfaceColor = '#000000';
    let rafId = 0;
    let nextIgnitionAt = 0;

    const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionMedia.matches;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const newW = rect.width;
      const newH = rect.height;
      if (newW === 0 || newH === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(newW * dpr);
      canvas.height = Math.floor(newH * dpr);
      // setTransform replaces any prior scale — safe to call on every
      // resize without compounding.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      cssWidth = newW;
      cssHeight = newH;

      // Resolve the gray-dot blanking color from the nearest surface
      // ancestor. Walks up because the canvas is positioned absolutely
      // inside an unrelated container — the surface color lives on
      // `.solder-canvas-surface` (or `.sol-canvas` on other pages). Falls
      // back to the body's bg, then black, so we always have a value.
      const surfaceEl =
        canvas.closest<HTMLElement>('.solder-canvas-surface, .sol-canvas') ??
        document.body;
      const bg = window.getComputedStyle(surfaceEl).backgroundColor;
      // 'rgba(0, 0, 0, 0)' or 'transparent' would produce no cover at all
      // — fall back to the body so the dot still gets blanked.
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        surfaceColor = bg;
      }

      // Rebuild grid coord caches. Match the CSS grid spec exactly so a
      // spark fires from the same pixel where the gray dot sits.
      gridXs = [];
      for (let x = GRID_OFFSET; x <= newW; x += GRID_PX) gridXs.push(x);
      hotRowYs = [];
      for (let row = 0; row < HOT_ROWS; row++) {
        // Offset row from the bottom edge of the strip. The bottom-most
        // CSS dot sits ~GRID_OFFSET above the strip's bottom (modulo the
        // CSS grid origin), so we compute downward from newH.
        const y = newH - GRID_OFFSET - row * GRID_PX;
        if (y > 0) hotRowYs.push(y);
      }

      // Repaint a single static frame on resize when reduced motion is
      // active, since the rAF loop isn't running.
      if (reducedMotion) ctx.clearRect(0, 0, cssWidth, cssHeight);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const igniteOne = (now: number) => {
      if (sparks.length >= HARD_CAP) return;
      if (gridXs.length === 0 || hotRowYs.length === 0) return;
      const cellX = gridXs[Math.floor(Math.random() * gridXs.length)];
      const cellY = hotRowYs[Math.floor(Math.random() * hotRowYs.length)];
      // Avoid stacking two sparks on the exact same cell — reads as a
      // double-ignite glitch rather than sustained heat.
      for (const s of sparks) {
        if (s.cellX === cellX && s.cellY === cellY) {
          if (now - s.startedAt < SPARK_LIFETIME_MS * 0.7) return;
        }
      }
      // Mark the cell's gray dot as "consumed" — the cover render below
      // blanks it for the spark's lifetime + tail, then fades it back in.
      // Re-igniting a cell that's still dimmed simply resets its clock,
      // which is the right read: the dot got hot again before settling.
      dimmedCells.set(`${cellX},${cellY}`, now);
      sparks.push({
        cellX,
        cellY,
        startedAt: now,
        // Vary travel distance per spark — uniform travel reads as
        // mechanical, like a row of bottle rockets. 55-90% of strip gives
        // each spark a "personality": some peter out, others reach high.
        riseAmount: cssHeight * (0.55 + Math.random() * 0.35),
        swayAmp: 8 + Math.random() * 14,
        swayFreq: 0.7 + Math.random() * 1.0,
        swayPhase: Math.random() * Math.PI * 2,
        flickerPhase: Math.random() * Math.PI * 2,
      });
    };

    const start = performance.now();

    const render = (now: number) => {
      // Poisson-ish ignition scheduler: draw an exponential gap with mean
      // (lifetime / target). This produces a non-uniform cadence — clusters
      // and lulls — that reads as natural fire vs. a metronome tick.
      const meanGap = SPARK_LIFETIME_MS / TARGET_SIMULTANEOUS;
      while (now >= nextIgnitionAt) {
        igniteOne(now);
        nextIgnitionAt = now + meanGap * (-Math.log(Math.max(1e-6, Math.random())));
      }

      const t = (now - start) / 1000;
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      // Cover pass — paint a surface-colored disc over each ignited cell
      // so its CSS gray dot reads as "gone". Source-over so the patch
      // actually opaques the underlying CSS dot; switched to additive
      // afterward for the spark draw. Done first so the spark halo
      // brightens *over* the cover (the cover is invisible inside the
      // spark's hot disc anyway, and the order keeps the spark's edge
      // soft instead of clipped by the disc).
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = surfaceColor;
      const dimEnd = SPARK_LIFETIME_MS + DIM_TAIL_MS;
      for (const [key, ignitedAt] of dimmedCells) {
        const elapsed = now - ignitedAt;
        let coverAlpha: number;
        if (elapsed < dimEnd) {
          coverAlpha = 1;
        } else if (elapsed < dimEnd + DIM_FADE_MS) {
          coverAlpha = 1 - (elapsed - dimEnd) / DIM_FADE_MS;
        } else {
          dimmedCells.delete(key);
          continue;
        }
        const comma = key.indexOf(',');
        const cellX = +key.slice(0, comma);
        const cellY = +key.slice(comma + 1);
        ctx.globalAlpha = coverAlpha;
        ctx.beginPath();
        ctx.arc(cellX, cellY, COVER_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      // Iterate backwards so we can splice finished sparks in place.
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        const phase = (now - s.startedAt) / SPARK_LIFETIME_MS;
        if (phase >= 1) {
          sparks.splice(i, 1);
          continue;
        }

        let radius: number;
        let alpha: number;
        let yOffset: number;

        if (phase < PHASE_IGNITE) {
          // Ignition: grow in place, alpha ramps in. The gray CSS dot
          // underneath is overwritten by the additive bright halo within
          // the first ~50ms — reads as "the dot is heating up".
          const u = phase / PHASE_IGNITE;
          radius = 2 + u * (PEAK_RADIUS - 2);
          alpha = u;
          yOffset = 0;
        } else if (phase < PHASE_HOT) {
          // Rising hot: peak luminance, slow first-half ascent. Rises ~40%
          // of total travel during this phase.
          const u = (phase - PHASE_IGNITE) / (PHASE_HOT - PHASE_IGNITE);
          radius = PEAK_RADIUS;
          alpha = 1;
          yOffset = u * s.riseAmount * 0.4;
        } else {
          // Cooling: shrink + fade, faster ascent (~60% of total travel).
          // Once yOffset exceeds the spark's halo radius (~16px), the gray
          // CSS dot at the origin cell becomes visible again — that's the
          // "new gray dot fading in its place" the user asked for, free
          // courtesy of the always-on CSS grid layer.
          const u = (phase - PHASE_HOT) / (1 - PHASE_HOT);
          radius = PEAK_RADIUS * (1 - u * 0.6);
          alpha = 1 - u;
          yOffset = s.riseAmount * (0.4 + u * 0.6);
        }

        // Gentle flicker on alpha — reads as live combustion vs. a
        // steady glow. Per-spark phase keeps neighbors out of lockstep.
        const flicker = 0.85 + 0.15 * Math.sin(t * 5 + s.flickerPhase);
        const sway = s.swayAmp * Math.sin(t * s.swayFreq + s.swayPhase);

        const drawX = s.cellX + sway;
        const drawY = s.cellY - yOffset;
        ctx.globalAlpha = alpha * flicker;
        ctx.drawImage(sprite, drawX - radius, drawY - radius, radius * 2, radius * 2);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      if (!reducedMotion) {
        rafId = requestAnimationFrame(render);
      }
    };

    const startMotion = () => {
      cancelAnimationFrame(rafId);
      const now = performance.now();
      // Initial burst — stagger a handful of sparks with backdated startedAt
      // so the canvas isn't empty for the first few seconds. Backdating
      // distributes the burst across early lifecycle phases so the user
      // sees a mix of igniting / hot / cooling sparks within the first
      // frame, not a synchronized wave.
      for (let i = 0; i < INITIAL_BURST; i++) {
        const backdate = (i / INITIAL_BURST) * SPARK_LIFETIME_MS * 0.7;
        igniteOne(now - backdate);
      }
      nextIgnitionAt = now;
      rafId = requestAnimationFrame(render);
    };

    if (reducedMotion) {
      // Static state: clear canvas so nothing renders; CSS grid stays
      // visible underneath. Honors prefers-reduced-motion and Playwright's
      // emulate_media({reducedMotion: 'reduce'}).
      ctx.clearRect(0, 0, cssWidth, cssHeight);
    } else {
      startMotion();
    }

    const onMotionChange = (e: MediaQueryListEvent) => {
      reducedMotion = e.matches;
      if (reducedMotion) {
        cancelAnimationFrame(rafId);
        sparks.length = 0;
        dimmedCells.clear();
        ctx.clearRect(0, 0, cssWidth, cssHeight);
      } else {
        startMotion();
      }
    };
    motionMedia.addEventListener('change', onMotionChange);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      motionMedia.removeEventListener('change', onMotionChange);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}

import { useEffect, useRef, type CSSProperties } from 'react';

/**
 * EmberCanvas — a 2D parallax particle field rendered to a <canvas>.
 *
 * Each ember is a procedurally-placed point with its own depth (`z`, 0..1).
 * Depth controls everything that sells the 3D illusion:
 *
 *   - radius: close embers are large discs, far embers are sub-pixel
 *   - alpha:  close embers are bright, far embers are dim
 *   - parallax rate: close embers translate ~2.5× the scroll delta, far
 *     embers crawl (~0.05×) — a ~50× ratio that is the strongest cue
 *   - depth-of-field: close embers stay sharp, far embers are gaussian-
 *     blurred via ctx.filter so they read as soft out-of-focus bokeh
 *     instead of small-but-crisp dots. Without this, the eye refuses to
 *     accept that the far layer is actually far — sharpness defeats
 *     parallax.
 *
 * Idle motion is intentionally tiny: just a per-particle sine-flicker on
 * alpha so the field reads as alive (not frozen) even when the user
 * isn't scrolling. The scroll-driven parallax is what produces the "fly
 * through 3D space" feel when the user pans the canvas.
 *
 * Rendering uses additive blending (`globalCompositeOperation = 'lighter'`)
 * so overlapping embers brighten naturally and the cluster reads as a
 * coherent fire glow rather than discrete dots stacked. The ember sprite
 * is pre-rendered once into an offscreen canvas (radial gradient,
 * red-orange-white core fading to transparent) and drawn via drawImage
 * per particle — much cheaper than building a gradient every frame.
 *
 * Particles are bucketed by depth tier at generation time so the render
 * loop iterates buckets and only swaps `ctx.filter` once per tier.
 * Per-particle filter changes are an order of magnitude more expensive
 * than batched ones, so this matters for keeping 60Hz on the 250+
 * particle field.
 */

interface Particle {
  /**
   * Position in "world" coordinates (range 0..2W where W is the strip
   * width). Stays constant after generation; on each frame we compute
   * the screen position by subtracting a depth-scaled scroll offset and
   * wrapping back into [0, W). This produces the parallax illusion
   * without ever moving the underlying particle.
   */
  xWorld: number;
  /**
   * Vertical position in CSS px (0 = top edge, cssHeight = bottom).
   * Mutated each frame: ember rises by riseSpeed × dt, recycled to
   * just-below-the-canvas when it leaves the top.
   */
  y: number;
  /** Depth, 0 (deepest background) → 1 (closest to the viewer). */
  z: number;
  /**
   * Drawn radius before height-fade, in CSS pixels — derived from z.
   * Final on-screen radius is `baseRadius × heightFactor(y)` so embers
   * shrink as they rise (matches how real sparks thin out with
   * altitude). Computed live in render rather than baked because y
   * now changes every frame.
   */
  baseRadius: number;
  /** Phase offset so each particle flickers on its own schedule. */
  flickerPhase: number;
  /** Per-particle flicker frequency (rad/sec). */
  flickerSpeed: number;
  /**
   * Peak alpha at full height-factor (i.e. at the bottom of the strip).
   * Multiplied by flicker and by a live heightFactor in render.
   */
  baseAlpha: number;
  /**
   * Upward drift speed in CSS px/sec. Larger for closer embers — heat
   * plumes at the camera read as faster than the dim wisps at the
   * back, which reinforces depth on top of parallax.
   */
  riseSpeed: number;
  /**
   * Lateral sway amplitude in CSS px. Each ember oscillates around
   * its xWorld by `swayAmp × sin(t × swayFreq + swayPhase)` — slow,
   * per-particle phases mean the field as a whole reads as a non-
   * repeating, serpentine drift even though each particle is just a
   * sine.
   */
  swayAmp: number;
  /** Lateral oscillation frequency (rad/sec). */
  swayFreq: number;
  /** Per-particle lateral phase (rad). */
  swayPhase: number;
  /**
   * Discretized depth bucket (0 = farthest → most blur,
   * BLUR_TIERS-1 = closest → sharp). Cached at generation so the render
   * loop can group draws by tier and only switch ctx.filter once per
   * bucket; per-particle filter changes are an order of magnitude
   * slower than the batched form.
   */
  tier: number;
}

interface Props {
  /**
   * Live scroll position. Read every frame from .current so this
   * component never re-renders when scroll changes — only the canvas
   * pixels do. Use a ref (not state) on the parent to keep React out of
   * the per-frame path.
   */
  scrollLeftRef: { current: number };
  className?: string;
  /**
   * Inline style — used by the parent to position the canvas as a strip
   * (top/bottom/height) so flames don't bleed into the stages above or
   * the scrollbar below. Keeping this generic instead of dedicated
   * top/bottom props avoids spreading layout decisions across files.
   */
  style?: CSSProperties;
}

const PARTICLE_COUNT = 260;

/**
 * Number of depth buckets used for the depth-of-field blur. More tiers
 * give a smoother focal falloff but more ctx.filter switches per frame;
 * 5 reads as a continuous gradient without measurable overhead at 60Hz.
 */
const BLUR_TIERS = 5;

/**
 * Per-tier gaussian blur radius in screen-space CSS pixels, applied via
 * ctx.filter at draw time. Indexed by tier (0 = farthest, BLUR_TIERS-1 =
 * closest). The blur is in *screen* space, not sprite space — that's
 * crucial: far particles are sub-pixel-tiny on their own, so a few
 * pixels of screen-space blur spread them into soft bokeh discs that
 * the eye actually registers as "out of focus" rather than just
 * "small". The closest tier is 0 so the foreground stays crisp.
 *
 * Falloff is roughly quadratic toward the back, mimicking how a real
 * lens loses focus past the hyperfocal plane.
 */
const TIER_BLUR_PX = [3.4, 1.9, 0.9, 0.25, 0];

/**
 * Pre-render the ember sprite once. Two stacked radial gradients:
 *   1. A wide, low-opacity red halo for the soft "glow" volume
 *   2. A small, bright core (orange-red, near-white center) for the hot point
 *
 * Stacking is what gives the embers a *defined* center point inside their
 * glow — a single broad gradient just smears, which read as "cheap" in the
 * first cut. The core is intentionally tiny (~8% of sprite radius) so each
 * ember has a sharp focal pixel before falling off.
 *
 * Sprite is 256×256 (was 128) to give us headroom for the largest close
 * embers (radius up to ~30px on screen) without visible upscaling fuzz.
 */
function makeEmberSprite(): HTMLCanvasElement {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;

  // Layer 1: outer glow (deep red, soft falloff). Most of the visible
  // particle radius is this halo — the eye reads it as "heat shimmer".
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  halo.addColorStop(0.0, 'rgba(255, 70, 30, 0.55)');
  halo.addColorStop(0.18, 'rgba(220, 30, 10, 0.32)');
  halo.addColorStop(0.45, 'rgba(160, 10, 0, 0.10)');
  halo.addColorStop(1.0, 'rgba(120, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  // Layer 2: hot core, additive on top of the halo. Tight radius so the
  // ember has a recognizable bright point. Using 'lighter' here means
  // the core summed with the halo gives a near-white peak naturally.
  ctx.globalCompositeOperation = 'lighter';
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.18);
  core.addColorStop(0.0, 'rgba(255, 200, 150, 1.0)');
  core.addColorStop(0.4, 'rgba(255, 110, 40, 0.7)');
  core.addColorStop(1.0, 'rgba(255, 60, 20, 0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  return c;
}

/**
 * Generate a fresh particle field sized for the given strip dimensions.
 * Called on mount and whenever the strip resizes meaningfully — particle
 * positions are tied to strip width (the world is 2× wide) and a resize
 * would otherwise produce visibly clustered or empty regions.
 *
 * Vertical distribution: density is heavily biased toward the bottom
 * (where the "fire source" implicitly lives) and falls off smoothly
 * toward the top, like real embers thinning as they rise. The mapping
 * `y = height * (1 - rand²)` puts most particles in the bottom third
 * while still letting a few wisps reach the very top of the canvas.
 *
 * To sell the rising-ember illusion, particles higher up (smaller y) are
 * also drawn smaller and dimmer — they're meant to read as "the few
 * sparks that made it up here", not full-strength embers floating in
 * mid-air. We pre-bake the height factor into radius/baseAlpha so the
 * render loop stays cheap.
 */
function generateParticles(width: number, height: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // z² weighting biases toward closer embers → more visual interest
    // near the camera while still keeping a bed of distant pinpricks.
    const z = Math.pow(Math.random(), 0.85);

    // Bottom-biased y. `1 - rand²` is dense near 1.0 and thins toward 0,
    // so multiplying by height clusters particles at the canvas bottom
    // with a long tail reaching upward.
    const u = Math.random();
    const yNorm = 1 - u * u; // 0..1, density ↑ at 1
    const y = height * yNorm;

    // 0 at top → 1 at bottom. Used to fade upward embers smaller and
    // dimmer so the field reads as "lots of fire below, a few sparks
    // above" rather than a uniform sheet of dots.
    const heightFactor = yNorm;

    // Discretize depth into a blur tier. Floor + clamp guards against
    // z hitting exactly 1.0 (would index past the array).
    const tier = Math.min(BLUR_TIERS - 1, Math.floor(z * BLUR_TIERS));

    out.push({
      xWorld: Math.random() * width * 2,
      y,
      z,
      // Wider near/far split than the first cut: far embers shrink
      // toward sub-pixel — but the screen-space blur in their tier
      // spreads them back out into soft glowing discs, so they still
      // read. Near embers grow up to ~36px so they feel "right next to
      // the camera" rather than "slightly bigger than the others".
      // No heightFactor bake — radius is multiplied by a live
      // heightFactor in render so rising embers shrink naturally.
      baseRadius: 0.6 + z * z * 34,
      flickerPhase: Math.random() * Math.PI * 2,
      flickerSpeed: 0.4 + Math.random() * 1.6,
      // Far embers fade to ~5% of full — combined with their blur,
      // they read as ambient haze rather than discrete points.
      baseAlpha: 0.05 + z * 0.85,
      tier,
      // Slow upward drift. Closer embers rise faster (z-weighted) and
      // a small random component makes neighbors at the same depth
      // visibly desynchronized — without it, particles at the same z
      // march upward in lockstep.
      riseSpeed: 2 + z * 10 + Math.random() * 3,
      // Sway amplitude scales lightly with z so close embers wander a
      // bit wider than far ones — the eye reads this as "they're
      // closer to me, so their lateral motion looks bigger".
      swayAmp: (5 + Math.random() * 18) * (0.4 + z * 0.7),
      // Lateral period 3–10s. Combined with the slow rise, this gives
      // each ember a serpentine path of roughly one wiggle per
      // 30–100px of vertical travel — flame-like, not chaotic.
      swayFreq: 0.6 + Math.random() * 1.4,
      swayPhase: Math.random() * Math.PI * 2,
    });
  }
  return out;
}

export default function EmberCanvas({ scrollLeftRef, className, style }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sprite = makeEmberSprite();
    let particles: Particle[] = [];
    // Particles bucketed by depth tier so we can swap ctx.filter once
    // per bucket instead of once per particle. Allocated once and
    // reused across resizes (we just clear and refill the inner
    // arrays) to avoid garbage on resize storms.
    const buckets: Particle[][] = Array.from({ length: BLUR_TIERS }, () => []);
    let cssWidth = 0;
    let cssHeight = 0;
    let rafId = 0;

    /*
     * Reduced-motion gate. When the user (or a Playwright test calling
     * `page.emulate_media({reducedMotion: 'reduce'})`) prefers reduced
     * motion, the rAF loop is the wrong default: it keeps the page in
     * permanent motion, which trips Playwright's actionability/stability
     * checks and is also a bad accessibility default. Under that
     * preference we paint a single static frame and exit. Declared up
     * here (above `resize`) so the resize closure can read it without
     * tripping a temporal-dead-zone error on the eager first call.
     */
    const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionMedia.matches;

    /**
     * Single-frame static paint used under prefers-reduced-motion. Same
     * shape as `render` but with rise / sway / flicker / parallax all
     * frozen — the field reads as a still photograph of the inert
     * moment between motion. Drawn once per resize / preference flip;
     * no rAF involvement. Declared above `resize` so the resize closure
     * can call it without tripping a temporal-dead-zone read on the
     * eager first invocation.
     */
    const staticRender = () => {
      const W = cssWidth;
      if (W === 0 || cssHeight === 0) return;
      ctx.clearRect(0, 0, W, cssHeight);
      ctx.globalCompositeOperation = 'lighter';
      for (let tier = 0; tier < BLUR_TIERS; tier++) {
        const blurPx = TIER_BLUR_PX[tier];
        ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
        const bucket = buckets[tier];
        for (let i = 0; i < bucket.length; i++) {
          const p = bucket[i];
          const yNorm = p.y < 0 ? 0 : p.y > cssHeight ? 1 : p.y / cssHeight;
          const sx = ((p.xWorld) % W + W) % W;
          // Mid-cycle flicker (1.0) so the field reads at full
          // baseAlpha; no sway, no parallax, no rise.
          const alpha = p.baseAlpha * (0.25 + 0.75 * yNorm);
          const r = p.baseRadius * (0.3 + 0.7 * yNorm);
          ctx.globalAlpha = alpha;
          ctx.drawImage(sprite, sx - r, p.y - r, r * 2, r * 2);
        }
      }
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    /**
     * Resize the backing store to match CSS pixels × devicePixelRatio so
     * the embers stay crisp on HiDPI displays.
     *
     * Particle handling on resize:
     *   - First call (no particles yet) or width changed: full
     *     regenerate. Particles' xWorld positions span [0, 2W), so a
     *     width change would otherwise leave visible empty bands.
     *   - Height-only change: rescale every particle's y proportionally
     *     and keep all other state. This is the common case on every
     *     hover — the StageGap drop-zone affordance grows from 8px →
     *     32px on hover, which propagates up as a height change to the
     *     ember strip. Regenerating there would visibly reshuffle every
     *     dot on every hover, which reads as the field "twitching"
     *     under the cursor. heightFactor (= y / cssHeight) is computed
     *     live in render, so a proportional y-scale preserves each
     *     particle's relative vertical position — and therefore its
     *     drawn radius and alpha — without any recomputation here.
     */
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const newW = rect.width;
      const newH = rect.height;
      if (newW === 0 || newH === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(newW * dpr);
      canvas.height = Math.floor(newH * dpr);
      // setTransform replaces any prior scale, so this is safe to call
      // every resize without compounding.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Bilinear-or-better filtering when scaling the sprite down. Default
      // is 'low' which leaves visible aliasing on the small far embers.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const widthChanged = Math.abs(newW - cssWidth) > 0.5;
      const heightChanged = Math.abs(newH - cssHeight) > 0.5;

      if (particles.length === 0 || widthChanged) {
        particles = generateParticles(newW, newH);
        // Rebucket by tier. Truncate-then-push avoids reallocating the
        // outer array; inner arrays grow back to roughly their prior
        // size each time so this stays GC-friendly.
        for (let i = 0; i < BLUR_TIERS; i++) buckets[i].length = 0;
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          buckets[p.tier].push(p);
        }
      } else if (heightChanged && cssHeight > 0) {
        const yScale = newH / cssHeight;
        for (let i = 0; i < particles.length; i++) {
          particles[i].y *= yScale;
        }
      }

      cssWidth = newW;
      cssHeight = newH;

      // Under reduced motion the rAF loop isn't running, so resize-time
      // repaint is the only way the strip stays in sync with the new
      // canvas dimensions. (`reducedMotion` and `staticRender` are
      // declared below — they're hoisted at execution because resize is
      // called both eagerly here and via the ResizeObserver after the
      // rest of the effect has run.)
      if (reducedMotion) staticRender();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const start = performance.now();
    // Smoothed scroll — eases toward `scrollLeftRef.current` each frame.
    // Wheel events arrive in chunks (one per wheel-click, ~30–50ms apart
    // on a typical mouse) and each one moves `scrollLeft` by ~100px
    // instantly. Reading scrollLeft raw on each frame produces visible
    // teleport-then-pause motion. By interpolating, the ember field
    // continues to glide between wheel events and decelerates after the
    // user stops, which is what reads as "smooth motion with depth".
    let smoothScroll = scrollLeftRef.current;
    let lastFrameTime = start;
    // 80ms time constant — at 60fps that means we close ~18% of the gap
    // every frame, reaching ~95% of the way to the target in ~3 frames.
    // Smaller TAU = snappier (closer to raw scroll), larger = floatier.
    const SMOOTH_TAU_MS = 80;

    const render = (now: number) => {
      const t = (now - start) / 1000;
      const dtMs = Math.min(64, Math.max(1, now - lastFrameTime));
      lastFrameTime = now;

      // Frame-rate-aware exponential ease. The 1 - e^(-dt/τ) form gives
      // identical perceived smoothing regardless of frame rate (60Hz vs
      // 144Hz vs a janky 30Hz) — important because we don't want the
      // parallax to feel "fast" on a high-refresh monitor and "sluggish"
      // on an underpowered laptop.
      const target = scrollLeftRef.current;
      const ease = 1 - Math.exp(-dtMs / SMOOTH_TAU_MS);
      smoothScroll += (target - smoothScroll) * ease;
      // Snap when within sub-pixel distance so we don't burn frames
      // chasing a 0.001-pixel residual forever.
      if (Math.abs(target - smoothScroll) < 0.25) smoothScroll = target;

      const scrollLeft = smoothScroll;
      const W = cssWidth;

      // Clear with full transparency so the deep-black canvas behind us
      // shows through. We don't paint a black background here ourselves
      // — that would defeat the additive blending below.
      ctx.clearRect(0, 0, W, cssHeight);
      ctx.globalCompositeOperation = 'lighter';

      // dt in seconds for position integration. Capped to 64ms (≈15Hz)
      // so a tab-switch or stall doesn't teleport every ember to the
      // top of the canvas in a single frame.
      const dt = dtMs / 1000;

      // Iterate by depth tier so ctx.filter only changes BLUR_TIERS
      // times per frame instead of PARTICLE_COUNT times. The blur is
      // applied as a screen-space gaussian during drawImage — far
      // particles get noticeably soft, close particles stay sharp.
      for (let tier = 0; tier < BLUR_TIERS; tier++) {
        const blurPx = TIER_BLUR_PX[tier];
        ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
        const bucket = buckets[tier];
        for (let i = 0; i < bucket.length; i++) {
          const p = bucket[i];

          // --- advance position ---
          p.y -= p.riseSpeed * dt;
          // Recycle when fully off the top edge. Respawn just below
          // the bottom edge with a fresh xWorld so density stays
          // constant; emerging from below = natural fade-in via the
          // bottom clip and the heightFactor curve.
          if (p.y < -p.baseRadius * 2) {
            p.y = cssHeight + Math.random() * 24;
            p.xWorld = Math.random() * W * 2;
            p.flickerPhase = Math.random() * Math.PI * 2;
            p.swayPhase = Math.random() * Math.PI * 2;
          }

          // Live heightFactor — 1 at bottom (full size/alpha), 0 at
          // top (small/dim). Clamped because particles can briefly
          // sit above y=0 or below y=cssHeight during the spawn/exit
          // transitions.
          const yNorm = p.y < 0 ? 0 : p.y > cssHeight ? 1 : p.y / cssHeight;

          // Parallax rate: deep embers (z→0) crawl at 0.05× scroll;
          // close embers (z→1) fly past at ~2.45×. The ~50× ratio
          // between near and far is what now sells the depth — the
          // first cut at ~10× still felt like "two layers", not space.
          // The 0.05 floor keeps the back from being perfectly static.
          const parallaxRate = 0.05 + p.z * 2.4;
          const offset = scrollLeft * parallaxRate;
          // Lateral sway — slow per-particle sine on top of xWorld.
          const sway = p.swayAmp * Math.sin(t * p.swayFreq + p.swayPhase);
          // Positive modulo (handles negative offsets after rubber-band
          // overscroll on touchpads).
          const sx = ((p.xWorld + sway - offset) % W + W) % W;

          // Flicker — each particle ramps between ~10% and ~100% of
          // its baseAlpha on its own clock. Sine is fine; a more
          // chaotic fbm/noise function reads as too jittery for
          // "ember" vs. "static".
          const flicker = 0.55 + 0.45 * Math.sin(t * p.flickerSpeed + p.flickerPhase);
          const alpha = p.baseAlpha * flicker * (0.25 + 0.75 * yNorm);
          const r = p.baseRadius * (0.3 + 0.7 * yNorm);

          ctx.globalAlpha = alpha;
          ctx.drawImage(sprite, sx - r, p.y - r, r * 2, r * 2);
        }
      }

      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      // Only re-queue the next frame if motion is still allowed. When
      // the media query flips to `reduce` mid-session the in-flight
      // frame finishes and the loop stops.
      if (!reducedMotion) {
        rafId = requestAnimationFrame(render);
      }
    };

    const startMotion = () => {
      cancelAnimationFrame(rafId);
      lastFrameTime = performance.now();
      rafId = requestAnimationFrame(render);
    };

    if (reducedMotion) {
      staticRender();
    } else {
      startMotion();
    }

    // React to live preference changes (system setting toggle, devtools
    // emulation, Playwright `page.emulate_media`).
    const onMotionChange = (e: MediaQueryListEvent) => {
      reducedMotion = e.matches;
      if (reducedMotion) {
        cancelAnimationFrame(rafId);
        staticRender();
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
  }, [scrollLeftRef]);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}

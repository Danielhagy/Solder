"""
Verify ember parallax motion: drive scrollLeft via JS (the canvas isn't
horizontally scrollable on an empty integration so we can't actually
wheel-scroll it without nodes), then capture two frames a few ms apart
during the smoothed easing window. If smoothing is working, mid-ease
samples should show *partial* movement of close embers and *less*
partial movement of far embers — i.e. the ember positions interpolate
smoothly rather than snapping.

Usage: python qa/qa_embers_motion.py
"""
from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

BASE = "http://localhost:5173"
OUT = Path(__file__).parent / "artifacts"
OUT.mkdir(exist_ok=True)


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 1600, "height": 900},
            device_scale_factor=2,
        )
        page = await ctx.new_page()
        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.wait_for_timeout(800)

        # Force the scroller wide so scrollLeft can move; then drive
        # scrollLeft directly via JS to bypass the wheel event.
        await page.evaluate(
            """() => {
              // Find the scroller (the absolute inset-0 overflow-auto inside the
              // canvas shell). Its child has w-max; if no nodes are present
              // it'll already be at 100% width — so synthesize fake horizontal
              // overflow by setting min-width on the inner scene container.
              const scroller = document.querySelector('div.absolute.inset-0.overflow-auto');
              if (!scroller) return { error: 'no scroller' };
              const inner = scroller.firstElementChild;
              if (inner) inner.style.minWidth = '4000px';
              window.__solderScroller = scroller;
              return { ok: true };
            }"""
        )

        # Initial frame (scrollLeft = 0)
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(OUT / "embers_t0.png"), full_page=False)

        # Drive a hard scroll; capture frames during the ease window
        await page.evaluate("window.__solderScroller.scrollLeft = 1200;")
        await page.wait_for_timeout(40)  # mid-ease at ~50% completion
        await page.screenshot(path=str(OUT / "embers_t1_mid.png"), full_page=False)
        await page.wait_for_timeout(400)  # settled
        await page.screenshot(path=str(OUT / "embers_t2_settled.png"), full_page=False)

        # Diagnostic: read smoothScroll's effect by sampling pixel-row positions
        # of the brightest 20 pixels in a strip slice
        diag = await page.evaluate(
            """() => {
              const c = document.querySelector('canvas[aria-hidden="true"]');
              if (!c) return { error: 'no canvas' };
              const ctx = c.getContext('2d');
              // Sample one horizontal row near the strip middle
              const y = Math.floor(c.height * 0.6);
              const row = ctx.getImageData(0, y, c.width, 1).data;
              // Find local maxima of red channel
              const peaks = [];
              for (let x = 2; x < c.width - 2; x++) {
                const r = row[x * 4];
                const rl = row[(x - 2) * 4];
                const rr = row[(x + 2) * 4];
                if (r > 80 && r >= rl && r >= rr) peaks.push({ x, r });
              }
              peaks.sort((a, b) => b.r - a.r);
              return { y, peakCount: peaks.length, top: peaks.slice(0, 12) };
            }"""
        )
        print("settled-frame ember row peaks:", diag)

        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

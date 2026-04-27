"""
Diagnostic for the EmberCanvas — measures the canvas's CSS box vs backing
store, samples a few pixels to see what's actually painted, and writes a
full-canvas screenshot. Usage: python qa/qa_embers.py
"""
from __future__ import annotations

import asyncio
import io
import json
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
        page.on("console", lambda m: print(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.wait_for_timeout(1500)  # let rAF settle

        diag = await page.evaluate(
            """() => {
              const c = document.querySelector('canvas[aria-hidden="true"]');
              if (!c) return { error: 'no canvas found' };
              const rect = c.getBoundingClientRect();
              const cs = getComputedStyle(c);
              const parent = c.parentElement;
              const parentRect = parent ? parent.getBoundingClientRect() : null;
              const ctx = c.getContext('2d');
              // sample a few points to see if anything is painted
              const samplePoints = [
                [10, 10], [c.width / 2, c.height / 2],
                [c.width - 10, c.height - 10],
                [c.width / 4, c.height / 2],
                [c.width * 3 / 4, c.height / 2]
              ];
              const samples = samplePoints.map(([x, y]) => {
                try {
                  const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
                  return { x: Math.floor(x), y: Math.floor(y), rgba: [d[0], d[1], d[2], d[3]] };
                } catch (e) {
                  return { x, y, error: String(e) };
                }
              });
              return {
                attr: { width: c.width, height: c.height },
                rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
                computed: {
                  position: cs.position, display: cs.display,
                  width: cs.width, height: cs.height,
                  left: cs.left, right: cs.right, bottom: cs.bottom, top: cs.top,
                  zIndex: cs.zIndex
                },
                parent: parentRect ? { tag: parent.tagName, className: parent.className, width: parentRect.width, height: parentRect.height } : null,
                dpr: window.devicePixelRatio,
                samples,
              };
            }"""
        )

        print("\n=== EmberCanvas diagnostic ===")
        print(json.dumps(diag, indent=2))

        screenshot_path = OUT / "embers.png"
        await page.screenshot(path=str(screenshot_path), full_page=False)
        print(f"\nfull viewport screenshot -> {screenshot_path}")

        # Crop the ember strip
        if "rect" in diag:
            r = diag["rect"]
            try:
                strip_path = OUT / "embers_strip.png"
                await page.screenshot(
                    path=str(strip_path),
                    clip={
                        "x": r["left"],
                        "y": r["top"],
                        "width": r["width"],
                        "height": r["height"],
                    },
                )
                print(f"ember strip crop      -> {strip_path}")
            except Exception as e:
                print(f"could not clip strip: {e}")

        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

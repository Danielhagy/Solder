"""
Visual capture for the Builder design pass.

Mirrors the same set of states the original UX audit captured (see
`qa/artifacts/ux-review/REPORT.md`) so before/after screenshots can be
compared 1:1. Output: `qa/artifacts/ux-review-after/`.

Usage: python qa/qa_redesign_capture.py
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
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "ux-review-after"
OUT.mkdir(parents=True, exist_ok=True)

PALETTE = {
    "API Call": "palette-http-request",
    "Transform": "palette-transform-map",
    "Branch": "palette-logic-branch",
    "Loop": "palette-logic-loop",
    "Output": "palette-output-passthrough",
}


def sel(name: str) -> str:
    return f'[data-testid="{PALETTE[name]}"]'


async def add(page, name: str) -> None:
    await page.click(sel(name))
    await page.wait_for_timeout(300)


async def shoot(page, name: str) -> None:
    path = OUT / f"{name}.png"
    await page.screenshot(path=str(path), full_page=False)
    print(f"  saved {path.name}")


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        print("01_empty …")
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(500)
        await shoot(page, "01_empty")

        print("02_three_stages …")
        await add(page, "API Call")
        await add(page, "Transform")
        await add(page, "Output")
        await page.wait_for_timeout(300)
        await shoot(page, "02_three_stages")

        print("03_with_branch …")
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(400)
        await add(page, "API Call")
        await add(page, "Branch")
        await add(page, "Output")
        await page.wait_for_timeout(300)
        await shoot(page, "03_with_branch")

        print("04_with_loop …")
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(400)
        await add(page, "API Call")
        await add(page, "Loop")
        await add(page, "Output")
        await page.wait_for_timeout(300)
        await shoot(page, "04_with_loop")

        print("05_node_selected …")
        # Click the second card so the properties panel populates.
        await page.click('[data-testid="node-logic-loop"]')
        await page.wait_for_timeout(300)
        await shoot(page, "05_node_selected")

        print("06_run_plan …")
        # Click the canvas surface to clear selection so right rail shows Run Plan.
        await page.evaluate("window.getSelection().removeAllRanges()")
        await page.click('[data-testid="empty-canvas-dropzone"], .solder-canvas-surface', force=True)
        await page.wait_for_timeout(300)
        await shoot(page, "06_run_plan")

        print("07_topbar_zoom …")
        # Crop just the top-bar region for a closer look.
        await page.screenshot(
            path=str(OUT / "07_topbar_zoom.png"),
            clip={"x": 0, "y": 0, "width": 1440, "height": 160},
        )
        print("  saved 07_topbar_zoom.png")

        print("08_sidebar_zoom …")
        await page.screenshot(
            path=str(OUT / "08_sidebar_zoom.png"),
            clip={"x": 0, "y": 0, "width": 280, "height": 900},
        )
        print("  saved 08_sidebar_zoom.png")

        # Sidebar collapse behaviour — cards should slide left to fill the
        # space the sidebar vacates.
        print("09_collapse_before …")
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(400)
        await add(page, "API Call")
        await add(page, "Transform")
        await add(page, "Output")
        await page.wait_for_timeout(300)
        await shoot(page, "09_collapse_before")

        print("10_collapse_after …")
        # Click the collapse chevron — the only button labeled "Collapse sidebar".
        await page.click('button[aria-label="Collapse sidebar"]')
        # Wait through the 200ms width / padding transition plus a little buffer.
        await page.wait_for_timeout(450)
        await shoot(page, "10_collapse_after")

        await browser.close()
        print(f"done -> {OUT}")


if __name__ == "__main__":
    asyncio.run(main())

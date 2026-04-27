"""
Final visual regression captures for the Builder design pass.

Modeled on `qa/qa_redesign_capture.py`. Output: `qa/artifacts/ux-review-after/final/`.
Captures the 10 screenshots described in the visual-regression spec.

Usage: python qa/qa_visual_final.py
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
OUT = Path(__file__).parent / "artifacts" / "ux-review-after" / "final"
OUT.mkdir(parents=True, exist_ok=True)

PALETTE = {
    "API Call": "palette-http-request",
    "Transform": "palette-transform-map",
    "If/Else": "palette-logic-branch",
    "Switch": "palette-logic-switch",
    "Loop": "palette-logic-loop",
    "Output": "palette-output-passthrough",
}


def sel(name: str) -> str:
    return f'[data-testid="{PALETTE[name]}"]'


async def add(page, name: str, status: dict) -> None:
    selector = sel(name)
    try:
        await page.click(selector, timeout=6000, force=True)
        await page.wait_for_timeout(400)
    except Exception as exc:
        status.setdefault("errors", []).append(f"add({name}): {exc}")
        print(f"  ! failed to add {name}: {exc}")


async def shoot(page, name: str, clip=None) -> None:
    path = OUT / f"{name}.png"
    if clip:
        await page.screenshot(path=str(path), clip=clip)
    else:
        await page.screenshot(path=str(path), full_page=False)
    print(f"  saved {path.name}")


async def fresh(page) -> None:
    await page.goto(BUILDER, wait_until="networkidle")
    await page.wait_for_timeout(500)


async def main() -> None:
    notes: dict = {"errors": []}
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        # 01 — empty canvas
        print("01_empty …")
        await fresh(page)
        await shoot(page, "01_empty")

        # 02 — three stages: API Call -> Transform -> Output
        print("02_three_stages …")
        await add(page, "API Call", notes)
        await add(page, "Transform", notes)
        await add(page, "Output", notes)
        await page.wait_for_timeout(300)
        await shoot(page, "02_three_stages")

        # 03 — API Call -> If/Else -> Output
        print("03_with_branch …")
        await fresh(page)
        await add(page, "API Call", notes)
        await add(page, "If/Else", notes)
        await add(page, "Output", notes)
        await page.wait_for_timeout(300)
        await shoot(page, "03_with_branch")

        # 04 — API Call -> Loop -> Output
        print("04_with_loop …")
        await fresh(page)
        await add(page, "API Call", notes)
        await add(page, "Loop", notes)
        await add(page, "Output", notes)
        await page.wait_for_timeout(300)
        await shoot(page, "04_with_loop")

        # 05 — API Call -> Switch -> Output (NEW node — palette button must exist)
        print("05_with_switch …")
        await fresh(page)
        switch_present = await page.locator(sel("Switch")).count()
        notes["switch_present"] = switch_present
        await add(page, "API Call", notes)
        await add(page, "Switch", notes)
        await add(page, "Output", notes)
        await page.wait_for_timeout(300)
        await shoot(page, "05_with_switch")

        # 06 — node selected (use the Switch node so the right rail has logic editor content)
        print("06_node_selected …")
        # try clicking the switch node first; fall back to a transform node
        try:
            await page.click('[data-testid="node-logic-switch"]', timeout=3000, force=True)
        except Exception:
            try:
                await page.click('[data-testid="node-output-passthrough"]', timeout=3000, force=True)
            except Exception as exc:
                notes["errors"].append(f"06 node click: {exc}")
        await page.wait_for_timeout(300)
        await shoot(page, "06_node_selected")

        # 07 — top 160px chrome
        print("07_topbar_zoom …")
        await shoot(page, "07_topbar_zoom",
                    clip={"x": 0, "y": 0, "width": 1440, "height": 160})

        # 08 — sidebar collapsed: capture the 280-wide left strip after collapse
        print("08_sidebar_collapsed …")
        try:
            await page.click('button[aria-label="Collapse sidebar"]', timeout=3000, force=True)
            await page.wait_for_timeout(450)
        except Exception as exc:
            notes["errors"].append(f"08 collapse click: {exc}")
        await shoot(page, "08_sidebar_collapsed",
                    clip={"x": 0, "y": 0, "width": 280, "height": 900})

        # 09 — back button: build a Loop and step in
        print("09_back_button …")
        await fresh(page)
        await add(page, "API Call", notes)
        await add(page, "Loop", notes)
        await add(page, "Output", notes)
        await page.wait_for_timeout(300)
        # step-into the loop
        try:
            await page.click('[data-testid="step-into-logic-loop"]', timeout=3000, force=True)
            await page.wait_for_timeout(700)
        except Exception as exc:
            notes["errors"].append(f"09 step-into: {exc}")
        # confirm the back pill is in the DOM
        notes["back_pill_count"] = await page.locator('[data-testid="topbar-back-to-main"]').count()
        await shoot(page, "09_back_button",
                    clip={"x": 0, "y": 0, "width": 1440, "height": 100})

        # 10 — Switch node selected, capture only the right rail
        print("10_logic_editor …")
        await fresh(page)
        await add(page, "API Call", notes)
        await add(page, "Switch", notes)
        await add(page, "Output", notes)
        await page.wait_for_timeout(300)
        try:
            await page.click('[data-testid="node-logic-switch"]', timeout=3000, force=True)
            await page.wait_for_timeout(400)
        except Exception as exc:
            notes["errors"].append(f"10 switch click: {exc}")
        await shoot(page, "10_logic_editor",
                    clip={"x": 1100, "y": 0, "width": 340, "height": 900})

        await browser.close()

    print(f"\ndone -> {OUT}")
    if notes.get("errors"):
        print("ERRORS:")
        for e in notes["errors"]:
            print("  -", e)
    print(f"switch_present_count: {notes.get('switch_present')}")
    print(f"back_pill_count: {notes.get('back_pill_count')}")


if __name__ == "__main__":
    asyncio.run(main())

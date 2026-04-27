"""
Fixup pass: re-capture 06, 08, 10 — the captures whose interaction click did
not register cleanly in the main script (selection didn't apply / sidebar
didn't collapse).

Strategy here: use locator.click() with no force, but explicitly hover and
scroll first; for the sidebar collapse, dispatch a JS click on the button.
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


async def add_via_dispatch(page, testid: str) -> None:
    """Click a palette button by dispatching a native click via JS — bypasses
    Playwright actionability completely (the EmberCanvas RAF loop confuses
    the stability checks)."""
    await page.evaluate(
        """(id) => {
            const el = document.querySelector(`[data-testid="${id}"]`);
            if (!el) throw new Error('palette button missing: ' + id);
            el.click();
        }""",
        testid,
    )
    await page.wait_for_timeout(450)


async def click_node(page, testid: str) -> None:
    """Select a canvas node by dispatching a native click on it."""
    ok = await page.evaluate(
        """(id) => {
            const el = document.querySelector(`[data-testid="${id}"]`);
            if (!el) return false;
            el.click();
            return true;
        }""",
        testid,
    )
    if not ok:
        raise RuntimeError(f"node {testid} not in DOM")
    await page.wait_for_timeout(450)


async def fresh(page) -> None:
    await page.goto(BUILDER, wait_until="networkidle")
    await page.wait_for_timeout(500)


async def shoot(page, name: str, clip=None) -> None:
    path = OUT / f"{name}.png"
    if clip:
        await page.screenshot(path=str(path), clip=clip)
    else:
        await page.screenshot(path=str(path), full_page=False)
    print(f"  saved {path.name}")


async def main() -> None:
    notes = {"errors": []}
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        # ---------- 06_node_selected ----------
        print("06_node_selected …")
        await fresh(page)
        await add_via_dispatch(page, "palette-http-request")
        await add_via_dispatch(page, "palette-logic-switch")
        await add_via_dispatch(page, "palette-output-passthrough")
        await page.wait_for_timeout(400)
        try:
            await click_node(page, "node-logic-switch")
        except Exception as exc:
            notes["errors"].append(f"06 click: {exc}")
        await page.wait_for_timeout(400)
        await shoot(page, "06_node_selected")

        # ---------- 08_sidebar_collapsed ----------
        print("08_sidebar_collapsed …")
        await fresh(page)
        # add a couple stages so the canvas isn't an empty drop-zone
        await add_via_dispatch(page, "palette-http-request")
        await add_via_dispatch(page, "palette-transform-map")
        await add_via_dispatch(page, "palette-output-passthrough")
        await page.wait_for_timeout(300)
        try:
            await page.evaluate(
                """() => {
                    const btn = document.querySelector('button[aria-label="Collapse sidebar"]');
                    if (!btn) throw new Error('collapse button missing');
                    btn.click();
                }"""
            )
            await page.wait_for_timeout(450)
        except Exception as exc:
            notes["errors"].append(f"08 collapse: {exc}")
        await shoot(page, "08_sidebar_collapsed",
                    clip={"x": 0, "y": 0, "width": 280, "height": 900})

        # ---------- 10_logic_editor ----------
        print("10_logic_editor …")
        await fresh(page)
        await add_via_dispatch(page, "palette-http-request")
        await add_via_dispatch(page, "palette-logic-switch")
        await add_via_dispatch(page, "palette-output-passthrough")
        await page.wait_for_timeout(400)
        try:
            await click_node(page, "node-logic-switch")
        except Exception as exc:
            notes["errors"].append(f"10 click: {exc}")
        await page.wait_for_timeout(400)
        await shoot(page, "10_logic_editor",
                    clip={"x": 1100, "y": 0, "width": 340, "height": 900})

        await browser.close()

    print("done")
    if notes["errors"]:
        print("ERRORS:")
        for e in notes["errors"]:
            print("  -", e)


if __name__ == "__main__":
    asyncio.run(main())

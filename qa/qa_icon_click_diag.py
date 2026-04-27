"""
Diagnostic: click the {·} icon as a user would (real Playwright click,
not JS-evaluate). Capture screenshots before/after, console errors, the
picker's visibility, and the focus state. The smoke harness uses
`icon.click()` which works; this exists to catch any divergence between
that and a true user click.
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
OUT = Path(__file__).parent / "artifacts" / "icon-diag"
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            reduced_motion="reduce",
        )
        page = await ctx.new_page()

        console_msgs: list[str] = []
        page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console_msgs.append(f"[pageerror] {e}"))

        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(400)

        # Add an upstream API call so the picker has scope to render.
        await page.evaluate(
            """() => {
                const btn = document.querySelector('[data-testid="palette-http-request"]');
                if (btn) btn.click();
            }"""
        )
        await page.wait_for_timeout(150)

        # Add Transform.
        await page.evaluate(
            """() => {
                const btn = document.querySelector('[data-testid="palette-transform-map"]');
                if (btn) btn.click();
            }"""
        )
        await page.wait_for_timeout(150)

        # Select Transform — JS click via data-node-id="TRANSFORM_1".
        await page.evaluate(
            """() => {
                const node = document.querySelector('[data-testid="node-transform-map"]');
                if (node) node.click();
            }"""
        )
        await page.wait_for_timeout(300)

        await page.screenshot(path=str(OUT / "01_transform_selected.png"))
        print("01 — Transform selected; properties panel should show ReferenceField")

        # Find the icon button using its title — same selector as the smoke.
        icon = page.locator('button[title^="Insert reference"]').first
        n = await icon.count()
        print(f"icon count = {n}")
        if n == 0:
            print("FAIL: icon not found")
            await browser.close()
            return 1

        # Inspect the button's bounding box and computed styles before clicking.
        info = await icon.evaluate(
            """(el) => {
                const r = el.getBoundingClientRect();
                const cs = window.getComputedStyle(el);
                return {
                    rect: {x: r.x, y: r.y, w: r.width, h: r.height},
                    pointerEvents: cs.pointerEvents,
                    display: cs.display,
                    visibility: cs.visibility,
                    opacity: cs.opacity,
                    zIndex: cs.zIndex,
                    parentTagName: el.parentElement?.tagName,
                    parentClass: el.parentElement?.className?.slice(0, 80),
                    grandparentTagName: el.parentElement?.parentElement?.tagName,
                };
            }"""
        )
        print(f"icon info: {info}")

        # Click as a real user — Playwright's .click() does an actual mouse down + up.
        await icon.click()
        await page.wait_for_timeout(300)

        await page.screenshot(path=str(OUT / "02_after_real_click.png"))
        picker = page.locator('[data-testid="ref-picker"]')
        opened = await picker.count() > 0
        print(f"after real click: picker visible = {opened}")

        if not opened:
            # Try a forced click in case actionability checks blocked.
            print("real click didn't open — trying force=True")
            await icon.click(force=True)
            await page.wait_for_timeout(300)
            opened2 = await picker.count() > 0
            print(f"after force click: picker visible = {opened2}")

        # If still not opened, click using mouse coordinates (bypasses any
        # event-target weirdness from React's synthetic event system).
        if not opened:
            print("trying explicit mouse click at icon center")
            await page.mouse.click(
                info["rect"]["x"] + info["rect"]["w"] / 2,
                info["rect"]["y"] + info["rect"]["h"] / 2,
            )
            await page.wait_for_timeout(300)
            opened3 = await picker.count() > 0
            print(f"after mouse coord click: picker visible = {opened3}")

        # Final state
        await page.screenshot(path=str(OUT / "03_final.png"))

        # Log any console errors / warnings.
        print("\n=== Console messages ===")
        for m in console_msgs[-30:]:
            print(f"  {m}")

        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

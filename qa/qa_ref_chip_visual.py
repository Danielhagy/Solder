"""
Visual capture of the new neon ref-chip rendering. Inserts two
references (one upstream-step, one trigger) and screenshots the field.
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
OUT = Path(__file__).parent / "artifacts" / "ref-chip-visual"
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            reduced_motion="reduce",
        )
        page = await ctx.new_page()

        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(400)

        for testid in ("palette-http-request", "palette-transform-map"):
            await page.evaluate(
                "(id) => { const b = document.querySelector(`[data-testid=\"${id}\"]`); if (b) b.click(); }",
                testid,
            )
            await page.wait_for_timeout(150)

        # Switch trigger to webhook for richer fields.
        await page.evaluate(
            "() => { const p = document.querySelector('[data-testid=\"trigger-pill-webhook\"]'); if (p) p.click(); }"
        )
        await page.wait_for_timeout(200)

        # Select Transform.
        await page.evaluate(
            "() => { const n = document.querySelector('[data-testid=\"node-transform-map\"]'); if (n) n.click(); }"
        )
        await page.wait_for_timeout(300)

        ta = page.locator('textarea[aria-label="Transform expression"]').first
        await ta.click()
        # Clear it first.
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.wait_for_timeout(80)

        # Compose: "userId = " + step ref + ", body = " + trigger ref
        await page.keyboard.type("userId = ")
        # Insert step ref via picker
        await page.keyboard.type("{")
        await page.wait_for_timeout(180)
        await page.locator('[data-testid^="ref-picker-step-"]').first.click()
        await page.wait_for_timeout(150)
        await page.locator('[data-testid="ref-picker-field-status_code"]').first.click()
        await page.wait_for_timeout(150)

        await page.keyboard.type(", body = ")
        await page.keyboard.type("{")
        await page.wait_for_timeout(180)
        await page.locator('[data-testid="ref-picker-trigger"]').click()
        await page.wait_for_timeout(150)
        await page.locator('[data-testid="ref-picker-field-body"]').click()
        await page.wait_for_timeout(150)

        await page.screenshot(path=str(OUT / "01_two_chips.png"))
        print("01 — two chips inserted:", await ta.input_value())

        # Click the first chip to inspect.
        await page.locator(".ref-chip").first.click()
        await page.wait_for_timeout(150)
        await page.screenshot(path=str(OUT / "02_inspect_popover.png"))
        print("02 — chip inspect popover")

        # Close popover via Esc, take a clean shot of the field.
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(120)
        # Crop-ish: focus the right-rail field area for a tight shot.
        rail = page.locator(".glass-rail").last
        if await rail.count():
            await rail.screenshot(path=str(OUT / "03_field_close.png"))
            print("03 — close-up captured")

        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

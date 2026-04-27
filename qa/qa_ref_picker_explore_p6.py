"""Targeted re-run of Probe 6 with the correct label selector."""
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
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "ref-picker-explore"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            reduced_motion="reduce",
        )
        page = await ctx.new_page()
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(300)

        async def add(palette_id: str):
            await page.evaluate(
                """(id) => { const b = document.querySelector(`[data-testid="${id}"]`); if (b) b.click(); }""",
                palette_id,
            )
            await page.wait_for_timeout(150)

        async def select(node_id: str):
            await page.evaluate(
                """(id) => { const n = document.querySelector(`[data-testid="${id}"]`); if (n) n.click(); }""",
                node_id,
            )
            await page.wait_for_timeout(200)

        await add("palette-http-request")
        await add("palette-transform-map")
        await select("node-http-request")

        long_label = "X" * 60 + " — Very Long Label For Visual Overflow 0123456789"
        # Properties panel label input — has placeholder "e.g. Fetch invoice"
        label_input = page.locator('input[placeholder="e.g. Fetch invoice"]').first
        cnt = await label_input.count()
        if cnt:
            await label_input.fill(long_label)
            await page.wait_for_timeout(200)
        # Now select Transform & open picker
        await select("node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        picker_box = await page.locator('[data-testid="ref-picker"]').first.bounding_box()
        # Find a button under STEPS containing "X" string
        long_btn = page.locator('[data-testid="ref-picker"] button', has_text="XXXXXXXXXX").first
        long_present = await long_btn.count()
        long_box = None
        long_text = None
        if long_present:
            long_box = await long_btn.bounding_box()
            long_text = await long_btn.inner_text()
        await page.screenshot(path=str(OUT / "06b_long_label.png"))
        # Also check if the long-label text overflows the picker container.
        out = {
            "label_input_present": cnt,
            "long_label_set": long_label,
            "picker_box": picker_box,
            "long_label_button_present": long_present,
            "long_label_button_box": long_box,
            "long_label_button_text": long_text,
            "overflows_picker": (
                long_box is not None
                and picker_box is not None
                and (long_box["x"] + long_box["width"]) > (picker_box["x"] + picker_box["width"] + 1)
            ),
        }
        (OUT / "p6_findings.json").write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
        print(json.dumps(out, indent=2, default=str))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

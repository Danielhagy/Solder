"""Probe 4 v3 — try forcing real same-stage parallelism via stage-tail dropzone."""
from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

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
            await page.wait_for_timeout(200)

        await add("palette-http-request")
        # The first add creates a node in stage 1. Now we want to drop a SECOND
        # http node into the SAME stage 1 (as a sibling slot). Drag from palette.
        palette_btn = page.locator('[data-testid="palette-http-request"]').first
        # Drop target: stage-1-tail (the slot at the end of stage 1).
        target = page.locator('[data-testid="stage-1-tail"]').first
        try:
            await palette_btn.drag_to(target, force=True)
            await page.wait_for_timeout(400)
        except Exception as e:
            print(f"drag failed: {e}")
        # Inspect resulting layout
        layout = await page.evaluate(
            """() => {
                const els = document.querySelectorAll('[data-testid^="node-"]');
                return Array.from(els).map(e => {
                    const r = e.getBoundingClientRect();
                    return { id: e.getAttribute('data-testid'), x: Math.round(r.x), y: Math.round(r.y) };
                });
            }"""
        )
        # Also: how many stage-* columns now?
        stage_cols = await page.evaluate(
            """() => {
                const els = document.querySelectorAll('[data-testid^="stage-column-"]');
                return Array.from(els).map(e => e.getAttribute('data-testid'));
            }"""
        )
        # Add a Transform downstream and open picker
        await add("palette-transform-map")
        await page.evaluate(
            """() => {
                const n = document.querySelector('[data-testid="node-transform-map"]');
                if (n) n.click();
            }"""
        )
        await page.wait_for_timeout(200)
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        step_row_info = await page.evaluate(
            """() => {
                const picker = document.querySelector('[data-testid="ref-picker"]');
                if (!picker) return null;
                const buttons = picker.querySelectorAll('button');
                const out = [];
                for (const b of buttons) {
                    const t = (b.innerText || '').trim();
                    if (/^[\\u25b8\\u25be]/.test(t)) {
                        out.push(t.replace(/\\n/g, ' | ').slice(0, 100));
                    }
                }
                return out;
            }"""
        )
        await page.screenshot(path=str(OUT / "04c_drag_to_stage_tail.png"))
        out = {"layout": layout, "stage_columns": stage_cols, "picker_step_rows": step_row_info}
        (OUT / "p4b_findings.json").write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
        print(json.dumps(out, indent=2, default=str))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

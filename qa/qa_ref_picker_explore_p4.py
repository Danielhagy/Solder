"""Probe 4 v2 — force two siblings on the same stage via UI 'New Stage' insertion path."""
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
            await page.wait_for_timeout(150)

        async def select(node_id: str):
            await page.evaluate(
                """(id) => { const n = document.querySelector(`[data-testid="${id}"]`); if (n) n.click(); }""",
                node_id,
            )
            await page.wait_for_timeout(200)

        # First, add an http node
        await add("palette-http-request")
        await page.wait_for_timeout(200)

        # Try to add second http to the SAME stage. Look at the canvas for
        # an "+ INSERT" button vs "+ NEW STAGE" button. Insert adds to same
        # stage as next node; we want to add as a sibling to stage 1.
        # Inspect available canvas drop targets.
        drop_targets = await page.evaluate(
            """() => {
                const els = document.querySelectorAll('[data-testid]');
                return Array.from(els).map(e => e.getAttribute('data-testid')).filter(t => t && (t.includes('insert') || t.includes('stage') || t.includes('drop') || t.includes('slot') || t.includes('add')));
            }"""
        )
        # Add second http node — by default it appends as a new stage.
        await add("palette-http-request")
        await page.wait_for_timeout(200)

        # Check the resulting node layout
        nodes_layout_before = await page.evaluate(
            """() => {
                // Find all canvas nodes via data-testid
                const els = document.querySelectorAll('[data-testid^="node-"]');
                return Array.from(els).map(e => {
                    const r = e.getBoundingClientRect();
                    return { id: e.getAttribute('data-testid'), x: Math.round(r.x), y: Math.round(r.y) };
                });
            }"""
        )
        # Try to drag node 2 onto stage 1's slot via mouse drag.
        # Selectors: node-http-request appears twice (last wins). Use distinct attribute.
        node_ids = [d["id"] for d in nodes_layout_before]
        # Per Solder's testid scheme, only one node-http-request testid maps to canvas;
        # if both share it, Playwright's first/nth matters.
        # Try direct store dispatch: look for window-exposed setter.
        store_keys = await page.evaluate(
            """() => {
                return Object.keys(window).filter(k => k.toLowerCase().includes('solder') || k.toLowerCase().includes('store'));
            }"""
        )

        # We'll bypass and check picker behaviour with whatever layout we got.
        # If sequential, picker should still show BOTH.
        await add("palette-transform-map")
        await select("node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        # Count number of step rows under "Steps" — they're toggleable buttons with stage tags.
        step_row_info = await page.evaluate(
            """() => {
                const picker = document.querySelector('[data-testid="ref-picker"]');
                if (!picker) return null;
                // Step rows are buttons that render their stage number with `01`, `02`, etc.
                const buttons = picker.querySelectorAll('button');
                const out = [];
                for (const b of buttons) {
                    const t = b.innerText || '';
                    // Match step rows: contain a 2-digit stage and a node label
                    if (/^\\s*[\\u25b8\\u25be]/.test(t)) {
                        out.push(t.replace(/\\n/g, ' | ').slice(0, 120));
                    }
                }
                return out;
            }"""
        )
        await page.screenshot(path=str(OUT / "04b_two_siblings.png"))
        out = {
            "drop_targets": drop_targets,
            "store_keys": store_keys,
            "node_layout": nodes_layout_before,
            "picker_step_rows": step_row_info,
        }
        (OUT / "p4_findings.json").write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
        print(json.dumps(out, indent=2, default=str))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

"""
Verifies the new human-readable step IDs:
  - First API call gets `API_1`, second `API_2`, etc.
  - First filter inside a Loop body gets `FILTER_1_LEV1` even when there's
    a top-level filter that already claimed `FILTER_1`.
  - Codes are scoped per (level, kind) — siblings at different scopes
    don't collide.

Run: python qa/qa_step_id_codes.py
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


async def add(page, testid: str) -> None:
    await page.evaluate(
        """(id) => {
            const btn = document.querySelector(`[data-testid="${id}"]`);
            if (btn) btn.click();
        }""",
        testid,
    )
    await page.wait_for_timeout(150)


async def step_into(page) -> None:
    """Click the first step-into button visible on the canvas."""
    await page.evaluate(
        """() => {
            const btn = document.querySelector('[data-testid^="step-into-"]');
            if (btn) btn.click();
        }"""
    )
    await page.wait_for_timeout(400)


async def get_node_ids(page) -> list[str]:
    """Read all `data-node-id` values currently in the DOM."""
    return await page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-node-id]')).map(el => el.getAttribute('data-node-id'))"""
    )


async def main() -> int:
    failures: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            reduced_motion="reduce",
        )
        page = await ctx.new_page()

        # ============================================================
        # 1. Multi-instance counting at root level
        # ============================================================
        print("[1] Multi-instance counting at root: API_1, API_2, FILTER_1")
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(300)
        await add(page, "palette-http-request")
        await add(page, "palette-http-request")
        await add(page, "palette-data-filter")
        ids = await get_node_ids(page)
        print(f"  ids = {ids}")
        if "API_1" in ids and "API_2" in ids and "FILTER_1" in ids:
            print("  PASS")
        else:
            failures.append(f"[1] expected API_1, API_2, FILTER_1 — got {ids}")
            print("  FAIL")

        # ============================================================
        # 2. _LEV1 suffix inside a Loop body, counter restarts
        #    (canvas only shows the active scope's nodes, so we verify
        #    each scope separately by stepping in/out)
        # ============================================================
        print("\n[2] Inside Loop body: FILTER_1_LEV1 even when FILTER_1 exists at root")
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(300)
        # Top-level: filter, loop
        await add(page, "palette-data-filter")
        await add(page, "palette-logic-loop")
        # Verify root has FILTER_1 + LOOP_1
        root_ids = await get_node_ids(page)
        print(f"  root ids = {root_ids}")
        ok_root = "FILTER_1" in root_ids and "LOOP_1" in root_ids
        # Step into the Loop body and add a filter
        await step_into(page)
        await add(page, "palette-data-filter")
        body_ids = await get_node_ids(page)
        print(f"  body ids = {body_ids}")
        ok_body = "FILTER_1_LEV1" in body_ids
        if ok_root and ok_body:
            print("  PASS — root FILTER_1 + LOOP_1, body FILTER_1_LEV1")
        else:
            failures.append(
                f"[2] expected root FILTER_1+LOOP_1 and body FILTER_1_LEV1 — got root={root_ids} body={body_ids}"
            )
            print("  FAIL")

        # ============================================================
        # 3. Two filters at LEV1 = FILTER_1_LEV1, FILTER_2_LEV1
        # ============================================================
        print("\n[3] Multi-instance at LEV1: FILTER_1_LEV1, FILTER_2_LEV1")
        # Continuing from step 2 — add another filter inside the loop.
        await add(page, "palette-data-filter")
        ids = await get_node_ids(page)
        print(f"  ids = {ids}")
        if "FILTER_1_LEV1" in ids and "FILTER_2_LEV1" in ids:
            print("  PASS")
        else:
            failures.append(f"[3] expected FILTER_1_LEV1 + FILTER_2_LEV1 — got {ids}")
            print("  FAIL")

        # ============================================================
        # 4. Picker token format uses the new code
        # ============================================================
        print("\n[4] Picker token uses new code")
        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(300)
        await add(page, "palette-http-request")
        await add(page, "palette-transform-map")
        # Select Transform
        await page.evaluate(
            """() => {
                const node = document.querySelector('[data-testid="node-transform-map"]');
                if (node) node.click();
            }"""
        )
        await page.wait_for_timeout(300)
        field = page.locator('[aria-label="Transform expression"]').first
        await field.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        body_leaf = page.locator('[data-testid="ref-picker"]').locator("button", has_text="body").first
        if await body_leaf.count():
            await body_leaf.click()
            await page.wait_for_timeout(150)
            val = await field.input_value()
            print(f"  token = {val!r}")
            if val == "{{$.steps.API_1.output.body}}":
                print("  PASS — exact match on canonical token")
            else:
                failures.append(f"[4] expected '{{{{$.steps.API_1.output.body}}}}', got {val!r}")
                print("  FAIL")
        else:
            failures.append("[4] body leaf not visible")
            print("  FAIL — leaf missing")

        await browser.close()

    print()
    print("=" * 50)
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("All step-id checks PASS.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

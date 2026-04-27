"""
Smoke test the new Run Plan interactions:
  1. The right rail shows a Run Plan with a ▶ Test button at the top
  2. Single click on a row focuses the node (selects it + scrolls into
     view); the rail switches to the per-node editor
  3. Click-and-hold + drag over rows builds a selection set; Test label
     reflects the count
  4. Clear button resets the selection

Output: qa/artifacts/run-plan/
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
OUT = Path(__file__).parent / "artifacts" / "run-plan"
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> int:
    failures: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            reduced_motion="reduce",
        )
        page = await ctx.new_page()

        page.on("pageerror", lambda e: failures.append(f"pageerror: {e}"))

        await page.goto(BUILDER, wait_until="networkidle")
        await page.wait_for_timeout(400)

        # Build a small plan: API Call + Transform + another Transform.
        for testid in ("palette-http-request", "palette-transform-map", "palette-transform-map"):
            await page.evaluate(
                "(id) => { const b = document.querySelector(`[data-testid=\"${id}\"]`); if (b) b.click(); }",
                testid,
            )
            await page.wait_for_timeout(150)

        # Make sure no node is selected — the Run Plan only shows when
        # `selectedNodeId` is null.
        await page.evaluate("() => { document.body.click(); }")
        await page.wait_for_timeout(150)

        await page.screenshot(path=str(OUT / "01_run_plan_default.png"))
        print("01 — base run plan rendered")

        # ============================================================
        # Test button visible at the top of the run plan.
        # ============================================================
        test_btn = page.locator('[data-testid="run-plan-test-button"]')
        if not await test_btn.count():
            failures.append("Test button missing from Run Plan header")
            print("  FAIL: Test button absent")
            await browser.close()
            return 1
        print("  OK: Test button present")
        if (await test_btn.get_attribute("data-selected-count")) != "0":
            failures.append("Default selection count should be 0")

        # ============================================================
        # Drag-select two rows: mousedown on first, mouseenter on second.
        # ============================================================
        rows = page.locator('[data-testid^="run-plan-row-"]')
        n = await rows.count()
        if n < 2:
            failures.append(f"Expected ≥2 run plan rows, got {n}")
            await browser.close()
            return 1

        first = rows.nth(0)
        second = rows.nth(1)
        f_box = await first.bounding_box()
        s_box = await second.bounding_box()
        assert f_box and s_box, "missing bounding boxes"

        await page.mouse.move(f_box["x"] + f_box["width"] / 2, f_box["y"] + f_box["height"] / 2)
        await page.mouse.down()
        # Drag to second row.
        await page.mouse.move(
            s_box["x"] + s_box["width"] / 2,
            s_box["y"] + s_box["height"] / 2,
            steps=12,
        )
        await page.wait_for_timeout(80)
        await page.mouse.up()
        await page.wait_for_timeout(120)
        await page.screenshot(path=str(OUT / "02_after_drag_select.png"))

        # The button should now show count >= 2.
        sel_count_attr = await test_btn.get_attribute("data-selected-count")
        try:
            sel_count = int(sel_count_attr or "0")
        except ValueError:
            sel_count = 0
        if sel_count < 2:
            failures.append(f"Expected ≥2 selected, got {sel_count}")
            print(f"  FAIL: drag selection count = {sel_count}")
        else:
            print(f"  OK: drag selected {sel_count} rows")

        # The label should include the parenthesized count.
        label = (await test_btn.inner_text()).strip()
        if f"({sel_count})" not in label:
            failures.append(f"Test label doesn't reflect count: {label!r}")

        # Clear selection.
        clear = page.locator('[data-testid="run-plan-clear-selection"]')
        if not await clear.count():
            failures.append("Clear-selection button missing while selection active")
        else:
            await clear.click()
            await page.wait_for_timeout(120)
            sel_count_after = await test_btn.get_attribute("data-selected-count")
            if sel_count_after != "0":
                failures.append(f"After clear, selection count = {sel_count_after}")
            else:
                print("  OK: clear resets selection to 0")

        # ============================================================
        # Checkbox toggle — independent of drag. Click checkbox on row 0
        # to add it to selection; click again to remove.
        # ============================================================
        rows = page.locator('[data-testid^="run-plan-row-"]')
        first_id = (
            await rows.nth(0).get_attribute("data-testid") or ""
        ).removeprefix("run-plan-row-")
        cb = page.locator(f'[data-testid="run-plan-checkbox-{first_id}"]')
        if not await cb.count():
            failures.append("Per-row checkbox missing")
        else:
            await cb.click()
            await page.wait_for_timeout(120)
            sc = await test_btn.get_attribute("data-selected-count")
            if sc != "1":
                failures.append(f"Checkbox click expected count 1, got {sc!r}")
            else:
                print("  OK: checkbox click sets selection to 1")

            stage_glow = await page.locator(
                "[data-testid='run-plan-body'] [data-stage-selected]"
            ).count()
            if stage_glow < 1:
                failures.append("Stage card did not glow when row selected")
            else:
                print(f"  OK: {stage_glow} stage card(s) glowing")
            await page.screenshot(path=str(OUT / "07_stage_glow.png"))

            await cb.click()
            await page.wait_for_timeout(120)
            sc2 = await test_btn.get_attribute("data-selected-count")
            if sc2 != "0":
                failures.append(f"Second checkbox click expected count 0, got {sc2!r}")
            else:
                print("  OK: checkbox click again clears selection")

        # ============================================================
        # Stage-card click target — clicking on the stage label area
        # (not the row line itself) should still select the lone node.
        # ============================================================
        rows = page.locator('[data-testid^="run-plan-row-"]')
        first_id = (
            await rows.nth(0).get_attribute("data-testid") or ""
        ).removeprefix("run-plan-row-")
        # The stage card is the parent of the run plan body's children
        # — locate it by its descendant row.
        stage_card = page.locator(
            f"[data-testid='run-plan-body'] > div:has([data-testid='run-plan-row-{first_id}'])"
        ).first
        sc_box = await stage_card.bounding_box()
        # Click in the upper-left of the card (where the stage number "01"
        # lives, deliberately above the row line).
        if sc_box:
            await page.mouse.click(sc_box["x"] + 16, sc_box["y"] + 8)
            await page.wait_for_timeout(200)
            # Should have selected the lone node, switching the rail.
            still_run_plan = await page.locator(
                '[data-testid="run-plan-test-button"]'
            ).count()
            if still_run_plan:
                failures.append(
                    "Click on stage card padding did not select the node"
                )
                print("  FAIL: card-padding click ignored")
            else:
                print("  OK: card-padding click selects node + opens editor")
                # Re-clear: trigger the same store action the canvas's
                # background-click handler would, so the rail returns
                # to the Run Plan view for the next test.
                await page.evaluate(
                    "() => { try { window.__zustand?.getState?.().selectNode?.(null); } catch (e) {} }"
                )
                # Fallback: click on the embers/canvas background area
                # via a bbox-derived center point.
                await page.mouse.click(640, 600)
                await page.wait_for_timeout(200)

        # ============================================================
        # Single tap on a row → switches right rail to per-node editor.
        # The Run Plan rail disappears (becomes the node editor); the
        # canvas card with that data-node-id should be visible.
        # ============================================================
        rows = page.locator('[data-testid^="run-plan-row-"]')
        # Read the first row's id from its data-testid before tapping —
        # the rail re-renders and the locator becomes stale otherwise.
        first_id = (
            await rows.nth(0).get_attribute("data-testid") or ""
        ).removeprefix("run-plan-row-")
        if not first_id:
            failures.append("Could not derive node id from row testid")
        else:
            f_box = await rows.nth(0).bounding_box()
            assert f_box
            cx = f_box["x"] + f_box["width"] / 2
            cy = f_box["y"] + f_box["height"] / 2
            # Plain click — no drag.
            await page.mouse.click(cx, cy)
            await page.wait_for_timeout(250)
            await page.screenshot(path=str(OUT / "03_after_tap.png"))

            # The right rail should now be the per-node editor — Run Plan
            # rail data-testid is gone; node-test-button (per-node Test) is
            # present.
            if await page.locator('[data-testid="run-plan-test-button"]').count():
                failures.append("Run Plan still rendered after tap")
            else:
                print("  OK: run plan replaced by node editor on tap")

            # The canvas card should still exist.
            if not await page.locator(f'[data-node-id="{first_id}"]').count():
                failures.append(f"Canvas card for {first_id} missing after tap")
            else:
                print(f"  OK: canvas card for {first_id} present")

        await browser.close()

    print("\n" + "=" * 50)
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("All run-plan smoke checks PASS.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

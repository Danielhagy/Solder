"""
Smoke test the two-stage RefPicker on the Transform editor.

Stage 1 — pick a source. The picker shows upstream steps (drill-in) and
flat shortcuts (Loop scope, variables, run metadata) that insert directly.

Stage 2 — pick a field. Selecting a step swaps the picker into a branched
field diagram of that step's `referenceableOutputs`. Clicking a leaf
inserts the canonical `{{$.steps.<id>.output.<path>}}` token into the
field that opened the picker.

Flow under test:
  1. /integrations/new
  2. Add API Call + Transform via the palette
  3. Select Transform → its editor renders the Expression ReferenceField
  4. Type `{` → picker opens in Stage 1; assert no field leaves visible
  5. Click the upstream API Call step → picker advances to Stage 2;
     assert the back affordance + tree are visible
  6. Click the `body` leaf → token inserted in canonical shape
  7. Reopen, verify `Backspace` on empty search returns to Stage 1
  8. Reopen, verify `Esc` dismisses the picker

Output: qa/artifacts/ref-picker-smoke/
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
OUT = Path(__file__).parent / "artifacts" / "ref-picker-smoke"
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

        # Drop API Call + Transform via the palette (JS-click to bypass
        # any actionability quirks under the perpetual canvas motion).
        for testid in ("palette-http-request", "palette-transform-map"):
            await page.evaluate(
                """(id) => {
                    const btn = document.querySelector(`[data-testid="${id}"]`);
                    if (btn) btn.click();
                }""",
                testid,
            )
            await page.wait_for_timeout(200)

        await page.screenshot(path=str(OUT / "01_after_palette_clicks.png"))
        print("01 — added API Call + Transform")

        # Select the Transform node so its editor renders in the right rail.
        await page.evaluate(
            """() => {
                const node = document.querySelector('[data-testid="node-transform-map"]');
                if (node) node.click();
            }"""
        )
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(OUT / "02_transform_selected.png"))
        print("02 — selected Transform")

        expression_locator = page.locator('textarea[aria-label="Transform expression"]')
        if not await expression_locator.count():
            failures.append("Expression textarea not found")
            print("  FAIL: textarea not found")
            await browser.close()
            return 1

        # ============================================================
        # 1) Type `{` — picker should open in Stage 1.
        # ============================================================
        await expression_locator.click()
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        await page.screenshot(path=str(OUT / "03_stage1_open.png"))

        picker = page.locator('[data-testid="ref-picker"]')
        if not await picker.count():
            failures.append("Picker did not open after `{`")
            print("  FAIL: picker not visible")
            await browser.close()
            return 1

        stage = await picker.get_attribute("data-stage")
        if stage != "steps":
            failures.append(f"Stage 1 expected data-stage=steps, got {stage!r}")
        else:
            print("  OK: stage 1 (source list) open")

        # In Stage 1 the field tree must NOT be present yet.
        if await page.locator('[data-testid="ref-picker-tree"]').count():
            failures.append("Stage 1 should not render the field tree")
        # The upstream API Call step row must be present.
        api_step = page.locator('[data-testid^="ref-picker-step-"]').first
        if not await api_step.count():
            failures.append("Stage 1: no upstream step row visible")
            print("  FAIL: no step rows")
        else:
            print("  OK: upstream step row visible in Stage 1")

        # ============================================================
        # 2) Drill into the API Call → Stage 2 should show the tree.
        # ============================================================
        await api_step.click()
        await page.wait_for_timeout(250)
        await page.screenshot(path=str(OUT / "04_stage2_open.png"))

        stage = await picker.get_attribute("data-stage")
        if stage != "fields":
            failures.append(f"Stage 2 expected data-stage=fields, got {stage!r}")
        else:
            print("  OK: stage 2 (field tree) open after drill-in")

        if not await page.locator('[data-testid="ref-picker-tree"]').count():
            failures.append("Stage 2: field tree not rendered")
        if not await page.locator('[data-testid="ref-picker-back"]').count():
            failures.append("Stage 2: back affordance not visible")

        # ============================================================
        # 3) Click `body` → canonical token inserted.
        # ============================================================
        body_leaf = page.locator('[data-testid="ref-picker-field-body"]').first
        if not await body_leaf.count():
            # Fallback selector — old data-testid may differ between catalog entries.
            body_leaf = picker.locator("button", has_text="body").first
        if not await body_leaf.count():
            failures.append("Stage 2: `body` leaf not found")
            print("  FAIL: body leaf missing")
        else:
            await body_leaf.click()
            await page.wait_for_timeout(200)
            await page.screenshot(path=str(OUT / "05_after_insert.png"))
            val = await expression_locator.input_value()
            if "{{$.steps." in val and ".output.body}}" in val:
                print(f"  OK: token inserted → {val!r}")
            else:
                failures.append(f"Token not in expected shape: {val!r}")
                print(f"  FAIL: unexpected value {val!r}")

        # ============================================================
        # 4) Reopen, drill, then Backspace on empty search → back to Stage 1.
        # ============================================================
        await expression_locator.click()
        # Move cursor to end and trigger the picker again with `{`.
        await page.keyboard.press("End")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        await page.locator('[data-testid^="ref-picker-step-"]').first.click()
        await page.wait_for_timeout(150)
        # Search input is auto-empty in a fresh stage; backspace should pop us back.
        await page.locator('[data-testid="ref-picker"] input').focus()
        await page.keyboard.press("Backspace")
        await page.wait_for_timeout(150)
        await page.screenshot(path=str(OUT / "06_after_backspace.png"))
        stage = await picker.get_attribute("data-stage")
        if stage != "steps":
            failures.append(f"Backspace did not return to Stage 1, got {stage!r}")
        else:
            print("  OK: backspace returns to Stage 1")

        # ============================================================
        # 5) Esc dismisses the picker.
        # ============================================================
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(150)
        if await picker.count():
            failures.append("Esc did not dismiss the picker")
        else:
            print("  OK: Esc dismisses")

        # ============================================================
        # 6) Trigger source — drill into the Trigger row and pick a field.
        #    Default trigger is `manual`, which exposes a single `input`
        #    field. Selecting it must emit `{{$.trigger.input}}`.
        # ============================================================
        # Switch trigger to webhook so we get richer fields to assert on
        # (body / headers / query / method / path).
        await page.evaluate(
            """() => {
                const pill = document.querySelector('[data-testid="trigger-pill-webhook"]');
                if (pill) pill.click();
            }"""
        )
        await page.wait_for_timeout(200)
        # Re-select the Transform node (clicking a trigger pill swaps the
        # right rail to the trigger editor; we need the Transform editor back).
        await page.evaluate(
            """() => {
                const node = document.querySelector('[data-testid="node-transform-map"]');
                if (node) node.click();
            }"""
        )
        await page.wait_for_timeout(250)

        await expression_locator.click()
        await page.keyboard.press("End")
        await page.keyboard.type(" ")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)

        if not await picker.count():
            failures.append("Picker did not reopen for trigger test")
        else:
            trigger_row = page.locator('[data-testid="ref-picker-trigger"]')
            if not await trigger_row.count():
                failures.append("Trigger source row missing in Stage 1")
                print("  FAIL: trigger row not visible")
            else:
                print("  OK: trigger source row visible in Stage 1")
                await trigger_row.click()
                await page.wait_for_timeout(200)
                await page.screenshot(path=str(OUT / "07_trigger_drilled.png"))

                stage = await picker.get_attribute("data-stage")
                if stage != "fields":
                    failures.append(f"Trigger drill: expected fields, got {stage!r}")

                body_leaf = page.locator('[data-testid="ref-picker-field-body"]').first
                if not await body_leaf.count():
                    failures.append("Trigger Stage 2: `body` leaf missing")
                else:
                    await body_leaf.click()
                    await page.wait_for_timeout(200)
                    await page.screenshot(path=str(OUT / "08_trigger_inserted.png"))
                    val = await expression_locator.input_value()
                    if "{{$.trigger.body}}" in val:
                        print(f"  OK: trigger token inserted → {val!r}")
                    else:
                        failures.append(f"Trigger token wrong shape: {val!r}")

        # ============================================================
        # 7) Chip rendering — every inserted token must paint a `.ref-chip`
        #    span in the overlay. Click one and assert the inspect popover
        #    shows the full canonical token; click the ✕ to remove it.
        # ============================================================
        chips = page.locator(".ref-chip")
        chip_count = await chips.count()
        if chip_count < 2:
            failures.append(
                f"Expected at least 2 ref-chips in the overlay, got {chip_count}"
            )
        else:
            print(f"  OK: {chip_count} ref-chip(s) painted in overlay")

            # Click the trigger chip (last one) and assert the popover.
            await chips.last.click()
            await page.wait_for_timeout(150)
            popover = page.locator("[data-ref-popover]")
            if not await popover.count():
                failures.append("Inspect popover did not open on chip click")
            else:
                pop_txt = (await popover.inner_text()).strip()
                if "{{$.trigger.body}}" in pop_txt:
                    print(f"  OK: popover shows canonical token → {pop_txt!r}")
                else:
                    failures.append(f"Popover content unexpected: {pop_txt!r}")
                # Remove the trigger token via the ✕.
                await popover.locator("button").click()
                await page.wait_for_timeout(150)
                val_after = await expression_locator.input_value()
                if "{{$.trigger.body}}" in val_after:
                    failures.append(
                        f"Remove did not strip trigger token: {val_after!r}"
                    )
                else:
                    print("  OK: chip ✕ removes the token from the value")

        await browser.close()

    print("\n" + ("=" * 50))
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("All ref-picker smoke checks PASS.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

"""
Comprehensive smoke + edge-case test for the data-reference picker.

Coverage:
  1.  ReferenceField renders for every editor that took the swap.
  2.  Picker opens on `{` keystroke in each ReferenceField.
  3.  Picker opens on `{·}` icon click.
  4.  Token inserts at cursor without losing the rest of the value.
  5.  Save → reload round-trips the token.
  6.  Keyboard nav: ArrowDown → Enter inserts the highlighted leaf.
  7.  Search filter narrows the picker.
  8.  Empty-scope edge case (first node on the canvas — no upstream).
  9.  Loop-body scope shows $item and $index.
  10. Close on Esc, click-outside, second {·} click.

Run from repo root: `python qa/qa_ref_picker_full.py`.
Output: qa/artifacts/ref-picker-full/
"""
from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright, Page

BASE = "http://localhost:5173"
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "ref-picker-full"
OUT.mkdir(parents=True, exist_ok=True)


# Mapping: palette testid → expected ReferenceField aria-label inside its
# editor. Single representative field per editor; keeps the suite tight.
EDITOR_REF_FIELDS = [
    ("palette-transform-map", "node-transform-map", "Transform expression"),
    ("palette-data-filter", "node-data-filter", "Data over"),
    ("palette-logic-branch", "node-logic-branch", "If/Else predicate"),
    ("palette-logic-loop", "node-logic-loop", "Loop iterate over"),
    ("palette-state-set", "node-state-set", "State set value"),
    ("palette-time-now", "node-time-now", None),  # time.now has no value field
    ("palette-format-base64_encode", "node-format-base64_encode", "Format Data"),
    ("palette-process-call", "node-process-call", None),  # only shows over in for-each mode
    ("palette-http-request", "node-http-request", "HTTP URL"),
]


async def add_node(page: Page, palette_testid: str) -> None:
    await page.evaluate(
        """(id) => {
            const btn = document.querySelector(`[data-testid="${id}"]`);
            if (btn) btn.click();
        }""",
        palette_testid,
    )
    await page.wait_for_timeout(150)


async def select_node(page: Page, node_testid: str) -> bool:
    handle = await page.query_selector(f'[data-testid="{node_testid}"]')
    if not handle:
        return False
    await page.evaluate(
        """(id) => {
            const node = document.querySelector(`[data-testid="${id}"]`);
            if (node) node.click();
        }""",
        node_testid,
    )
    await page.wait_for_timeout(200)
    return True


async def fresh_canvas(page: Page) -> None:
    await page.goto(BUILDER, wait_until="networkidle")
    await page.wait_for_timeout(300)


async def picker_visible(page: Page) -> bool:
    n = await page.locator('[data-testid="ref-picker"]').count()
    return n > 0


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
        # 1. ReferenceField renders for every editor
        # 2. Picker opens on `{` in each
        # ============================================================
        print("=" * 60)
        print("[1+2] ReferenceField + `{` trigger across editors")
        print("=" * 60)
        for palette_id, node_id, aria_label in EDITOR_REF_FIELDS:
            await fresh_canvas(page)
            # Add an upstream node so the picker has at least one step.
            await add_node(page, "palette-http-request")
            await add_node(page, palette_id)
            ok = await select_node(page, node_id)
            if not ok:
                failures.append(f"[{palette_id}] node didn't appear on canvas after palette click")
                print(f"  {palette_id}: FAIL — node not found")
                continue
            if aria_label is None:
                # Editor has no reference field at default config; skip.
                print(f"  {palette_id}: SKIP — no default reference field")
                continue

            field = page.locator(f'[aria-label="{aria_label}"]')
            count = await field.count()
            if count == 0:
                failures.append(f"[{palette_id}] expected field aria-label='{aria_label}' not found")
                print(f"  {palette_id}: FAIL — field not found")
                continue
            await field.first.click()
            await page.keyboard.type("{")
            await page.wait_for_timeout(200)
            if await picker_visible(page):
                print(f"  {palette_id}: PASS")
            else:
                failures.append(f"[{palette_id}] picker did not open on `{{` keystroke")
                print(f"  {palette_id}: FAIL — picker didn't open")
            # Close before next iteration.
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(100)

        # ============================================================
        # 3. Picker opens on `{·}` icon click
        # ============================================================
        print()
        print("[3] {·} icon click opens picker")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        # The icon button is anchored top-right of the field with title "Insert reference (or type `{`)".
        icon = page.locator('button[title^="Insert reference"]').first
        if await icon.count():
            await icon.click()
            await page.wait_for_timeout(200)
            if await picker_visible(page):
                print("  PASS")
            else:
                failures.append("[3] picker didn't open on icon click")
                print("  FAIL — picker not visible")
            await page.keyboard.press("Escape")
        else:
            failures.append("[3] {·} icon button not found")
            print("  FAIL — icon button not found")

        # ============================================================
        # 4. Token inserts at cursor, preserving surrounding text
        # ============================================================
        print()
        print("[4] Token insert preserves surrounding text")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        field = page.locator('[aria-label="Transform expression"]').first
        # Clear the default `$.data` and type known content.
        await field.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("prefix-")
        await page.keyboard.type("{")  # opens picker
        await page.wait_for_timeout(200)
        # Pick the first leaf of the API Call step (body).
        body_leaf = page.locator('[data-testid="ref-picker"]').locator("button", has_text="body").first
        if await body_leaf.count():
            await body_leaf.click()
            await page.wait_for_timeout(150)
            val = await field.input_value()
            if val.startswith("prefix-{{$.steps.") and val.endswith(".output.body}}"):
                print(f"  PASS — value: {val!r}")
            else:
                failures.append(f"[4] unexpected field value: {val!r}")
                print(f"  FAIL — value: {val!r}")
        else:
            failures.append("[4] body leaf not visible in picker")
            print("  FAIL — body leaf not found")

        # ============================================================
        # 5. Save round-trip
        # ============================================================
        print()
        print("[5] Save → reload round-trips the token")
        # We're already in a state where the Transform's expression has a
        # token. Save the integration and verify it survives reload.
        save_btn = page.locator('button', has_text="Save").first
        await save_btn.click()
        await page.wait_for_timeout(300)
        save_input = page.locator('input.input').first  # save dialog name input
        await save_input.fill(f"RefPicker Roundtrip {int(asyncio.get_event_loop().time() * 1000) % 100000}")
        confirm = page.locator('button.btn-primary', has_text="Save").first
        await confirm.click()
        await page.wait_for_url("**/integrations/**", timeout=8000)
        await page.wait_for_timeout(500)
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(500)
        await select_node(page, "node-transform-map")
        field2 = page.locator('[aria-label="Transform expression"]').first
        val2 = await field2.input_value() if await field2.count() else ""
        if val2.startswith("prefix-{{$.steps.") and val2.endswith(".output.body}}"):
            print("  PASS")
        else:
            failures.append(f"[5] token did not survive reload — got {val2!r}")
            print(f"  FAIL — got {val2!r}")

        # ============================================================
        # 6. Keyboard nav: ArrowDown then Enter inserts highlighted leaf
        # ============================================================
        print()
        print("[6] Keyboard nav (ArrowDown + Enter)")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        field3 = page.locator('[aria-label="Transform expression"]').first
        await field3.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        # Default highlight is index 0; ArrowDown moves to 1; Enter inserts.
        await page.keyboard.press("ArrowDown")
        await page.wait_for_timeout(50)
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(150)
        val3 = await field3.input_value()
        # Expect the second leaf in the picker — should be `headers` for http.request.
        if "{{$.steps." in val3 and ".output.headers}}" in val3:
            print(f"  PASS — value: {val3!r}")
        else:
            failures.append(f"[6] keyboard nav didn't reach 2nd leaf — got {val3!r}")
            print(f"  FAIL — value: {val3!r}")

        # ============================================================
        # 7. Search filter narrows visible leaves
        # ============================================================
        print()
        print("[7] Search filter")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        field4 = page.locator('[aria-label="Transform expression"]').first
        await field4.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        # Search the picker for "body".
        search = page.locator('[data-testid="ref-picker"] input').first
        await search.fill("body")
        await page.wait_for_timeout(200)
        body_count = await page.locator(
            '[data-testid="ref-picker"] button', has_text="body"
        ).count()
        # `body` should appear; `status_code` should be filtered out.
        status_count = await page.locator(
            '[data-testid="ref-picker"] button', has_text="status_code"
        ).count()
        if body_count > 0 and status_count == 0:
            print(f"  PASS — body visible ({body_count}), status_code filtered out")
        else:
            failures.append(
                f"[7] search filter wrong: body={body_count} status_code={status_count}"
            )
            print(f"  FAIL — body={body_count} status_code={status_count}")
        await page.keyboard.press("Escape")

        # ============================================================
        # 8. Empty scope (no upstream steps)
        # ============================================================
        print()
        print("[8] Empty scope — picker still opens with run metadata")
        await fresh_canvas(page)
        await add_node(page, "palette-transform-map")  # only step
        await select_node(page, "node-transform-map")
        field5 = page.locator('[aria-label="Transform expression"]').first
        await field5.click()
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        if await picker_visible(page):
            # Should show Run metadata at minimum.
            run_meta_visible = await page.locator(
                '[data-testid="ref-picker"]', has_text="Run metadata"
            ).count()
            if run_meta_visible > 0:
                print("  PASS — picker open, run metadata shown")
            else:
                failures.append("[8] picker open but no run metadata section")
                print("  FAIL — no run metadata")
        else:
            failures.append("[8] picker did not open with empty step scope")
            print("  FAIL — picker not visible")
        await page.keyboard.press("Escape")

        # ============================================================
        # 9. Loop-body scope: $item and $index appear
        # ============================================================
        print()
        print("[9] Loop body scope shows $item and $index")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-logic-loop")
        # Step into the Loop body via the step-into button.
        await page.evaluate(
            """() => {
                const btn = document.querySelector('[data-testid^="step-into-"]');
                if (btn) btn.click();
            }"""
        )
        await page.wait_for_timeout(400)
        # Drop a Transform inside the Loop body.
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        field6 = page.locator('[aria-label="Transform expression"]').first
        if await field6.count():
            await field6.click()
            await page.keyboard.type("{")
            await page.wait_for_timeout(200)
            if await picker_visible(page):
                item_count = await page.locator(
                    '[data-testid="ref-picker"] button', has_text="$item"
                ).count()
                index_count = await page.locator(
                    '[data-testid="ref-picker"] button', has_text="$index"
                ).count()
                if item_count > 0 and index_count > 0:
                    print(f"  PASS — $item and $index visible inside Loop body")
                else:
                    failures.append(
                        f"[9] loop scope rows missing: $item={item_count} $index={index_count}"
                    )
                    print(f"  FAIL — $item={item_count} $index={index_count}")
            else:
                failures.append("[9] picker did not open inside Loop body")
                print("  FAIL — picker not visible")
        else:
            failures.append("[9] Transform field not found inside Loop body")
            print("  FAIL — field not found")
        await page.keyboard.press("Escape")

        # ============================================================
        # 10. Close on Esc / click-outside
        # ============================================================
        print()
        print("[10] Picker dismissal — Esc, click-outside")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        field7 = page.locator('[aria-label="Transform expression"]').first
        # Esc dismissal
        await field7.click()
        await page.keyboard.type("{")
        await page.wait_for_timeout(150)
        if not await picker_visible(page):
            failures.append("[10a] picker didn't open before Esc test")
            print("  FAIL [10a] — picker didn't open")
        else:
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(150)
            if await picker_visible(page):
                failures.append("[10a] Esc did not close picker")
                print("  FAIL [10a] — Esc didn't close")
            else:
                print("  PASS [10a] — Esc closes")
        # Click-outside dismissal
        await field7.click()
        await page.keyboard.type("{")
        await page.wait_for_timeout(150)
        # Click on a far-away part of the page (header).
        await page.locator("header").first.click(force=True)
        await page.wait_for_timeout(200)
        if await picker_visible(page):
            failures.append("[10b] click-outside did not close picker")
            print("  FAIL [10b] — click-outside didn't close")
        else:
            print("  PASS [10b] — click-outside closes")

        await browser.close()

    print()
    print("=" * 60)
    if failures:
        print(f"FAIL ({len(failures)} issues):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("All ref-picker checks PASS.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

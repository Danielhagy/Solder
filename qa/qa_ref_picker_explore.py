"""
Exploratory probes for the Solder data-reference picker.

Hunts edge cases the smoke (`qa_ref_picker_full.py`) didn't cover.
Each probe captures a screenshot under qa/artifacts/ref-picker-explore/
and prints a one-line PASS/FAIL with notes. Findings drive REPORT.md.
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright, Page

BASE = "http://localhost:5173"
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "ref-picker-explore"
OUT.mkdir(parents=True, exist_ok=True)


# ----------------------------- helpers ---------------------------------


async def fresh_canvas(page: Page) -> None:
    await page.goto(BUILDER, wait_until="networkidle")
    await page.wait_for_timeout(300)


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


async def picker_visible(page: Page) -> bool:
    return await page.locator('[data-testid="ref-picker"]').count() > 0


async def picker_count(page: Page) -> int:
    return await page.locator('[data-testid="ref-picker"]').count()


async def picker_text(page: Page) -> str:
    if not await picker_visible(page):
        return ""
    return await page.locator('[data-testid="ref-picker"]').first.inner_text()


async def shot(page: Page, name: str) -> None:
    await page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)


def banner(label: str) -> None:
    print()
    print("=" * 60)
    print(label)
    print("=" * 60)


# ----------------------------- probes ----------------------------------


async def main() -> int:
    findings: dict[str, dict] = {}
    console_errors: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            reduced_motion="reduce",
        )
        page = await ctx.new_page()

        page.on(
            "console",
            lambda m: console_errors.append(f"[{m.type}] {m.text}")
            if m.type in ("error", "warning")
            else None,
        )
        page.on("pageerror", lambda e: console_errors.append(f"[pageerror] {e}"))

        # ============================================================
        # Probe 1 — Multiple `{` in a row
        # ============================================================
        banner("Probe 1: Multiple `{` keystrokes in a row")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        # Type {{ — first opens picker, second flows through field while picker open.
        await page.keyboard.type("{")
        await page.wait_for_timeout(150)
        first_open = await picker_count(page)
        await page.keyboard.type("{")
        await page.wait_for_timeout(150)
        second_count = await picker_count(page)
        val_after_double = await f.input_value()
        # Now type `$` — does picker close, stay, or break?
        await page.keyboard.type("$")
        await page.wait_for_timeout(150)
        after_dollar = await picker_count(page)
        val_after_dollar = await f.input_value()
        await shot(page, "01_double_brace")
        findings["1"] = {
            "first_open_count": first_open,
            "second_brace_count": second_count,
            "value_after_{{": val_after_double,
            "after_dollar_count": after_dollar,
            "value_after_{{$": val_after_dollar,
        }
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(100)

        # ============================================================
        # Probe 2 — Backspace through token
        # ============================================================
        banner("Probe 2: Backspace through inserted token")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        # Click body leaf
        body_leaf = (
            page.locator('[data-testid="ref-picker"]').locator("button", has_text="body").first
        )
        await body_leaf.click()
        await page.wait_for_timeout(150)
        before_bs = await f.input_value()
        # Backspace 5 chars from middle of token
        await f.click()
        await page.keyboard.press("End")
        for _ in range(5):
            await page.keyboard.press("Backspace")
        await page.wait_for_timeout(100)
        after_bs = await f.input_value()
        # Did picker reopen? It shouldn't (we backspaced, not typed `{`).
        bs_picker = await picker_count(page)
        await shot(page, "02_backspace_token")
        findings["2"] = {
            "before_backspace": before_bs,
            "after_5_backspace": after_bs,
            "picker_reopened": bs_picker,
        }

        # ============================================================
        # Probe 3 — Switch case isolation
        # ============================================================
        banner("Probe 3: Switch other-case ref isolation")
        await fresh_canvas(page)
        # Place upstream API call, then a Switch with 2 cases.
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-logic-switch")
        await page.wait_for_timeout(200)
        # Step into the first case branch — find the step-into button.
        # Switch editor uses cases case_1 and case_2 by default.
        step_into_btns = page.locator('[data-testid^="step-into-"]')
        n_step_into = await step_into_btns.count()
        # Click the first step-into available (case_1).
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('[data-testid^="step-into-"]');
                if (btns[0]) btns[0].click();
            }"""
        )
        await page.wait_for_timeout(400)
        # Drop a Transform inside case_1.
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        text_inside_case = await picker_text(page)
        # Did the upstream HTTP step show? That's required.
        sees_http = "http" in text_inside_case.lower() or "api call" in text_inside_case.lower() or "request" in text_inside_case.lower()
        # Are nodes from OTHER cases visible? case_2 has no nodes here, so we
        # need to also drop a node in case_2 to verify cross-case leakage.
        await shot(page, "03a_switch_case1_picker")
        await page.keyboard.press("Escape")
        # Walk back to root.
        await page.evaluate(
            """() => {
                const btn = document.querySelector('[data-testid="back-to-root"]');
                if (btn) btn.click();
                else {
                    // fall back: look for crumb
                    const crumb = document.querySelector('button[aria-label*="root" i]');
                    if (crumb) crumb.click();
                }
            }"""
        )
        await page.wait_for_timeout(300)
        # Step into case_2 (second step-into button).
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('[data-testid^="step-into-"]');
                if (btns[1]) btns[1].click();
                else if (btns[0]) btns[0].click();
            }"""
        )
        await page.wait_for_timeout(400)
        # Drop a uniquely-labeled Data filter inside case_2 so we can detect
        # leakage by name.
        await add_node(page, "palette-data-filter")
        await page.wait_for_timeout(200)
        # Rename it via the inline editor if possible — easier: just check by id.
        # Step back out and re-open picker in case_1.
        await page.evaluate(
            """() => {
                const btn = document.querySelector('[data-testid="back-to-root"]');
                if (btn) btn.click();
            }"""
        )
        await page.wait_for_timeout(300)
        # Step into case_1 again.
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('[data-testid^="step-into-"]');
                if (btns[0]) btns[0].click();
            }"""
        )
        await page.wait_for_timeout(400)
        await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        text_case1_after_case2_node = await picker_text(page)
        # Look for the data-filter node that was added in case_2 — it shouldn't appear
        sees_filter = "filter" in text_case1_after_case2_node.lower()
        await shot(page, "03b_switch_case1_after_case2_populated")
        findings["3"] = {
            "step_into_buttons_at_root": n_step_into,
            "case1_picker_sees_upstream_http": sees_http,
            "case1_picker_text_excerpt": text_inside_case[:300],
            "case1_after_case2_populated_text": text_case1_after_case2_node[:400],
            "case1_leaks_case2_filter": sees_filter,
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Probe 4 — Sibling-stage parallelism
        # ============================================================
        banner("Probe 4: Sibling-stage parallelism — two siblings visible downstream")
        await fresh_canvas(page)
        # Drop two API Calls, then drag one into the same stage as the other.
        # Easier approach: add two and inspect; the catalog default may put
        # them in subsequent stages. We'll check what's visible from a Transform
        # placed downstream.
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        # Inspect store directly to verify parallelism.
        layout = await page.evaluate(
            """() => {
                // Pull from window-exposed integration state if available
                const state = window.__solder_integration_state__;
                if (!state) return null;
                return state.nodes.map(n => ({id: n.id, kind: n.kind, action: n.action, stage: n.stage, slot: n.slot, label: n.label}));
            }"""
        )
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        text_p4 = await picker_text(page)
        # Count visible step rows by looking for the stage prefix pattern (00, 01, 02)
        # Better: count the ▾/▸ rows under "Steps".
        step_buttons = await page.locator('[data-testid="ref-picker"] button').count()
        # Specifically count HTTP labels — each API Call has a chip
        http_label_count = text_p4.lower().count("http") + text_p4.lower().count("api call")
        await shot(page, "04_two_siblings")
        findings["4"] = {
            "layout": layout,
            "picker_step_button_count": step_buttons,
            "picker_text_excerpt": text_p4[:600],
            "http_label_appearances": http_label_count,
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Probe 5 — Loop in Loop in Branch arm (3 levels deep)
        # ============================================================
        banner("Probe 5: Branch > Loop > Loop > Transform")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-logic-branch")
        await page.wait_for_timeout(200)
        # Step into branch true arm.
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('[data-testid^="step-into-"]');
                if (btns[0]) btns[0].click();
            }"""
        )
        await page.wait_for_timeout(300)
        await add_node(page, "palette-logic-loop")
        await page.wait_for_timeout(200)
        # Step into loop body.
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('[data-testid^="step-into-"]');
                if (btns[0]) btns[0].click();
            }"""
        )
        await page.wait_for_timeout(300)
        await add_node(page, "palette-logic-loop")
        await page.wait_for_timeout(200)
        # Step into the inner loop body.
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('[data-testid^="step-into-"]');
                if (btns[0]) btns[0].click();
            }"""
        )
        await page.wait_for_timeout(300)
        await add_node(page, "palette-transform-map")
        ok = await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        nested_field_count = await f.count()
        text_p5 = ""
        if nested_field_count:
            await f.click()
            await page.keyboard.press("Control+A")
            await page.keyboard.press("Delete")
            await page.keyboard.type("{")
            await page.wait_for_timeout(250)
            text_p5 = await picker_text(page)
        await shot(page, "05_nested_loop_loop_branch")
        findings["5"] = {
            "transform_field_present": nested_field_count,
            "picker_visible": await picker_visible(page),
            "shows_$item": "$item" in text_p5,
            "shows_$index": "$index" in text_p5,
            "shows_upstream_http": "http" in text_p5.lower() or "api call" in text_p5.lower() or "request" in text_p5.lower(),
            "loop_scope_caption": "Loop scope" in text_p5,
            "text_excerpt": text_p5[:500],
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Probe 6 — Long labels / paths
        # ============================================================
        banner("Probe 6: Long step labels — overflow handling")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        # Rename the API Call node label via store mutation.
        long_label = "X" * 60 + " — A Very Long Label For Visual Overflow Testing 0123456789"
        await page.evaluate(
            """(label) => {
                const state = window.__solder_integration_state__;
                if (!state) return;
                const http = state.nodes.find(n => n.kind === 'http' && n.action === 'request');
                if (http) {
                    // Use the store's update if exposed.
                    if (window.__solder_set_label__) window.__solder_set_label__(http.id, label);
                    else http.label = label;
                }
            }""",
            long_label,
        )
        # Actually drive the label via an exposed setter if not, so use the node's label input.
        # Try direct approach: select the http node and edit its label input.
        await select_node(page, "node-http-request")
        label_input = page.locator('input[aria-label="Step label"], textarea[aria-label="Step label"]').first
        if await label_input.count():
            await label_input.fill(long_label)
            await page.wait_for_timeout(150)
        # Now switch to Transform and open picker.
        await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        # Check picker width and overflow.
        picker_box = await page.locator('[data-testid="ref-picker"]').first.bounding_box()
        # Find the long-label button width.
        long_label_btn = page.locator('[data-testid="ref-picker"] button', has_text="XXXXXX").first
        long_label_present = await long_label_btn.count()
        long_label_box = None
        if long_label_present:
            long_label_box = await long_label_btn.bounding_box()
        await shot(page, "06_long_label")
        findings["6"] = {
            "picker_box": picker_box,
            "long_label_present": long_label_present,
            "long_label_box": long_label_box,
            "long_label_text_was": long_label,
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Probe 7 — Picker viewport (flip above)
        # ============================================================
        banner("Probe 7: Picker flip-above when near bottom of viewport")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        # Scroll the right rail (properties panel) so the field is near the bottom.
        # The properties panel is a scrollable region.
        await page.evaluate(
            """() => {
                const candidates = document.querySelectorAll('aside, [class*="rail"], [class*="properties"]');
                for (const el of candidates) {
                    if (el.scrollHeight > el.clientHeight) {
                        el.scrollTop = el.scrollHeight;
                    }
                }
            }"""
        )
        await page.wait_for_timeout(200)
        # Resize viewport down to force the field near bottom.
        await page.set_viewport_size({"width": 1440, "height": 500})
        await page.wait_for_timeout(200)
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.type("{")
        await page.wait_for_timeout(300)
        picker_box_p7 = None
        anchor_box_p7 = None
        if await picker_visible(page):
            picker_box_p7 = await page.locator('[data-testid="ref-picker"]').first.bounding_box()
            anchor_box_p7 = await f.bounding_box()
        await shot(page, "07_flip_above")
        flipped = (
            picker_box_p7 is not None
            and anchor_box_p7 is not None
            and picker_box_p7["y"] + picker_box_p7["height"] <= anchor_box_p7["y"] + 1
        )
        clipped_above = picker_box_p7 is not None and picker_box_p7["y"] < 0
        clipped_below = (
            picker_box_p7 is not None
            and (picker_box_p7["y"] + picker_box_p7["height"]) > 500 + 1
        )
        findings["7"] = {
            "picker_box": picker_box_p7,
            "anchor_box": anchor_box_p7,
            "flipped_above_anchor": flipped,
            "clipped_above_viewport": clipped_above,
            "clipped_below_viewport": clipped_below,
            "viewport_h": 500,
        }
        await page.keyboard.press("Escape")
        # Restore viewport.
        await page.set_viewport_size({"width": 1440, "height": 900})

        # ============================================================
        # Probe 8 — Rapid open/close
        # ============================================================
        banner("Probe 8: Rapid open/close 5x — leaks?")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        for _ in range(5):
            await f.click()
            await page.keyboard.type("{")
            await page.wait_for_timeout(80)
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(80)
        # Final state: picker closed, exactly one anchor present, no stray pickers.
        final_pickers = await picker_count(page)
        final_fields = await page.locator('[aria-label="Transform expression"]').count()
        # Try opening one more time — does it still work?
        await f.click()
        await page.keyboard.type("{")
        await page.wait_for_timeout(150)
        post_open_count = await picker_count(page)
        await shot(page, "08_rapid_open_close")
        findings["8"] = {
            "after_5_cycles_picker_count": final_pickers,
            "fields_after_5_cycles": final_fields,
            "still_opens": post_open_count,
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Probe 9 — Switch picker between fields without closing
        # ============================================================
        banner("Probe 9: Open picker on Field A, click Field B")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        # http.request has multiple ReferenceFields: HTTP URL, headers, body, etc.
        # We'll simulate two fields on the same node.
        await select_node(page, "node-http-request")
        url_field = page.locator('[aria-label="HTTP URL"]').first
        # Find a second reference field — any other aria-label inside http editor.
        all_ref_fields = await page.evaluate(
            """() => {
                const els = document.querySelectorAll('textarea, input');
                return Array.from(els).map(e => e.getAttribute('aria-label')).filter(Boolean);
            }"""
        )
        await url_field.click()
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        first_picker_count = await picker_count(page)
        # Now click a *different* field. Use a robust target: the step-label input.
        other = page.locator('[aria-label="Step label"]').first
        if await other.count():
            await other.click()
            await page.wait_for_timeout(200)
        else:
            # fallback: click somewhere else
            await page.locator("header").first.click(force=True)
            await page.wait_for_timeout(200)
        after_other_click = await picker_count(page)
        # Now type `{` in the new field — what's the picker behaviour?
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        after_brace_in_other = await picker_count(page)
        await shot(page, "09_two_fields")
        findings["9"] = {
            "all_aria_labels_seen": all_ref_fields[:20],
            "picker_after_first_open": first_picker_count,
            "picker_after_clicking_other_field": after_other_click,
            "picker_after_brace_in_other_field": after_brace_in_other,
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Probe 10 — single-line input vs textarea behaviour
        # ============================================================
        banner("Probe 10: Single-line input ('Loop iterate over') vs textarea")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-logic-loop")
        await select_node(page, "node-logic-loop")
        loop_field = page.locator('[aria-label="Loop iterate over"]').first
        # Verify it's an <input>, not <textarea>.
        loop_tag = await loop_field.evaluate("el => el.tagName")
        await loop_field.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        loop_picker = await picker_visible(page)
        body_leaf = (
            page.locator('[data-testid="ref-picker"]').locator("button", has_text="body").first
        )
        await body_leaf.click()
        await page.wait_for_timeout(150)
        loop_val = await loop_field.input_value()

        # Now do the same on a textarea (Branch predicate).
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-logic-branch")
        await select_node(page, "node-logic-branch")
        branch_field = page.locator('[aria-label="If/Else predicate"]').first
        branch_tag = await branch_field.evaluate("el => el.tagName")
        await branch_field.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(200)
        body_leaf2 = (
            page.locator('[data-testid="ref-picker"]').locator("button", has_text="body").first
        )
        await body_leaf2.click()
        await page.wait_for_timeout(150)
        branch_val = await branch_field.input_value()
        await shot(page, "10_singleline_vs_textarea")
        findings["10"] = {
            "loop_field_tag": loop_tag,
            "loop_picker_opened": loop_picker,
            "loop_inserted_value": loop_val,
            "branch_field_tag": branch_tag,
            "branch_inserted_value": branch_val,
            "loop_correct": loop_val.startswith("{{$.steps.") and loop_val.endswith(".output.body}}"),
            "branch_correct": branch_val.startswith("{{$.steps.") and branch_val.endswith(".output.body}}"),
        }

        # ============================================================
        # Probe 11 — Self-reference (current node should NOT appear)
        # ============================================================
        banner("Probe 11: Picker should not list the current node")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-transform-map")
        # Rename the Transform so we can tell.
        await select_node(page, "node-transform-map")
        label_input = page.locator('input[aria-label="Step label"]').first
        marker = "MY-TRANSFORM-SELFREF-XYZ"
        if await label_input.count():
            await label_input.fill(marker)
            await page.wait_for_timeout(150)
        f = page.locator('[aria-label="Transform expression"]').first
        await f.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Delete")
        await page.keyboard.type("{")
        await page.wait_for_timeout(250)
        text_p11 = await picker_text(page)
        sees_self = marker in text_p11
        await shot(page, "11_no_self_ref")
        findings["11"] = {
            "picker_text": text_p11[:500],
            "sees_self_marker": sees_self,
            "marker": marker,
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Probe 13 — applySwitchCases churn
        # ============================================================
        banner("Probe 13: Switch case add/remove churn — picker scope correctness")
        await fresh_canvas(page)
        await add_node(page, "palette-http-request")
        await add_node(page, "palette-logic-switch")
        await select_node(page, "node-logic-switch")
        # Switch defaults to 2 cases. Add one more (3 total), remove case_1, add another.
        # Use the editor's controls via JS evaluation since they're real React inputs.
        add_case_btn = page.locator('button', has_text="Add case").first
        if await add_case_btn.count():
            await add_case_btn.click()
            await page.wait_for_timeout(150)
        # Remove first case using its delete button (small "×" near case 1).
        # Robust: find Remove buttons.
        remove_btns = page.locator('[aria-label*="Remove case" i]')
        n_remove = await remove_btns.count()
        if n_remove == 0:
            remove_btns = page.locator('button', has_text="×")
            n_remove = await remove_btns.count()
        # Use evaluate to scan for any case-removal button.
        removed_via = "n/a"
        if n_remove > 0:
            await remove_btns.first.click()
            removed_via = "first remove btn"
            await page.wait_for_timeout(150)
        # Add another.
        if await add_case_btn.count():
            await add_case_btn.click()
            await page.wait_for_timeout(150)
        # Inspect resulting cases via store.
        cases_state = await page.evaluate(
            """() => {
                const state = window.__solder_integration_state__;
                if (!state) return null;
                const sw = state.nodes.find(n => n.kind === 'logic' && n.action === 'switch');
                if (!sw) return null;
                return {
                    cases: sw.config.cases,
                    branchKeys: Object.keys(sw.branches || {}),
                };
            }"""
        )
        # Step into any remaining case to verify scope.
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('[data-testid^="step-into-"]');
                if (btns[0]) btns[0].click();
            }"""
        )
        await page.wait_for_timeout(400)
        await add_node(page, "palette-transform-map")
        await select_node(page, "node-transform-map")
        f = page.locator('[aria-label="Transform expression"]').first
        text_p13 = ""
        if await f.count():
            await f.click()
            await page.keyboard.press("Control+A")
            await page.keyboard.press("Delete")
            await page.keyboard.type("{")
            await page.wait_for_timeout(250)
            text_p13 = await picker_text(page)
        await shot(page, "13_switch_churn")
        findings["13"] = {
            "n_remove_buttons": n_remove,
            "removed_via": removed_via,
            "cases_state": cases_state,
            "picker_text_in_remaining_case": text_p13[:500],
        }
        await page.keyboard.press("Escape")

        # ============================================================
        # Final: collect console errors
        # ============================================================
        findings["12_console"] = {
            "messages": console_errors[:80],
            "total_warnings_or_errors": len(console_errors),
        }

        await browser.close()

    out = OUT / "findings.json"
    out.write_text(json.dumps(findings, indent=2, default=str), encoding="utf-8")
    print()
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

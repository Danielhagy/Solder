"""
Interactive verification of two new builder features:

  1. logic.switch node — dynamic case add/remove + canvas branch summary
  2. Variables / Appends UI on Branch / Loop / Switch + save round-trip

Writes screenshots into qa/artifacts/ux-review-after/new-features/ and a
PASS/FAIL/SKIPPED report to qa/artifacts/ux-review-after/TEST-NEW-FEATURES.md.
"""

from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright, Page, Dialog

BASE = "http://localhost:5173"
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "ux-review-after" / "new-features"
OUT.mkdir(parents=True, exist_ok=True)
REPORT = Path(__file__).parent / "artifacts" / "ux-review-after" / "TEST-NEW-FEATURES.md"

# Step results: list of (label, status, note, screenshots)
results: list[tuple[str, str, str, list[str]]] = []


def record(label: str, status: str, note: str, shots: list[str] | None = None) -> None:
    results.append((label, status, note, shots or []))
    print(f"[{status}] {label} — {note}")


async def shot(page: Page, name: str) -> str:
    p = OUT / f"{name}.png"
    await page.screenshot(path=str(p), full_page=False)
    return p.name


async def add_palette(page: Page, testid: str) -> None:
    await page.locator(f'[data-testid="{testid}"]').first.click()
    await page.wait_for_timeout(250)


async def section_switch(page: Page) -> None:
    print("\n=== Section 1: logic.switch + dynamic cases ===")
    await page.goto(BUILDER, wait_until="networkidle")
    await page.wait_for_timeout(500)

    # 1. Canvas loaded
    if await page.locator('[data-testid="empty-canvas-dropzone"]').count() == 0:
        record("1.1 builder loads", "FAIL", "empty-canvas-dropzone not present")
        return
    record("1.1 builder loads", "PASS", "empty-canvas-dropzone visible")

    # 2. Add Switch via palette-logic-switch
    sw_btn = page.locator('[data-testid="palette-logic-switch"]')
    if await sw_btn.count() == 0:
        # Fallback: try by label "Switch"
        sw_btn = page.locator('aside button:has-text("Switch")').first
        if await sw_btn.count() == 0:
            record("1.2 add Switch", "FAIL", "no palette-logic-switch and no 'Switch' label button")
            return
    await sw_btn.first.click()
    await page.wait_for_timeout(400)
    sw_node = page.locator('[data-testid="node-logic-switch"]')
    if await sw_node.count() == 0:
        record("1.2 add Switch", "FAIL", "Switch node card did not render after palette click")
        return
    record("1.2 add Switch", "PASS", "Switch node added; node-logic-switch card present")

    # 3. Click to select; SwitchEditor should appear in props panel (look for "+ add case" button)
    # The card div is draggable=true with onClick; some Playwright/Chromium combos
    # don't deliver click cleanly through HTML5 drag handles, so dispatch a JS click
    # on the same element.
    await sw_node.first.click(force=True)
    await page.wait_for_timeout(300)
    if await page.locator('aside.w-80 button:has-text("+ add case")').count() == 0:
        await sw_node.first.evaluate("el => el.click()")
        await page.wait_for_timeout(400)
    add_case_btn = page.locator('aside.w-80 button:has-text("+ add case")')
    if await add_case_btn.count() == 0:
        # Diagnostic dump
        s_dbg = await shot(page, "DBG_switch_no_editor")
        try:
            panel_html = await page.locator('aside.w-80').first.inner_html()
            (OUT / "DBG_aside_html.txt").write_text(panel_html[:8000], encoding="utf-8")
        except Exception:
            pass
        record("1.3 select Switch shows editor", "FAIL",
               f"'+ add case' button not visible in properties panel ({s_dbg}; DBG_aside_html.txt dumped)")
        return
    record("1.3 select Switch shows editor", "PASS", "SwitchEditor rendered ('+ add case' present)")

    # 4. Two default cases + default — count case_N labels in editor
    # Editor lists each case row with its key as a small mono label like "case_1"
    # CSS `uppercase` renders them as CASE_1; lowercase before checking.
    panel_text = (await page.locator('aside.w-80').inner_text()).lower()
    has_c1 = "case_1" in panel_text
    has_c2 = "case_2" in panel_text
    has_default = "default" in panel_text
    s4 = await shot(page, "01_switch_editor_default")
    if has_c1 and has_c2 and has_default:
        record("1.4 default 2 cases + default", "PASS",
               f"editor shows case_1, case_2, default ({s4})", [s4])
    else:
        record("1.4 default 2 cases + default", "FAIL",
               f"missing one of case_1/case_2/default — c1={has_c1} c2={has_c2} default={has_default} ({s4})", [s4])

    # 5. Click + add case — third case should appear
    add_case_btn = page.locator('aside.w-80 button:has-text("+ add case")')
    await add_case_btn.first.click()
    await page.wait_for_timeout(400)
    panel_text2 = (await page.locator('aside.w-80').inner_text()).lower()
    has_c3 = "case_3" in panel_text2
    # branch summary on canvas card
    branch_rows = page.locator('[data-testid^="branch-header-"]')
    n_branches = await branch_rows.count()
    s5 = await shot(page, "02_switch_after_add_case")
    if has_c3 and n_branches >= 4:  # 3 cases + 1 default = 4 rows
        record("1.5 add case → 3 cases + DEFAULT on card", "PASS",
               f"editor has case_3; canvas shows {n_branches} branch rows ({s5})", [s5])
    elif has_c3 and n_branches < 4:
        record("1.5 add case → 3 cases + DEFAULT on card", "FAIL",
               f"editor lists case_3 but canvas card shows only {n_branches} branch rows — likely a missing re-render trigger on node.branches changes ({s5})", [s5])
    else:
        record("1.5 add case → 3 cases + DEFAULT on card", "FAIL",
               f"editor did not gain case_3 (panel has c3={has_c3}; canvas rows={n_branches}) ({s5})", [s5])

    # 6. Step into a case via the branch header button. Use the first non-default branch.
    # Find a branch-header-* button whose key is case_*
    headers = await branch_rows.all()
    target_key = None
    target_btn = None
    for h in headers:
        tid = await h.get_attribute("data-testid") or ""
        if "case_" in tid:
            target_key = tid.rsplit("-", 1)[-1]
            target_btn = h
            break
    if not target_btn:
        record("1.6 step into a case", "SKIPPED", "no case_* branch header on canvas to click")
    else:
        await target_btn.click()
        await page.wait_for_timeout(700)  # wait for dive transition
        # Look for "Draft this branch" empty-state heading
        draft = page.locator('text="Draft this branch"')
        s6 = await shot(page, "03_switch_step_into_case")
        if await draft.count() > 0:
            record("1.6 step into a case", "PASS",
                   f"nested scene shows 'Draft this branch' for {target_key} ({s6})", [s6])
        else:
            record("1.6 step into a case", "FAIL",
                   f"nested scene did not show 'Draft this branch' heading for {target_key} ({s6})", [s6])

    # 7. Drop API Call node into the case body
    await add_palette(page, "palette-http-request")
    await page.wait_for_timeout(400)
    s7 = await shot(page, "04_case_with_http_node")
    in_stage1 = await page.locator('[data-testid="stage-column-1"] [data-testid="node-http-request"]').count()
    if in_stage1 >= 1:
        record("1.7 drop API Call into case body", "PASS",
               f"http-request node landed in stage 01 of case ({s7})", [s7])
    else:
        record("1.7 drop API Call into case body", "FAIL",
               f"http-request node not present in stage-column-1 ({s7})", [s7])

    # 8. Pop back to root via topbar-back-to-main
    back_btn = page.locator('[data-testid="topbar-back-to-main"]')
    if await back_btn.count() == 0:
        record("1.8 pop back to root", "FAIL", "topbar-back-to-main button not present")
    else:
        await back_btn.first.click()
        await page.wait_for_timeout(900)
        # The back button should disappear at root.
        still_back = await page.locator('[data-testid="topbar-back-to-main"]').count()
        sw_visible = await page.locator('[data-testid="node-logic-switch"]').count()
        s8 = await shot(page, "07_after_back_to_main")
        if still_back == 0 and sw_visible > 0:
            record("1.8 pop back to root", "PASS",
                   f"back-to-main hidden at root; Switch card present ({s8})", [s8])
        else:
            record("1.8 pop back to root", "FAIL",
                   f"still_back={still_back}, sw_visible={sw_visible} ({s8})", [s8])

    # 9. Re-select Switch — case should still show its node count.
    # Click near the top-left of the card so we don't accidentally hit a
    # branch-header button (which would step INTO that case).
    sw_card = page.locator('[data-testid="node-logic-switch"]').first
    await sw_card.click(position={"x": 20, "y": 12})
    await page.wait_for_timeout(500)
    if target_key:
        # Probe ALL branch rows; pick the one whose data-testid ends with our key.
        all_rows = page.locator('[data-testid^="branch-header-"]')
        n = await all_rows.count()
        row_text = ""
        for i in range(n):
            tid = await all_rows.nth(i).get_attribute("data-testid") or ""
            if tid.endswith(f"-{target_key}"):
                row_text = await all_rows.nth(i).inner_text()
                break
        rt_lower = row_text.lower()
        if "1 step" in rt_lower:
            record("1.9 case retains node count after pop", "PASS",
                   f"{target_key} row reads '1 step'")
        else:
            record("1.9 case retains node count after pop", "FAIL",
                   f"{target_key} row text = {row_text!r} across {n} branch rows (expected '1 step')")
    else:
        record("1.9 case retains node count after pop", "SKIPPED", "no target_key from step 6")

    # 10. Remove an empty case (case_3) via the ✕ button next to it.
    # The remove buttons are aria-label="Remove case" — index 2 (case_3) is the third case.
    remove_btns = page.locator('aside.w-80 button[aria-label="Remove case"]')
    n_remove = await remove_btns.count()
    if n_remove < 3:
        record("1.10 remove empty case_3", "SKIPPED",
               f"expected ≥3 remove buttons, got {n_remove}")
    else:
        # case_3 is empty; click its ✕ — should NOT trigger confirm (no nodes)
        before_rows = await page.locator('[data-testid^="branch-header-"]').count()
        await remove_btns.nth(2).click()
        await page.wait_for_timeout(500)
        after_rows = await page.locator('[data-testid^="branch-header-"]').count()
        panel_text3 = (await page.locator('aside.w-80').inner_text()).lower()
        s10 = await shot(page, "05_after_remove_case3")
        editor_lost_c3 = "case_3" not in panel_text3
        canvas_shrunk = after_rows == before_rows - 1
        if editor_lost_c3 and canvas_shrunk:
            record("1.10 remove empty case_3", "PASS",
                   f"editor dropped case_3; canvas rows {before_rows}→{after_rows} ({s10})", [s10])
        else:
            record("1.10 remove empty case_3", "FAIL",
                   f"editor_lost_c3={editor_lost_c3}, canvas {before_rows}→{after_rows} ({s10})", [s10])

    # 11. Remove a case that HAS a node — should fire window.confirm.
    # case_1 still has the http-request node from step 7. Use a dialog handler.
    confirmed: dict[str, bool] = {"saw": False}

    def on_dialog(d: Dialog) -> None:
        confirmed["saw"] = True
        # accept
        asyncio.create_task(d.accept())

    page.on("dialog", on_dialog)
    # Re-query remove buttons (may have shifted)
    remove_btns2 = page.locator('aside.w-80 button[aria-label="Remove case"]')
    if await remove_btns2.count() == 0:
        record("1.11 remove case with node fires confirm", "SKIPPED",
               "no remove buttons available")
    else:
        # Determine which case carries the node — was case_1 (target_key from step 6).
        # Click first remove button (index 0 = case_1).
        await remove_btns2.first.click()
        await page.wait_for_timeout(600)
        s11 = await shot(page, "06_after_remove_case_with_node")
        # Verify that case key is gone from editor and the http node is gone too
        panel_text4 = await page.locator('aside.w-80').inner_text()
        # The first case might be case_1 OR case_2 depending on whether step 1.10 succeeded
        # Easiest: count case_ tokens in the editor and see we shrunk by 1
        case_count_after = panel_text4.count("case_")
        node_gone = await page.locator('[data-testid="node-http-request"]').count() == 0
        if confirmed["saw"] and node_gone:
            record("1.11 remove case with node fires confirm", "PASS",
                   f"window.confirm captured, case + http node both removed ({s11})", [s11])
        elif confirmed["saw"]:
            record("1.11 remove case with node fires confirm", "FAIL",
                   f"confirm fired but http node still present (node_gone={node_gone}) ({s11})", [s11])
        else:
            record("1.11 remove case with node fires confirm", "FAIL",
                   f"window.confirm dialog did not fire when removing a case with a node ({s11})", [s11])
    page.remove_listener("dialog", on_dialog)


async def section_variables(page: Page) -> None:
    print("\n=== Section 2: Variables / Appends UI ===")
    # Fresh canvas
    await page.goto(BUILDER, wait_until="networkidle")
    await page.wait_for_timeout(500)

    # 2.1 Drop If/Else and Loop
    await add_palette(page, "palette-logic-branch")
    await add_palette(page, "palette-logic-loop")
    branch_node = page.locator('[data-testid="node-logic-branch"]')
    loop_node = page.locator('[data-testid="node-logic-loop"]')
    if await branch_node.count() == 0 or await loop_node.count() == 0:
        record("2.1 drop branch + loop", "FAIL",
               f"branch={await branch_node.count()}, loop={await loop_node.count()}")
        return
    record("2.1 drop branch + loop", "PASS", "both nodes added to canvas")

    # 2.2 Branch — Variables section: + add variable, type customer_tier
    await branch_node.first.click(position={"x": 20, "y": 12})
    await page.wait_for_timeout(400)
    if await page.locator('aside.w-80 button:has-text("+ add variable")').count() == 0:
        await branch_node.first.evaluate("el => el.click()")
        await page.wait_for_timeout(400)
    add_var = page.locator('aside.w-80 button:has-text("+ add variable")')
    if await add_var.count() == 0:
        record("2.2 branch variables section", "FAIL",
               "'+ add variable' button missing on branch properties")
    else:
        await add_var.first.click()
        await page.wait_for_timeout(400)
        # Fill name input (aria-label "Variables 1 name")
        name_input = page.locator('aside.w-80 input[aria-label="Variables 1 name"]')
        if await name_input.count() == 0:
            s_dbg = await shot(page, "DBG_branch_no_var_input")
            record("2.2 branch variables section", "FAIL",
                   f"Variables 1 name input not found after + add variable ({s_dbg})", [s_dbg])
        else:
            await name_input.fill("customer_tier")
            await page.locator('aside.w-80 input[aria-label="Variables 1 description"]').fill("tier from auth lookup")
            await page.wait_for_timeout(200)
            s = await shot(page, "10_branch_variable_added")

            # Click loop node and back to verify persistence
            await loop_node.first.click(position={"x": 20, "y": 12})
            await page.wait_for_timeout(300)
            await branch_node.first.click(position={"x": 20, "y": 12})
            await page.wait_for_timeout(500)
            try:
                persisted = await page.locator('aside.w-80 input[aria-label="Variables 1 name"]').input_value(timeout=2000)
            except Exception:
                persisted = None
            if persisted == "customer_tier":
                record("2.2 branch variables section", "PASS",
                       f"variable persists across reselect ({s})", [s])
            else:
                record("2.2 branch variables section", "FAIL",
                       f"after reselect Variables 1 name = {persisted!r} ({s})", [s])

    # 2.3 Loop — Appends section
    await loop_node.first.click(position={"x": 20, "y": 12})
    await page.wait_for_timeout(400)
    if await page.locator('aside.w-80 button:has-text("+ add append")').count() == 0:
        await loop_node.first.evaluate("el => el.click()")
        await page.wait_for_timeout(400)
    add_app = page.locator('aside.w-80 button:has-text("+ add append")')
    if await add_app.count() == 0:
        record("2.3 loop appends section", "FAIL",
               "'+ add append' not found on loop properties")
    else:
        await add_app.first.click()
        await page.wait_for_timeout(200)
        ap_name = page.locator('aside.w-80 input[aria-label="Appends 1 name"]')
        if await ap_name.count() == 0:
            record("2.3 loop appends section", "FAIL",
                   "Appends 1 name input not found after + add append")
        else:
            await ap_name.fill("succeeded")
            await page.wait_for_timeout(200)
            s = await shot(page, "11_loop_append_added")
            record("2.3 loop appends section", "PASS",
                   f"append 'succeeded' added ({s})", [s])

    # 2.4 Switch — also has Variables. Add a Switch.
    await add_palette(page, "palette-logic-switch")
    sw_node = page.locator('[data-testid="node-logic-switch"]')
    if await sw_node.count() == 0:
        record("2.4 switch variables section", "FAIL", "could not add switch node")
    else:
        await sw_node.first.click(position={"x": 20, "y": 12})
        await page.wait_for_timeout(400)
        if await page.locator('aside.w-80 button:has-text("+ add variable")').count() == 0:
            await sw_node.first.evaluate("el => el.click()")
            await page.wait_for_timeout(400)
        add_var2 = page.locator('aside.w-80 button:has-text("+ add variable")')
        if await add_var2.count() == 0:
            record("2.4 switch variables section", "FAIL",
                   "'+ add variable' missing on switch properties")
        else:
            await add_var2.first.click()
            await page.wait_for_timeout(200)
            v_name = page.locator('aside.w-80 input[aria-label="Variables 1 name"]')
            await v_name.fill("matched_segment")
            await page.wait_for_timeout(150)
            s = await shot(page, "12_switch_variable_added")
            record("2.4 switch variables section", "PASS",
                   f"switch variable 'matched_segment' added ({s})", [s])

    # 2.5 Save + reload round-trip. Add a case to switch first so we have something to verify.
    add_case = page.locator('aside.w-80 button:has-text("+ add case")')
    if await add_case.count() > 0:
        await add_case.first.click()
        await page.wait_for_timeout(200)

    # Name the integration and save
    name = f"QA NewFeatures {int(asyncio.get_event_loop().time())}"
    name_input = page.locator('input[placeholder="Untitled integration"]').first
    await name_input.fill(name)
    await page.locator('button:has-text("Save")').first.click()
    await page.wait_for_timeout(300)
    save_in_dialog = page.locator('.card button:has-text("Save")')
    if await save_in_dialog.count() == 0:
        record("2.5 save + reload round-trip", "FAIL", "Save dialog did not open")
        return
    await save_in_dialog.first.click()
    # Wait for URL to mutate from /integrations/new to /integrations/<id>
    try:
        await page.wait_for_url(
            lambda u: "/integrations/" in u and not u.endswith("/integrations/new"),
            timeout=8000,
        )
    except Exception:
        pass
    await page.wait_for_timeout(800)
    url_after = page.url
    if url_after.endswith("/integrations/new") or "/integrations/" not in url_after:
        s_save = await shot(page, "DBG_after_save")
        record("2.5 save + reload round-trip", "FAIL",
               f"after save URL = {url_after} (expected /integrations/<id>) ({s_save})", [s_save])
        return

    # Reload
    await page.reload(wait_until="networkidle")
    await page.wait_for_timeout(1500)
    s_postreload = await shot(page, "DBG_post_reload")

    if await page.locator('[data-testid="node-logic-branch"]').count() == 0:
        record("2.5 save + reload round-trip", "FAIL",
               f"after reload, no node-logic-branch found ({s_postreload})", [s_postreload])
        return

    # Re-select branch and verify variable persists
    await page.locator('[data-testid="node-logic-branch"]').first.click(position={"x": 20, "y": 12})
    await page.wait_for_timeout(400)
    if await page.locator('aside.w-80 button:has-text("+ add variable")').count() == 0:
        await page.locator('[data-testid="node-logic-branch"]').first.evaluate("el => el.click()")
        await page.wait_for_timeout(400)
    branch_var = page.locator('aside.w-80 input[aria-label="Variables 1 name"]')
    try:
        branch_persist = (await branch_var.input_value(timeout=2000)) if await branch_var.count() > 0 else None
    except Exception:
        branch_persist = None

    # Re-select loop, verify append
    await page.locator('[data-testid="node-logic-loop"]').first.click(position={"x": 20, "y": 12})
    await page.wait_for_timeout(400)
    if await page.locator('aside.w-80 button:has-text("+ add append")').count() == 0:
        await page.locator('[data-testid="node-logic-loop"]').first.evaluate("el => el.click()")
        await page.wait_for_timeout(400)
    loop_app = page.locator('aside.w-80 input[aria-label="Appends 1 name"]')
    try:
        loop_persist = (await loop_app.input_value(timeout=2000)) if await loop_app.count() > 0 else None
    except Exception:
        loop_persist = None

    # Re-select switch, verify variable AND case_3 persist
    await page.locator('[data-testid="node-logic-switch"]').first.click(position={"x": 20, "y": 12})
    await page.wait_for_timeout(400)
    if await page.locator('aside.w-80 button:has-text("+ add case")').count() == 0:
        await page.locator('[data-testid="node-logic-switch"]').first.evaluate("el => el.click()")
        await page.wait_for_timeout(400)
    sw_var = page.locator('aside.w-80 input[aria-label="Variables 1 name"]')
    try:
        sw_persist = (await sw_var.input_value(timeout=2000)) if await sw_var.count() > 0 else None
    except Exception:
        sw_persist = None
    panel_text = (await page.locator('aside.w-80').inner_text()).lower()
    has_c3_persist = "case_3" in panel_text

    s_final = await shot(page, "13_after_reload_switch")

    fails: list[str] = []
    if branch_persist != "customer_tier":
        fails.append(f"branch var={branch_persist!r}")
    if loop_persist != "succeeded":
        fails.append(f"loop append={loop_persist!r}")
    if sw_persist != "matched_segment":
        fails.append(f"switch var={sw_persist!r}")
    if not has_c3_persist:
        fails.append("switch case_3 missing")

    if not fails:
        record("2.5 save + reload round-trip", "PASS",
               f"all variables/appends/cases survived reload ({s_final})", [s_final])
    else:
        record("2.5 save + reload round-trip", "FAIL",
               f"after reload: {', '.join(fails)} ({s_final})", [s_final])


def write_report() -> None:
    lines: list[str] = []
    lines.append("# New Features QA — Switch + Variables/Appends")
    lines.append("")
    lines.append(f"Run: {asyncio.get_event_loop().time():.0f}s mono | viewport 1440x900 | base {BASE}")
    lines.append("")
    lines.append("Screenshots are in `qa/artifacts/ux-review-after/new-features/`.")
    lines.append("")
    lines.append("## Section 1 — `logic.switch` node + dynamic cases")
    lines.append("")
    lines.append("| Step | Status | Note | Screenshots |")
    lines.append("|---|---|---|---|")
    for label, status, note, shots in results:
        if not label.startswith("1."):
            continue
        shotcell = ", ".join(shots) if shots else "—"
        lines.append(f"| {label} | **{status}** | {note} | {shotcell} |")
    lines.append("")
    lines.append("## Section 2 — Variables / Appends UI")
    lines.append("")
    lines.append("| Step | Status | Note | Screenshots |")
    lines.append("|---|---|---|---|")
    for label, status, note, shots in results:
        if not label.startswith("2."):
            continue
        shotcell = ", ".join(shots) if shots else "—"
        lines.append(f"| {label} | **{status}** | {note} | {shotcell} |")
    lines.append("")
    n_pass = sum(1 for _, s, _, _ in results if s == "PASS")
    n_fail = sum(1 for _, s, _, _ in results if s == "FAIL")
    n_skip = sum(1 for _, s, _, _ in results if s == "SKIPPED")
    lines.append(f"**Totals:** {n_pass} PASS · {n_fail} FAIL · {n_skip} SKIPPED")
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nReport: {REPORT}")


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        try:
            await section_switch(page)
        except Exception as e:
            record("section_switch CRASH", "FAIL", f"{type(e).__name__}: {e}")

        try:
            await section_variables(page)
        except Exception as e:
            record("section_variables CRASH", "FAIL", f"{type(e).__name__}: {e}")

        await browser.close()

    write_report()
    n_fail = sum(1 for _, s, _, _ in results if s == "FAIL")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

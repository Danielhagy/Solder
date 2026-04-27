"""
QA harness for the container-readability frontend pass. Exercises:

  1. Auto-label derivation for Loop / Branch via defaultContainerLabel().
  2. User label override (label wins, kind-eyebrow appears alongside).
  3. Loop reduce caption (collect / last / count / none).
  4. Aggregate step summary on Loop body.
  5. Per-branch captions on Branch arms (TRUE: "if {expr}", FALSE: "else").
  6. NestedContextPanel — appears on dive, walks ancestors, click pops focus,
     "back to main" clears it.
  7. Deep-selector regression: clicking a node inside a Loop body opens its
     editor (not the no-selection Run Plan view).

Artifacts land in qa/artifacts/container_ui/. Stack assumed running on
http://localhost:5173 (frontend) + :8000 (backend).
Run: python qa/qa_container_ui.py
"""
from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path
from typing import Optional

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright, Page, Locator

BASE = "http://localhost:5173"
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "container_ui"
OUT.mkdir(parents=True, exist_ok=True)


# ---------- bookkeeping ----------

PASS = 0
FAIL = 0
FINDINGS: list[str] = []


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"  PASS {msg}")


def fail(msg: str) -> None:
    global FAIL
    FAIL += 1
    FINDINGS.append(msg)
    print(f"  FAIL {msg}")


# ---------- helpers ----------


async def goto_fresh(page: Page) -> None:
    """Navigate to the Builder fresh-canvas route and wait for it to settle."""
    await page.goto(BUILDER, wait_until="networkidle")
    await page.wait_for_timeout(300)


async def clear_canvas(page: Page) -> None:
    """Click the sidebar's 'Clear Canvas' button. Falls back to navigation reset."""
    try:
        # Pop out to root focus before clearing (clear button only renders when sidebar isn't collapsed).
        await page.evaluate(
            """() => {
              const btn = Array.from(document.querySelectorAll('button')).find(
                b => b.textContent && b.textContent.trim() === 'Clear Canvas'
              );
              if (btn) btn.click();
            }"""
        )
        await page.wait_for_timeout(200)
    except Exception:
        pass
    # Hard reset by reload as well — focusPath survives some store wirings, but
    # this guarantees a clean slate either way.
    await goto_fresh(page)


async def add_palette_node(page: Page, kind_action: str) -> None:
    """
    Click a palette item to add it via the focusPath-aware add path.
    Uses a synthetic JS click — bypasses viewport / overlay intercepts
    entirely (Playwright's `wait_for(state="attached")` mysteriously
    times out for these palette buttons even when querySelector finds
    them and the element is visible; the JS-dispatched click matches
    what Sidebar's onClick handler binds to and works reliably).
    """
    sel = f'[data-testid="palette-{kind_action}"]'
    # Poll briefly to make sure the element is in the DOM.
    for _ in range(20):
        present = await page.evaluate(
            "(s) => !!document.querySelector(s)", sel
        )
        if present:
            break
        await page.wait_for_timeout(150)
    else:
        raise RuntimeError(f"palette item never appeared in DOM: {sel}")
    await page.evaluate(
        """(s) => {
            const el = document.querySelector(s);
            if (!el) throw new Error('palette item missing: ' + s);
            el.click();
        }""",
        sel,
    )
    await page.wait_for_timeout(280)


async def card_locator(page: Page, kind: str, action: str) -> Locator:
    """Locate the (first) node card for a given kind/action."""
    return page.locator(f'[data-testid="node-{kind}-{action}"]').first


async def card_title_text(card: Locator) -> str:
    """The title is the first .font-medium span inside the card header."""
    return (await card.locator(".font-medium").first.inner_text()).strip()


async def card_eyebrow_text(card: Locator) -> Optional[str]:
    """Return the small kind-eyebrow text (if present)."""
    eb = card.locator('[aria-label="kind"].eyebrow')
    if await eb.count() == 0:
        return None
    return (await eb.first.inner_text()).strip()


async def card_headline_text(card: Locator) -> str:
    """The font-mono headline row directly under the title."""
    headline = card.locator(".font-mono").first
    return (await headline.inner_text()).strip()


async def select_node_by_card(page: Page, card: Locator) -> None:
    """
    Click the *title* of a card (NOT the centre — branch-header buttons
    can sit there and stop propagation). We measure and click 60px in,
    16px down which puts us on the title text.

    Per harness notes there's a known intercept bug where the floating-
    chrome overlay sometimes eats clicks; force=True is acceptable.
    """
    box = await card.bounding_box()
    if not box:
        raise RuntimeError("card has no bounding box (off-screen?)")
    await page.mouse.click(box["x"] + 60, box["y"] + 16)
    await page.wait_for_timeout(200)


async def set_label_input(page: Page, value: str) -> None:
    """Type into the PropertiesPanel's Label input (top of every editor)."""
    inp = page.locator('input[placeholder*="e.g."]').first
    await inp.fill(value)
    await page.wait_for_timeout(150)


async def set_loop_over(page: Page, expr: str) -> None:
    """The Loop editor's 'Iterate over' input — uses the $.items placeholder."""
    inp = page.locator('input[placeholder="$.items"]').first
    await inp.fill(expr)
    # Blur via Tab so React state commits.
    await inp.press("Tab")
    await page.wait_for_timeout(200)


async def set_branch_expression(page: Page, expr: str) -> None:
    """The Branch editor's predicate textarea."""
    ta = page.locator('textarea[placeholder=\'$.status == "approved"\']').first
    await ta.fill(expr)
    await ta.press("Tab")
    await page.wait_for_timeout(200)


async def set_loop_reduce(page: Page, value: str) -> None:
    """Set the Loop reduce <select>. value ∈ {collect,last,count,none}."""
    sel = page.locator("select").first
    await sel.select_option(value)
    await page.wait_for_timeout(200)


async def step_into(page: Page, kind: str, action: str, branch_key: str) -> None:
    """Click a branch-header row to step into a container's branch."""
    # The branch-header testid carries the parent's id, which is generated.
    # Prefix-match on 'branch-header-' and the suffix branch_key.
    sel = f'[data-testid^="branch-header-"][data-testid$="-{branch_key}"]'
    btn = page.locator(sel).first
    await btn.click(force=True)
    await page.wait_for_timeout(450)


async def back_to_main(page: Page) -> None:
    """Click the topbar's 'Back to main' affordance."""
    btn = page.locator('[data-testid="topbar-back-to-main"]').first
    if await btn.count() > 0:
        await btn.click()
        await page.wait_for_timeout(300)


# ---------- scenarios ----------


async def scenario_loop_label_derivation(page: Page) -> None:
    print("\n[1a] Loop auto-label derivation")
    cases = [
        ("$.invoices",          "For each invoice"),
        ("$.purchase_orders[*]", "For each purchase order"),
        ("$.items",             "For each item"),
        ("$.users.list",        "For each list"),
        ("$",                   "Loop"),  # No segment → falls back to bare kind
    ]
    for over, expected in cases:
        await clear_canvas(page)
        await add_palette_node(page, "logic-loop")
        card = await card_locator(page, "logic", "loop")
        await select_node_by_card(page, card)
        await set_loop_over(page, over)
        # Re-select the card to ensure the title repaints from the latest config
        await page.wait_for_timeout(150)
        title = await card_title_text(card)
        if title == expected:
            ok(f'Loop over={over!r} → title {title!r}')
        else:
            fail(f'Loop over={over!r}: expected title {expected!r}, got {title!r}')
        await page.screenshot(
            path=str(OUT / f"01_loop_{over.replace('$','dollar').replace('.', '_').replace('[*]','star').replace('[','_').replace(']','_')}.png")
        )


async def scenario_branch_label_derivation(page: Page) -> None:
    print("\n[1b] Branch auto-label derivation")
    cases = [
        ('$.status == "approved"',     "If status approved"),
        ("$.is_active",                "If is active"),
        ("$.count > 5",                "If count > 5"),
        ('$.foo != "bar"',             'If foo != "bar"'),
        ("$.complex && $.expr",         "If / Else"),  # Doesn't match → fallback to catalog kind
    ]
    for expr, expected in cases:
        await clear_canvas(page)
        await add_palette_node(page, "logic-branch")
        card = await card_locator(page, "logic", "branch")
        await select_node_by_card(page, card)
        await set_branch_expression(page, expr)
        await page.wait_for_timeout(150)
        title = await card_title_text(card)
        if title == expected:
            ok(f'Branch expr={expr!r} → title {title!r}')
        else:
            fail(f'Branch expr={expr!r}: expected {expected!r}, got {title!r}')
        await page.screenshot(
            path=str(OUT / f"02_branch_{expr[:24].replace(' ','_').replace('$','d').replace('.','_').replace('=','eq').replace('!','ne').replace('>','gt').replace('&','and').replace('\"','q')}.png")
        )


async def scenario_user_label_override(page: Page) -> None:
    print("\n[2] User label override + kind-eyebrow")
    await clear_canvas(page)
    await add_palette_node(page, "logic-loop")
    card = await card_locator(page, "logic", "loop")
    await select_node_by_card(page, card)
    await set_label_input(page, "Process all the things")
    await page.wait_for_timeout(200)
    title = await card_title_text(card)
    eyebrow = await card_eyebrow_text(card)
    if title == "Process all the things":
        ok(f'user label wins: title={title!r}')
    else:
        fail(f'user label override: expected title "Process all the things", got {title!r}')
    # The .eyebrow class applies CSS uppercasing, so inner_text() returns "LOOP".
    # Compare case-insensitively against the catalog kind label.
    if eyebrow and eyebrow.strip().lower() == "loop":
        ok(f'kind-eyebrow renders alongside: eyebrow={eyebrow!r}')
    else:
        fail(f'expected kind-eyebrow "Loop" alongside user label, got {eyebrow!r}')
    await page.screenshot(path=str(OUT / "03_user_label.png"))


async def scenario_loop_reduce_caption(page: Page) -> None:
    print("\n[3] Loop reduce caption")
    expectations = {
        "collect": "→ collects each output",
        "last":    "→ keeps last only",
        "count":   "→ emits iteration count",
        "none":    "→ discards output",
    }
    await clear_canvas(page)
    await add_palette_node(page, "logic-loop")
    card = await card_locator(page, "logic", "loop")
    await select_node_by_card(page, card)
    for value, caption in expectations.items():
        await set_loop_reduce(page, value)
        await page.wait_for_timeout(200)
        # Caption is rendered as a font-mono div under the headline.
        # Grab all font-mono blocks inside the card and look for one matching the expected caption.
        blocks = card.locator(".font-mono")
        n = await blocks.count()
        found = False
        for i in range(n):
            t = (await blocks.nth(i).inner_text()).strip()
            if t == caption:
                found = True
                break
        if found:
            ok(f"reduce={value!r} → caption {caption!r} rendered")
        else:
            fail(f'reduce={value!r}: caption {caption!r} not found on card')
        await page.screenshot(path=str(OUT / f"04_reduce_{value}.png"))


async def scenario_aggregate_step_summary(page: Page) -> None:
    print("\n[4] Aggregate step summary on Loop body")
    await clear_canvas(page)
    await add_palette_node(page, "logic-loop")
    # Step into the loop's body and add three children.
    await step_into(page, "logic", "loop", "body")
    await add_palette_node(page, "http-request")
    await add_palette_node(page, "transform-map")
    await add_palette_node(page, "http-request")
    await back_to_main(page)
    await page.wait_for_timeout(300)
    card = await card_locator(page, "logic", "loop")

    # Aggregate row: tabular-nums "3 steps" + " · " + truncated kinds list.
    expected_count = "3 steps"
    expected_kinds = "API Call · Transform · API Call"
    # The summary row is the first font-mono row inside the container body block
    # that has both the step count tabular-nums span and the kinds span.
    rows = card.locator(".font-mono")
    n = await rows.count()
    summary_text = None
    for i in range(n):
        t = (await rows.nth(i).inner_text()).strip()
        if "steps" in t and "API Call" in t:
            summary_text = t
            break
    if summary_text is None:
        fail("aggregate step summary row not found on Loop card")
    else:
        # The DOM shape is: "<count>\n·\n<kinds>" or similar — text contains
        # both fragments and the count "3 steps" (or "3 steps · API Call · ...").
        if expected_count in summary_text and expected_kinds in summary_text:
            ok(f'aggregate summary contains "{expected_count}" and "{expected_kinds}"')
        else:
            fail(
                f'aggregate summary mismatch — expected to contain {expected_count!r} + {expected_kinds!r}, '
                f'got {summary_text!r}'
            )
    await page.screenshot(path=str(OUT / "05_aggregate_summary.png"))


async def scenario_branch_per_arm_captions(page: Page) -> None:
    print("\n[5] Per-branch captions on Branch arms")
    await clear_canvas(page)
    await add_palette_node(page, "logic-branch")
    card = await card_locator(page, "logic", "branch")
    await select_node_by_card(page, card)
    await set_branch_expression(page, '$.status == "approved"')
    await page.wait_for_timeout(200)

    # Per-branch rows are buttons with testid branch-header-{nodeId}-true / -false.
    # Each one renders {label} + {caption}. The caption text for TRUE is
    # 'if $.status == "approved"' and for FALSE is 'else'.
    true_btn = page.locator('[data-testid^="branch-header-"][data-testid$="-true"]').first
    false_btn = page.locator('[data-testid^="branch-header-"][data-testid$="-false"]').first

    true_text = (await true_btn.inner_text()).strip()
    false_text = (await false_btn.inner_text()).strip()

    if 'if $.status == "approved"' in true_text:
        ok(f'TRUE arm caption matches: {true_text!r}')
    else:
        fail(f'TRUE arm should contain \'if $.status == "approved"\', got {true_text!r}')
    if "else" in false_text.lower():
        ok(f'FALSE arm caption matches: {false_text!r}')
    else:
        fail(f'FALSE arm should contain "else", got {false_text!r}')

    await page.screenshot(path=str(OUT / "06_branch_arm_captions.png"))


async def scenario_nested_context_panel(page: Page) -> None:
    print("\n[6] NestedContextPanel — visibility / depth / nav")

    # 6a — single-level dive: Loop body
    await clear_canvas(page)
    await add_palette_node(page, "logic-loop")
    # Set a label so the trail card is identifiable.
    card = await card_locator(page, "logic", "loop")
    await select_node_by_card(page, card)
    await set_loop_over(page, "$.invoices")
    await page.wait_for_timeout(200)
    await step_into(page, "logic", "loop", "body")

    panel = page.locator('[data-testid="nested-context-panel"]')
    if await panel.count() != 1 or not await panel.first.is_visible():
        fail("NestedContextPanel did not appear after step-into Loop body")
    else:
        ok("NestedContextPanel visible after 1-level dive")
    # Exactly one ancestor card at this depth.
    steps = page.locator('[data-testid^="nested-context-step-"]')
    nsteps = await steps.count()
    if nsteps == 1:
        ok(f"trail has 1 ancestor card (got {nsteps})")
    else:
        fail(f"trail expected 1 card after 1-level dive, got {nsteps}")
    await page.screenshot(path=str(OUT / "07a_nested_one_level.png"))

    # 6b — 2-level dive: Branch arm INSIDE Loop body. Add a Branch child of the
    # current loop, then step into its TRUE arm.
    await add_palette_node(page, "logic-branch")
    # Set the branch expression so trail captions are populated.
    branch_card = await card_locator(page, "logic", "branch")
    await select_node_by_card(page, branch_card)
    await set_branch_expression(page, '$.amount > 1000')
    await page.wait_for_timeout(200)
    await step_into(page, "logic", "branch", "true")

    steps = page.locator('[data-testid^="nested-context-step-"]')
    nsteps = await steps.count()
    if nsteps == 2:
        ok(f"trail has 2 ancestor cards after 2-level dive (got {nsteps})")
    else:
        fail(f"trail expected 2 cards after 2-level dive, got {nsteps}")
    await page.screenshot(path=str(OUT / "07b_nested_two_levels.png"))

    # 6c — click the SHALLOWEST ancestor (step 0 = Loop) → focus pops up.
    shallow = page.locator('[data-testid="nested-context-step-0"]').first
    await shallow.click()
    await page.wait_for_timeout(350)
    steps = page.locator('[data-testid^="nested-context-step-"]')
    nsteps = await steps.count()
    if nsteps == 1:
        ok("clicking shallowest ancestor popped focus to that level (1 card now)")
    else:
        fail(f"after clicking shallowest ancestor, expected 1 trail card, got {nsteps}")
    await page.screenshot(path=str(OUT / "07c_nested_popped.png"))

    # 6d — click "back to main" → panel disappears entirely.
    await back_to_main(page)
    await page.wait_for_timeout(300)
    panel_after = page.locator('[data-testid="nested-context-panel"]')
    if await panel_after.count() == 0:
        ok("after back-to-main, NestedContextPanel disappeared")
    else:
        fail("NestedContextPanel still present after back-to-main")
    await page.screenshot(path=str(OUT / "07d_after_back_to_main.png"))


async def scenario_deep_selector_regression(page: Page) -> None:
    """
    Regression: clicking a node inside a Loop body must open the Transform
    editor (not the no-selection Run Plan view). selectedNode used to walk
    only root nodes — this session fixed it to recurse into branches.
    """
    print("\n[7] Deep selector regression — click a node inside a Loop body")
    await clear_canvas(page)
    await add_palette_node(page, "logic-loop")
    await step_into(page, "logic", "loop", "body")
    await add_palette_node(page, "transform-map")
    transform_card = await card_locator(page, "transform", "map")
    await select_node_by_card(page, transform_card)
    await page.wait_for_timeout(300)

    # The Transform editor renders an Expression textarea with placeholder "$.data.items".
    expr_ta = page.locator('textarea[placeholder="$.data.items"]')
    if await expr_ta.count() >= 1 and await expr_ta.first.is_visible():
        ok("Transform editor opened (Expression textarea present)")
    else:
        fail(
            "Deep-selector regression: clicking a Transform inside a Loop body did NOT open the editor "
            "(Expression textarea missing). selectedNode may not be recursing into branches."
        )

    # Also confirm we are NOT showing the "Run Plan" no-selection panel.
    # That panel renders the eyebrow "no_selection" when nodes is empty, or the
    # "Run Plan" header when nodes are present. If we see "Run Plan" while a
    # node is supposedly selected, that's the bug.
    run_plan_header = page.locator('h3:has-text("Run Plan")')
    if await run_plan_header.count() > 0 and await run_plan_header.first.is_visible():
        fail(
            "Deep-selector regression: 'Run Plan' header is showing in PropertiesPanel — selectedNode "
            "selector returned null even though a Transform inside a branch was clicked."
        )
    else:
        ok("PropertiesPanel is in editor mode, not Run Plan no-selection mode")

    await page.screenshot(path=str(OUT / "08_deep_selector_editor.png"))


# ---------- runner ----------


async def main() -> int:
    console_errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()
        page.on(
            "console",
            lambda m: console_errors.append(m.text)
            if m.type == "error" and "favicon" not in m.text.lower()
            else None,
        )
        page.on("pageerror", lambda e: console_errors.append(f"[pageerror] {e}"))

        # First navigation just to warm up.
        await goto_fresh(page)

        scenarios = [
            scenario_loop_label_derivation,
            scenario_branch_label_derivation,
            scenario_user_label_override,
            scenario_loop_reduce_caption,
            scenario_aggregate_step_summary,
            scenario_branch_per_arm_captions,
            scenario_nested_context_panel,
            scenario_deep_selector_regression,
        ]
        for s in scenarios:
            try:
                await s(page)
            except Exception as e:
                fail(f"scenario {s.__name__} threw: {e!r}")
                try:
                    await page.screenshot(
                        path=str(OUT / f"crash_{s.__name__}.png"), full_page=True
                    )
                except Exception:
                    pass

        await browser.close()

    print("\n" + "=" * 60)
    print(f"PASS: {PASS}    FAIL: {FAIL}")
    if FINDINGS:
        print("\nFindings:")
        for f in FINDINGS:
            print(f"  - {f}")
    if console_errors:
        # Surface but don't fail on console errors — many are unrelated dev-server noise.
        print(f"\nConsole/page errors observed: {len(console_errors)}")
        for e in console_errors[:8]:
            print(f"  {e}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

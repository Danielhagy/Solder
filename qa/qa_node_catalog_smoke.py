"""
Smoke test for the new Tier-1 leaf nodes recently added to the catalog
across the Data, Format, Math (folded into Data), String (folded into Data),
State, and Time groups.

For each (kind, action) we:
  1. Click the palette button (data-testid="palette-{kind}-{action}").
     Per Sidebar.handleAdd this appends a new stage holding the node.
  2. Wait for the new card (data-testid="node-{kind}-{action}") on the canvas.
  3. Click the card so it selects, opening the editor in PropertiesPanel.
  4. Read the right rail and assert the placeholder
     "No editor for {kind}.{action}." text is NOT present.
  5. Track console errors.

Between groups we click "Clear Canvas" to keep things tidy and capture a
full-page screenshot per group.

Run: python qa/qa_node_catalog_smoke.py
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = "http://localhost:5173"
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "node-catalog-smoke"
OUT.mkdir(parents=True, exist_ok=True)


# Group label -> list of (kind, action). Per the catalog, math.* and str.*
# are filed under the Data group (group: 'Data') even though their kind is
# math/str, so they go in the Data screenshot. Format/State/Time are their
# own groups.
GROUPS: dict[str, list[tuple[str, str]]] = {
    "Data": [
        ("data", "filter"),
        ("data", "sort"),
        ("data", "unique"),
        ("data", "pick"),
        ("data", "omit"),
        ("data", "rename"),
        ("math", "calc"),
        ("math", "round"),
        ("str", "concat"),
        ("str", "split"),
        ("str", "replace"),
        ("str", "trim"),
        ("str", "case"),
    ],
    "Format": [
        ("format", "json_to_csv"),
        ("format", "csv_to_json"),
        ("format", "base64_encode"),
        ("format", "base64_decode"),
        ("format", "url_encode"),
        ("format", "url_decode"),
        ("format", "hash"),
    ],
    "State": [
        ("state", "set"),
        ("state", "get"),
        ("state", "ulid"),
        ("state", "uuid"),
        ("state", "random_int"),
        ("state", "random_float"),
    ],
    "Time": [
        ("time", "now"),
        ("time", "parse"),
        ("time", "format"),
        ("time", "add"),
        ("time", "diff"),
    ],
}


def clear_canvas(page) -> None:
    """Click the 'Clear Canvas' button at the bottom of the sidebar via JS."""
    page.evaluate(
        """() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const target = buttons.find(b => (b.textContent || '').trim() === 'Clear Canvas');
          if (target) target.click();
        }"""
    )
    page.wait_for_timeout(250)


def reset_to_builder(page) -> None:
    """Navigate to the fresh builder."""
    page.goto(BUILDER, wait_until="networkidle")
    # Confirm the builder mounted by polling for the dropzone via JS rather
    # than Playwright's wait_for_selector. The dropzone has multiple
    # animation/transition phases that have caused .wait_for to time out
    # even when the element is plainly in the DOM.
    page.wait_for_function(
        "document.querySelector('[data-testid=\"empty-canvas-dropzone\"]') !== null",
        timeout=8000,
    )
    page.wait_for_timeout(200)


def add_and_check(page, kind: str, action: str, console_errors: list[str]) -> dict:
    """Click the palette button, wait for the card, click it, check editor."""
    result: dict = {
        "kind": kind,
        "action": action,
        "ok": False,
        "palette_found": False,
        "card_appeared": False,
        "selected": False,
        "editor_ok": False,
        "placeholder_text_present": False,
        "errors": [],
        "note": "",
    }
    palette_sel = f'[data-testid="palette-{kind}-{action}"]'
    node_sel = f'[data-testid="node-{kind}-{action}"]'

    # Snapshot console errors at the start so we can attribute new ones.
    err_baseline = len(console_errors)

    palette_btn = page.locator(palette_sel)
    if palette_btn.count() == 0:
        result["note"] = "palette button not found (missing data-testid?)"
        return result
    result["palette_found"] = True

    try:
        # An ember-particle canvas behind the palette intercepts Playwright's
        # actionability checks (the page is technically never "stable"). Click
        # the underlying DOM element directly via JS — handleAdd in Sidebar
        # only needs the React onClick handler to fire.
        ok = page.evaluate(
            """sel => {
              const el = document.querySelector(sel);
              if (!el) return false;
              el.click();
              return true;
            }""",
            palette_sel,
        )
        if not ok:
            result["note"] = "palette button missing from DOM at click time"
            return result
    except Exception as e:
        result["note"] = f"palette click failed: {e}"
        return result

    try:
        page.wait_for_function(
            f"document.querySelectorAll('[data-testid=\"node-{kind}-{action}\"]').length > 0",
            timeout=4000,
        )
        result["card_appeared"] = True
    except PWTimeout:
        result["note"] = "card never appeared on canvas"
        return result

    # Multiple cards of the same kind may exist after several adds; pick the
    # most recent (last in DOM order).
    try:
        ok = page.evaluate(
            """sel => {
              const els = document.querySelectorAll(sel);
              if (!els.length) return false;
              const el = els[els.length - 1];  // most recent card
              el.click();
              return true;
            }""",
            node_sel,
        )
        if not ok:
            result["note"] = "card vanished before selection"
            return result
        result["selected"] = True
    except Exception as e:
        result["note"] = f"card click failed: {e}"
        return result

    # PropertiesPanel renders KindEditor for the selected node; the
    # placeholder "No editor for {kind}.{action}." appears only if the
    # dispatcher fell through.
    page.wait_for_timeout(150)
    placeholder = f"No editor for {kind}.{action}."
    try:
        # Look in the right rail (an <aside> with glass-rail class). Search
        # the full page for the placeholder string — cheap and reliable.
        body_text = page.locator("body").inner_text()
    except Exception as e:
        result["note"] = f"could not read body text: {e}"
        return result

    if placeholder in body_text:
        result["placeholder_text_present"] = True
        result["note"] = f'placeholder "{placeholder}" visible — editor dispatcher mismatch'
    else:
        result["editor_ok"] = True

    # Capture any newly emitted console errors during this interaction.
    new_errors = console_errors[err_baseline:]
    result["errors"] = list(new_errors)

    result["ok"] = (
        result["palette_found"]
        and result["card_appeared"]
        and result["selected"]
        and result["editor_ok"]
        and not result["errors"]
    )
    return result


def main() -> int:
    summary: dict[str, list[dict]] = {}
    screenshots: dict[str, Path] = {}
    all_console_errors: dict[str, list[str]] = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        console_errors: list[str] = []

        def on_console(msg):
            if msg.type == "error":
                txt = msg.text
                if "favicon" in txt.lower():
                    return
                console_errors.append(txt)

        page.on("console", on_console)
        page.on("pageerror", lambda exc: console_errors.append(f"pageerror: {exc}"))

        reset_to_builder(page)

        for group_name, pairs in GROUPS.items():
            print(f"\n=== {group_name} ===")
            group_results: list[dict] = []
            group_err_baseline = len(console_errors)

            for kind, action in pairs:
                r = add_and_check(page, kind, action, console_errors)
                tag = "OK" if r["ok"] else "FAIL"
                detail = ""
                if r["note"]:
                    detail = f" — {r['note']}"
                if r["errors"]:
                    detail += f" — errors: {r['errors'][:2]}"
                print(f"  [{tag}] {kind}.{action}{detail}")
                group_results.append(r)

            summary[group_name] = group_results

            # Group screenshot before clearing.
            shot = OUT / f"{group_name.lower()}.png"
            try:
                page.screenshot(path=str(shot), full_page=True)
                screenshots[group_name] = shot
            except Exception as e:
                print(f"  screenshot failed: {e}")

            all_console_errors[group_name] = list(console_errors[group_err_baseline:])

            # Tear down for the next group.
            clear_canvas(page)
            page.wait_for_timeout(250)
            # If clear didn't fully reset (e.g. focus was inside a container),
            # navigate fresh as a belt-and-braces.
            try:
                page.wait_for_function(
                    "document.querySelector('[data-testid=\"empty-canvas-dropzone\"]') !== null",
                    timeout=2000,
                )
            except PWTimeout:
                reset_to_builder(page)

        browser.close()

    # ----- summary print -----
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    total = 0
    failed = 0
    for group, results in summary.items():
        print(f"\n{group}:")
        for r in results:
            total += 1
            mark = "PASS" if r["ok"] else "FAIL"
            if not r["ok"]:
                failed += 1
            tail = ""
            if not r["palette_found"]:
                tail = " (no palette button)"
            elif not r["card_appeared"]:
                tail = " (no card on canvas)"
            elif r["placeholder_text_present"]:
                tail = ' (placeholder "No editor for X" shown)'
            elif r["errors"]:
                tail = f" (console errors: {len(r['errors'])})"
            print(f"  {mark}  {r['kind']}.{r['action']}{tail}")
        if group in screenshots:
            print(f"  screenshot → {screenshots[group]}")
        if all_console_errors.get(group):
            print(f"  console errors during {group}: {len(all_console_errors[group])}")
            for e in all_console_errors[group][:3]:
                print(f"    - {e}")

    print(f"\n{total - failed}/{total} pairs OK")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

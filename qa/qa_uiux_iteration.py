"""
Focused QA for the UI/UX iteration: save-status indicator, shortcut overlay,
deleted-filter, run drawer, skeleton loaders, markdown in Docs.

Run: python qa/qa_uiux_iteration.py

Writes screenshots to qa/artifacts/iteration/.
Exits non-zero if any hard assertion fails.
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
import time
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright, Page

BASE = "http://localhost:5173"
API = "http://localhost:8000"
OUT = Path(__file__).parent / "artifacts" / "iteration"
OUT.mkdir(parents=True, exist_ok=True)

findings: list[str] = []
passes: list[str] = []


def ok(msg: str) -> None:
    print(f"  PASS {msg}")
    passes.append(msg)


def fail(msg: str) -> None:
    print(f"  FAIL {msg}")
    findings.append(msg)


async def shot(page: Page, name: str) -> None:
    path = OUT / f"{name}.png"
    await page.screenshot(path=str(path), full_page=False)
    print(f"  shot {path.name}")


async def section_save_status(page: Page) -> None:
    print("\n[1] save-status indicator")
    await page.goto(f"{BASE}/", wait_until="networkidle")
    await page.wait_for_selector('[data-testid="save-status"]', timeout=8000)
    await shot(page, "01_pristine")

    # Pristine: should read "untitled draft" (no dot, no dirty marker)
    dirty = await page.get_attribute('[data-testid="save-status"]', "data-dirty")
    if dirty == "false":
        ok("pristine canvas reads data-dirty=false")
    else:
        fail(f"pristine data-dirty={dirty!r} (want false)")

    # Rename triggers dirty
    name_input = page.locator('input[placeholder="Integration name"]')
    await name_input.fill("Iteration QA Test")
    await page.wait_for_timeout(300)
    dirty = await page.get_attribute('[data-testid="save-status"]', "data-dirty")
    if dirty == "true":
        ok("renaming flips data-dirty=true")
    else:
        fail(f"after rename data-dirty={dirty!r} (want true)")
    await shot(page, "02_dirty_after_rename")

    # Add a node so there's something to save
    palette_btn = page.locator('[data-testid="palette-http-request"]').first
    await palette_btn.click()
    await page.wait_for_timeout(400)

    # Save via ⌘S / Ctrl+S → dialog opens
    await page.keyboard.press("Control+s")
    await page.wait_for_timeout(400)
    save_btn = page.locator('.btn-primary:has-text("Save")')
    if await save_btn.count() > 0:
        await save_btn.first.click()
        await page.wait_for_timeout(1500)
        dirty = await page.get_attribute('[data-testid="save-status"]', "data-dirty")
        text = await page.text_content('[data-testid="save-status"]')
        if dirty == "false" and text and "saved" in text.lower():
            ok(f"after save data-dirty=false, text='{text.strip()}'")
        else:
            fail(f"after save data-dirty={dirty!r} text={text!r}")
        await shot(page, "03_saved_clean")
    else:
        fail("save dialog button not found via ⌘S")


async def section_shortcut_help(page: Page) -> None:
    print("\n[2] ? shortcut overlay")
    # Not in any text field at the moment (Save dialog closed). Press `?`.
    await page.keyboard.press("Escape")  # close any dialog
    await page.wait_for_timeout(200)
    # Click into a neutral area first to ensure focus isn't trapped
    await page.mouse.click(400, 400)
    await page.wait_for_timeout(150)
    await page.keyboard.press("Shift+?")
    await page.wait_for_timeout(300)
    help_visible = await page.locator('[data-testid="shortcut-help"]').count()
    if help_visible > 0:
        ok("? opens shortcut overlay")
        await shot(page, "04_shortcut_help")
    else:
        fail("? did not open shortcut overlay")
    # Dismiss
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(200)


async def section_integrations_filter(page: Page) -> None:
    print("\n[3] integrations deleted-filter")
    # Ensure at least one deleted integration exists so the banner renders.
    # Create via API then delete via API.
    await page.goto(f"{BASE}/integrations", wait_until="networkidle")

    # Create a disposable integration we'll soft-delete
    resp = await page.request.post(
        f"{API}/api/integrations",
        data=json.dumps({"name": f"Soft-deleted {int(time.time())}", "config": {"nodes": [], "variables": {}}}),
        headers={"Content-Type": "application/json"},
    )
    if not resp.ok:
        fail(f"POST /api/integrations -> {resp.status}")
        return
    created = await resp.json()
    del_resp = await page.request.delete(f"{API}/api/integrations/{created['id']}")
    if del_resp.status != 204:
        fail(f"DELETE /api/integrations -> {del_resp.status}")
        return

    await page.reload(wait_until="networkidle")
    await page.wait_for_timeout(400)

    toggle = page.locator('[data-testid="toggle-show-deleted"]')
    if await toggle.count() == 0:
        fail("show-deleted toggle not visible despite a soft-deleted row")
    else:
        ok("show-deleted toggle renders when a deleted row exists")
        await shot(page, "05_deleted_hidden_banner")
        await toggle.click()
        await page.wait_for_timeout(300)
        label = await toggle.text_content()
        if label and "hide deleted" in label:
            ok(f"toggle flipped to '{label.strip()}'")
        else:
            fail(f"toggle text after click: {label!r}")
        await shot(page, "06_deleted_shown_dimmed")


async def section_run_drawer(page: Page) -> None:
    print("\n[4] live run drawer")
    # Return to Builder with the saved integration; add another node for shape
    await page.goto(f"{BASE}/", wait_until="networkidle")
    # Ensure manual trigger so Run is enabled
    await page.click('[data-testid="trigger-pill-manual"]')
    await page.wait_for_timeout(150)
    # Drop two nodes so the plan has something to show
    await page.click('[data-testid="palette-http-request"]')
    await page.wait_for_timeout(150)
    await page.click('[data-testid="palette-output-passthrough"]')
    await page.wait_for_timeout(150)

    # Trigger a run
    await page.click('[data-testid="run-button"]')
    await page.wait_for_timeout(1000)
    drawer = page.locator('[data-testid="run-drawer"]')
    if await drawer.count() == 0:
        fail("run drawer did not mount after Run click")
        return
    ok("run drawer mounts on Run")
    await shot(page, "07_run_drawer_running")

    # Plan list should enumerate our dropped nodes
    plan = page.locator('[data-testid="run-plan"]')
    if await plan.count() == 0:
        fail("drawer missing run-plan list")
    else:
        rows = await page.locator('[data-testid^="run-plan-"]').count()
        if rows >= 1:
            ok(f"plan lists {rows} row(s)")
        else:
            fail("plan list is empty")

    # Wait for terminal state (backend may fail the call because URL is empty — that's fine, we just want a state change)
    for _ in range(40):  # ~32s
        txt = await drawer.text_content() or ""
        if any(k in txt for k in ("success", "failed", "timeout", "cancelled")):
            break
        await page.wait_for_timeout(800)
    await shot(page, "08_run_drawer_terminal")

    await page.click('[data-testid="run-drawer-close"]')
    await page.wait_for_timeout(300)


async def section_skeletons(page: Page) -> None:
    print("\n[5] skeleton loaders")
    # Use CDP to throttle the network so the skeletons are actually visible.
    ctx = page.context
    cdp = await ctx.new_cdp_session(page)
    await cdp.send(
        "Network.emulateNetworkConditions",
        {
            "offline": False,
            "latency": 1500,
            "downloadThroughput": 50_000,
            "uploadThroughput": 50_000,
        },
    )
    try:
        for route, tid in [
            ("/integrations", "integrations-skeleton"),
            ("/history", "runs-skeleton"),
            ("/docs", "specs-skeleton"),
        ]:
            nav = asyncio.create_task(page.goto(f"{BASE}{route}", wait_until="domcontentloaded"))
            # Give the page a breath to render the skeleton before the API resolves.
            await page.wait_for_timeout(400)
            try:
                await page.wait_for_selector(f'[data-testid="{tid}"]', timeout=2000)
                ok(f"{route} renders {tid}")
                await shot(page, f"09_skeleton_{tid}")
            except Exception:
                fail(f"{route} did not show {tid} within 2s")
            await nav
    finally:
        await cdp.send(
            "Network.emulateNetworkConditions",
            {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1},
        )


async def section_docs_markdown(page: Page) -> None:
    print("\n[6] real markdown on Docs")
    # Seed a spec directly via API so we have something to render
    spec = {
        "openapi": "3.0.0",
        "info": {"title": "QA Demo API", "version": "1.0.0", "description": "Tiny spec for markdown rendering."},
        "paths": {
            "/ping": {
                "get": {
                    "summary": "Ping",
                    "responses": {"200": {"description": "pong"}},
                }
            }
        },
    }
    resp = await page.request.post(
        f"{API}/api/openapi/fetch?url=data:application/json,{json.dumps(spec)}&name=QA-Demo",
        headers={"Content-Type": "application/json"},
    )
    # Playwright's request.post encodes params differently — fallback: use upload endpoint.
    if not resp.ok:
        form = {"file": {"name": "spec.json", "mimeType": "application/json", "buffer": json.dumps(spec).encode()}}
        resp = await page.request.post(f"{API}/api/openapi/upload?name=QA-Demo", multipart=form)
    if not resp.ok:
        fail(f"could not seed spec: {resp.status}")
        return

    await page.goto(f"{BASE}/docs", wait_until="networkidle")
    await page.wait_for_timeout(500)
    # Click the first spec
    cards = page.locator('[role="button"][tabindex="0"]')
    if await cards.count() == 0:
        fail("no spec cards rendered")
        return
    await cards.first.click()
    await page.wait_for_timeout(400)
    md = page.locator(".solder-md")
    if await md.count() == 0:
        fail("markdown container .solder-md not found")
    else:
        headings = await md.locator("h1, h2, h3").count()
        if headings >= 1:
            ok(f"markdown renders {headings} heading(s), not raw <pre>")
        else:
            fail("no headings in .solder-md — markdown not rendering")
    await shot(page, "10_docs_markdown")


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        console_errors: list[str] = []
        page.on(
            "console",
            lambda m: console_errors.append(f"{m.type}: {m.text}")
            if m.type == "error" and "favicon" not in m.text.lower()
            else None,
        )

        try:
            await section_save_status(page)
            await section_shortcut_help(page)
            await section_integrations_filter(page)
            await section_run_drawer(page)
            await section_skeletons(page)
            await section_docs_markdown(page)
        finally:
            await browser.close()

        print("\n" + "=" * 50)
        print(f"PASS: {len(passes)}    FAIL: {len(findings)}")
        if console_errors:
            print(f"Console errors ({len(console_errors)}):")
            for e in console_errors[:10]:
                print(f"  {e}")
        if findings:
            print("\nFailures:")
            for f in findings:
                print(f"  - {f}")
            return 1
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

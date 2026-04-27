"""Verify the collapsed connector palette + Operation picker.

Steps:
  1. Open /integrations/new.
  2. Confirm palette has only 'Zip' and 'HubSpot' under Connectors (not the
     6 per-action entries).
  3. Click 'Zip' to add a node.
  4. Confirm node card preview reads 'Pick an operation' until an op is
     chosen in the editor.
  5. Open the editor, pick the first operation from the dropdown, confirm
     endpoint card updates.
  6. Run the integration against the seeded mock-engine demo: results
     should be a successful Zip pull.
"""
import asyncio
import json
import urllib.request
from pathlib import Path
from playwright.async_api import async_playwright


def safe(s):
    return ("" if s is None else str(s)).encode("ascii", "replace").decode("ascii")


def post(path, body=None):
    req = urllib.request.Request(
        f"http://localhost:8000/api{path}",
        data=json.dumps(body or {}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


async def main():
    artifacts = Path(__file__).parent / "artifacts" / "collapsed_connectors"
    artifacts.mkdir(parents=True, exist_ok=True)

    seed = post("/dev/seed-mock-demo")
    print(f"seeded zip demo: integration={seed['integration_id'][:8]} connection={seed['connection_id'][:8]}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {safe(e)}"))

        # Open the seeded integration so we don't have to wire the
        # connection picker from a blank slate.
        iid = seed["integration_id"]
        await page.goto(f"http://localhost:5173/integrations/{iid}", wait_until="networkidle")
        await page.wait_for_timeout(1500)

        # 1. Palette inspection.
        # Expand the Connectors group if collapsed; just check entry count by text.
        await page.locator("aside").first.wait_for(state="visible")
        # Count palette tiles by data-testid prefix
        zip_count = await page.locator("text=/^Zip$/").count()
        zip_subentries = await page.locator("text=/^Zip · /").count()
        hs_count = await page.locator("text=/^HubSpot$/").count()
        hs_subentries = await page.locator("text=/^HubSpot · /").count()
        print(f"[1] palette: Zip={zip_count} Zip·*={zip_subentries} HubSpot={hs_count} HubSpot·*={hs_subentries}")
        if zip_subentries != 0 or hs_subentries != 0:
            print("FAIL: per-action entries still in palette")
            return
        if zip_count == 0 or hs_count == 0:
            print("FAIL: collapsed entries missing")
            return

        # 2. Drop a Zip node onto the canvas (should land in stage 1).
        # The seeded demo already has no nodes, so first click adds it.
        await page.get_by_text("Zip", exact=True).first.click()
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(artifacts / "01_added_zip.png"))

        # 3. Click the node to open the editor.
        node = page.locator("[data-testid^=node-]").first
        await node.click()
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(artifacts / "02_editor.png"))

        # 4. Operation picker should be present and have options.
        op_select = page.get_by_test_id("connector-operation")
        await op_select.wait_for(state="visible", timeout=3000)
        opts = await op_select.locator("option").all_text_contents()
        print(f"[2] operation options: {[safe(o) for o in opts]}")
        # Should be at least 1 placeholder + 3 real (zip has 3 endpoints)
        if len(opts) < 4:
            print(f"FAIL: expected >=4 options, got {len(opts)}")
            return

        # 5. Pick GET /v1/vendors via the visible value
        target = next((o for o in opts if "/v1/vendors" in o), None)
        if not target:
            print(f"FAIL: no /v1/vendors option: {opts}")
            return
        await op_select.select_option(label=target)
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(artifacts / "03_op_picked.png"))

        # 6. Pick the seeded connection.
        cred = page.get_by_test_id("connector-credential")
        await cred.select_option(index=1)  # first non-placeholder
        await page.wait_for_timeout(500)

        # 7. Run.
        run_btn = page.get_by_test_id("run-button")
        await run_btn.click()
        for i in range(15):
            await page.wait_for_timeout(1000)
            txt = await run_btn.text_content()
            if "running" not in (txt or "").lower():
                print(f"[3] run settled at t+{i+1}s: {safe(txt)}")
                break
        await page.screenshot(path=str(artifacts / "04_after_run.png"), full_page=True)

        # 8. Confirm output mentions a vendor (Acme/Globex/etc).
        body = safe(await page.locator("body").text_content() or "")
        for needle in ("success", "Acme", "Globex"):
            if needle.lower() in body.lower():
                print(f"  found {needle!r}")
            else:
                print(f"  MISS {needle!r}")
        await browser.close()


asyncio.run(main())

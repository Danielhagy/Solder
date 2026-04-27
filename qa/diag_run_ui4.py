"""Drive Run via UI on a real connector op against the seeded mock-engine demo."""
import asyncio
import json
import urllib.request
from pathlib import Path
from playwright.async_api import async_playwright


def safe(s):
    return ("" if s is None else str(s)).encode("ascii", "replace").decode("ascii")


async def main():
    artifacts = Path(__file__).parent / "artifacts" / "diag_run_ui4"
    artifacts.mkdir(parents=True, exist_ok=True)

    # 1. Seed + install a Zip.list_vendors node on the demo integration via API.
    seed = json.loads(
        urllib.request.urlopen(
            urllib.request.Request("http://localhost:8000/api/dev/seed-mock-demo", method="POST"),
            timeout=10,
        ).read()
    )
    iid = seed["integration_id"]
    cid = seed["connection_id"]
    cfg = {
        "nodes": [
            {
                "id": "ZIP_VENDORS_1",
                "kind": "zip",
                "action": "list_vendors",
                "stage": 1,
                "slot": 0,
                "config": {
                    "credential_id": cid,
                    "endpoint": {"path": "/v1/vendors", "method": "GET", "entity_type": "vendor"},
                    "pagination": {"mode": "none"},
                },
            }
        ],
        "variables": {},
    }
    req = urllib.request.Request(
        f"http://localhost:8000/api/integrations/{iid}",
        data=json.dumps({"config": cfg}).encode("utf-8"),
        method="PATCH",
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=10).read()
    print(f"prep: integration={iid} ready with one zip.list_vendors node")

    # 2. Drive the UI.
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {safe(e)}"))

        await page.goto(f"http://localhost:5173/integrations/{iid}", wait_until="networkidle")
        await page.wait_for_timeout(2000)
        await page.screenshot(path=str(artifacts / "01_loaded.png"))

        run_btn = page.get_by_test_id("run-button")
        print(f"run button text: {safe(await run_btn.text_content())}")

        await run_btn.click()
        for i in range(15):
            await page.wait_for_timeout(1000)
            txt = await run_btn.text_content()
            if "running" not in (txt or "").lower():
                print(f"[t+{i+1}s] settled: {safe(txt)}")
                break

        await page.screenshot(path=str(artifacts / "02_final.png"), full_page=True)

        # Pull status text from the drawer.
        body_text = await page.locator("body").text_content()
        body_text = safe(body_text or "")
        for needle in ("success", "failed", "Acme", "Globex", "vendor"):
            if needle.lower() in body_text.lower():
                idx = body_text.lower().find(needle.lower())
                print(f"  found {needle!r} -> ...{body_text[max(0, idx-40):idx+60]}...")
        await browser.close()


asyncio.run(main())

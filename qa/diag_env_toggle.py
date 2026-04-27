"""Verify the per-integration environment toggle reads + writes correctly.

Strategy:
  1. POST /integrations with environment=production, then load that
     integration in the browser. Toggle should read 'production' from the
     backend record.
  2. Click toggle to flip to sandbox; PATCH from the Run button (which
     persists environment) by triggering a run; reload; confirm toggle
     reads 'sandbox'.
"""
import asyncio
import json
import urllib.request
from pathlib import Path
from playwright.async_api import async_playwright


def safe(s):
    return ("" if s is None else str(s)).encode("ascii", "replace").decode("ascii")


def post(path, body):
    req = urllib.request.Request(
        f"http://localhost:8000/api{path}",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


async def main():
    artifacts = Path(__file__).parent / "artifacts" / "env_toggle"
    artifacts.mkdir(parents=True, exist_ok=True)

    integ = post("/integrations", {"name": "diag-env-ui", "environment": "production"})
    iid = integ["id"]
    print(f"created integration {iid[:8]} env=production")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {safe(e)}"))

        await page.goto(f"http://localhost:5173/integrations/{iid}", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        toggle = page.get_by_test_id("environment-toggle")
        await toggle.wait_for(state="visible", timeout=5000)
        env = await toggle.get_attribute("data-environment")
        await page.screenshot(path=str(artifacts / "01_loaded_production.png"))
        if env != "production":
            print(f"FAIL: expected production, got {env}")
            return
        print(f"[1] backend record loaded; toggle reads env={env}")

        # Click to flip to sandbox.
        await toggle.click()
        await page.wait_for_timeout(300)
        env = await toggle.get_attribute("data-environment")
        if env != "sandbox":
            print(f"FAIL: click didn't flip, env={env}")
            return
        print(f"[2] click flipped to env={env}")
        await page.screenshot(path=str(artifacts / "02_flipped_sandbox.png"))

        # Trigger a run — this persists environment along with config (per
        # Builder.runIntegration). Run won't actually do anything (no nodes)
        # but the PATCH will fire.
        run_btn = page.get_by_test_id("run-button")
        await run_btn.click()
        await page.wait_for_timeout(4000)

        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(1500)
        toggle = page.get_by_test_id("environment-toggle")
        env = await toggle.get_attribute("data-environment")
        await page.screenshot(path=str(artifacts / "03_after_reload.png"))
        if env != "sandbox":
            print(f"FAIL: did not persist after reload, env={env}")
            return
        print(f"[3] after reload, toggle reads env={env}")
        print("PASS: env toggle round-trips correctly")
        await browser.close()


asyncio.run(main())

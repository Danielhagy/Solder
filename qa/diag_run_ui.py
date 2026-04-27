"""Drive the frontend Run button to reproduce 'cant run integrations'."""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

# Force ASCII-safe output on Windows cp1252.
def safe(s):
    return ("" if s is None else str(s)).encode("ascii", "replace").decode("ascii")


async def main():
    artifacts = Path(__file__).parent / "artifacts" / "diag_run_ui"
    artifacts.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        console_msgs = []
        page.on("console", lambda m: console_msgs.append(safe(f"[{m.type}] {m.text}")))
        page.on("pageerror", lambda e: console_msgs.append(safe(f"[pageerror] {e}")))
        # Capture network errors
        net_errors = []
        page.on("response", lambda r: net_errors.append((r.status, r.url)) if r.status >= 400 else None)

        print("[1] goto /")
        await page.goto("http://localhost:5173/", wait_until="networkidle")
        await page.screenshot(path=str(artifacts / "01_home.png"))

        print("[2] goto /integrations/new")
        await page.goto("http://localhost:5173/integrations/new", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(artifacts / "02_builder_empty.png"))

        # Find the Run button
        run_btn = page.get_by_test_id("run-button")
        try:
            await run_btn.wait_for(state="visible", timeout=5000)
            disabled = await run_btn.is_disabled()
            text = await run_btn.text_content()
            print(f"[3] Run button text='{safe(text)}' disabled={disabled}")
        except Exception as e:
            print(f"[3] Run button not found: {e}")
            print("--- console:")
            for m in console_msgs[-20:]:
                print(f"    {m}")
            await browser.close()
            return

        # We need at least one node to run. Drop one onto canvas.
        # Let's check what's on the page first
        canvas = await page.query_selector(".react-flow")
        print(f"[4] react-flow present: {canvas is not None}")

        # Try clicking Run on empty canvas to see what happens
        print("[5] click Run on empty canvas")
        await run_btn.click()
        await page.wait_for_timeout(3000)
        await page.screenshot(path=str(artifacts / "03_after_run.png"))

        # Capture state
        text = await run_btn.text_content()
        print(f"    button now: {safe(text)}")

        # Check drawer
        drawer = await page.query_selector("[data-testid=run-drawer], [class*=drawer], [class*=Drawer]")
        print(f"    drawer present: {drawer is not None}")

        # Wait longer for run to settle
        print("[6] wait 8s for run to settle")
        await page.wait_for_timeout(8000)
        await page.screenshot(path=str(artifacts / "04_after_settle.png"), full_page=True)

        print("--- last 30 console msgs:")
        for m in console_msgs[-30:]:
            print(f"    {m}")
        print("--- HTTP errors:")
        for s, u in net_errors[-20:]:
            print(f"    {s} {u}")

        await browser.close()


asyncio.run(main())

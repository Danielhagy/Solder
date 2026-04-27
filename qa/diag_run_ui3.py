"""Drive Run with a connector op (Zip/HubSpot palette item)."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright


def safe(s):
    return ("" if s is None else str(s)).encode("ascii", "replace").decode("ascii")


async def main():
    artifacts = Path(__file__).parent / "artifacts" / "diag_run_ui3"
    artifacts.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        msgs = []
        page.on("console", lambda m: msgs.append(safe(f"[{m.type}] {m.text}")))
        page.on("pageerror", lambda e: msgs.append(safe(f"[pageerror] {e}")))
        net = []
        page.on("response", lambda r: net.append((r.status, r.request.method, r.url)) if "/api/" in r.url else None)

        await page.goto("http://localhost:5173/integrations/new", wait_until="networkidle")
        await page.wait_for_timeout(1500)

        # Click a connector op
        print("[1] click 'Zip - List vendors' in palette")
        z = page.locator("text=Zip").locator("text=List vendors").first
        # The palette shows "Zip · List vendors" — try matching that
        c = page.get_by_text("List vendors").first
        await c.click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(artifacts / "01_added.png"))

        print("[2] click Run")
        run_btn = page.get_by_test_id("run-button")
        await run_btn.click()

        for i in range(20):
            await page.wait_for_timeout(1000)
            txt = await run_btn.text_content()
            print(f"    [t+{i+1}s] btn={safe(txt)}")
            if "running" not in (txt or "").lower():
                break

        await page.screenshot(path=str(artifacts / "02_final.png"), full_page=True)

        # Print run drawer text
        drawer = page.locator("text=Live Run").locator("..").locator("..")
        try:
            drawer_text = await drawer.text_content(timeout=2000)
            print(f"--- drawer:\n{safe(drawer_text)[:1500]}")
        except Exception as e:
            print(f"--- drawer text fetch failed: {e}")

        print("--- API calls:")
        for s, m, u in net:
            print(f"    {s} {m} {u}")
        print("--- console:")
        for m in msgs:
            if any(t in m for t in ("[error]", "[warning]", "[pageerror]")):
                print(f"    {m}")

        await browser.close()


asyncio.run(main())

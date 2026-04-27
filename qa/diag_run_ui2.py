"""Drive the Run button with a real HTTP node configured."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright


def safe(s):
    return ("" if s is None else str(s)).encode("ascii", "replace").decode("ascii")


async def main():
    artifacts = Path(__file__).parent / "artifacts" / "diag_run_ui2"
    artifacts.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        console_msgs = []
        page.on("console", lambda m: console_msgs.append(safe(f"[{m.type}] {m.text}")))
        page.on("pageerror", lambda e: console_msgs.append(safe(f"[pageerror] {e}")))
        net = []
        page.on("response", lambda r: net.append((r.status, r.request.method, r.url)) if "/api/" in r.url else None)

        await page.goto("http://localhost:5173/integrations/new", wait_until="networkidle")
        await page.wait_for_timeout(1500)

        # Click the API Call palette item (or HTTP) to add it. The palette
        # uses click-to-add: clicking adds to the current/empty stage.
        print("[1] click 'API Call' in palette")
        api_btn = page.locator("text=API Call").first
        await api_btn.click()
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(artifacts / "01_after_add.png"))

        # Open the node properties to see what fields are required
        print("[2] click the placed node")
        # Try clicking near the canvas where the node would land
        node_card = page.locator("[data-id], .react-flow__node, [data-testid^=node-]").first
        try:
            await node_card.click(timeout=3000)
        except Exception as e:
            print(f"    click node failed: {e}")
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(artifacts / "02_after_node_click.png"))

        # Click Run
        print("[3] click Run")
        run_btn = page.get_by_test_id("run-button")
        await run_btn.click()

        # Wait long enough for full settle
        for i in range(15):
            await page.wait_for_timeout(1000)
            txt = await run_btn.text_content()
            print(f"    [t+{i+1}s] btn={safe(txt)}")
            if "running" not in (txt or "").lower():
                break

        await page.screenshot(path=str(artifacts / "03_final.png"), full_page=True)

        print("--- API calls:")
        for s, m, u in net:
            print(f"    {s} {m} {u}")
        print("--- console errors / warns:")
        for m in console_msgs:
            if any(t in m for t in ("[error]", "[warning]", "[pageerror]")):
                print(f"    {m}")

        await browser.close()


asyncio.run(main())

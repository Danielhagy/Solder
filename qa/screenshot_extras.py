"""One-off screenshots for the lists audit:
   - dialogs (Add API)
   - selected detail (History row click)
   - true light-mode (force via localStorage `solder-theme`)
"""
from __future__ import annotations
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

BASE = "http://localhost:5173"
OUT = Path(__file__).parent / "artifacts" / "screens" / "lists"
OUT.mkdir(parents=True, exist_ok=True)


async def shot(page, name: str):
    out = OUT / f"{name}.png"
    await page.screenshot(path=str(out))
    print(f"saved {out}")


async def force_theme(page, theme: str):
    # The store key depends on persist config; cover both common casings.
    await page.evaluate(
        """(t) => {
            try {
              const root = document.documentElement;
              if (t === 'dark') root.classList.add('dark'); else root.classList.remove('dark');
              localStorage.setItem('solder-theme', t);
            } catch (e) {}
        }""",
        theme,
    )


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
        page = await ctx.new_page()

        # 1. Light-mode integrations / history / docs (force via DOM class)
        await page.goto(BASE + "/integrations", wait_until="networkidle")
        await force_theme(page, "light")
        await page.wait_for_timeout(400)
        await shot(page, "integrations-light-forced")

        await page.goto(BASE + "/history", wait_until="networkidle")
        await force_theme(page, "light")
        await page.wait_for_timeout(400)
        await shot(page, "history-light-forced")

        # 2. History detail selected
        first = await page.query_selector("[data-testid^='run-row-']")
        if first:
            await first.click()
            await page.wait_for_timeout(800)
            await shot(page, "history-detail-light")

        # dark detail too
        await force_theme(page, "dark")
        await page.wait_for_timeout(300)
        await shot(page, "history-detail-dark")

        # 3. Docs page light + Add API dialog
        await page.goto(BASE + "/docs", wait_until="networkidle")
        await force_theme(page, "light")
        await page.wait_for_timeout(400)
        await shot(page, "docs-light-forced")

        # click first spec to view detail
        first_spec = await page.query_selector(".card[role='button']")
        if first_spec:
            await first_spec.click()
            await page.wait_for_timeout(600)
            await shot(page, "docs-detail-light")

        # Add API dialog
        await page.click("text=Add API")
        await page.wait_for_timeout(400)
        await shot(page, "docs-dialog-light")

        await force_theme(page, "dark")
        await page.wait_for_timeout(300)
        await shot(page, "docs-dialog-dark")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

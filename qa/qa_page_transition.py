"""
Capture mid-transition frames between top-nav routes to verify the
new cross-fade-blur transition is smooth, not janky. Output:
qa/artifacts/page-transition/.

Usage: python qa/qa_page_transition.py
"""
from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

BASE = "http://localhost:5173"
OUT = Path(__file__).parent / "artifacts" / "page-transition"
OUT.mkdir(parents=True, exist_ok=True)


async def capture_transition(page, from_path: str, to_path: str, label: str) -> None:
    """Click a nav link to navigate, capture frames mid-transition."""
    print(f"\n=== {label}: {from_path} → {to_path} ===")
    await page.goto(f"{BASE}{from_path}", wait_until="networkidle")
    await page.wait_for_timeout(300)
    await page.screenshot(path=str(OUT / f"{label}_00_before.png"), full_page=False)
    print(f"  before: {label}_00_before.png")

    # Click the nav link by exact text match. The links are inside the
    # pill-rail at the top of every page.
    nav_label_for = {
        "/": "Dashboard",
        "/integrations": "Integrations",
        "/runs": "Runs",
        "/mocks": "Mocks",
    }
    target_label = nav_label_for[to_path]

    # Synchronously start the navigation, then sample frames during the
    # transition. ~80ms / 160ms / 240ms / 320ms covers the 280ms window.
    await page.evaluate(
        """(label) => {
            const link = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === label);
            if (link) link.click();
        }""",
        target_label,
    )

    for ms, frame in [(80, "01"), (160, "02"), (240, "03"), (340, "04")]:
        await page.wait_for_timeout(ms - (80 if frame != "01" else 0))
        await page.screenshot(path=str(OUT / f"{label}_{frame}_at_{ms}ms.png"), full_page=False)
        print(f"  +{ms}ms: {label}_{frame}_at_{ms}ms.png")

    # Final settle
    await page.wait_for_timeout(400)
    await page.screenshot(path=str(OUT / f"{label}_05_settled.png"), full_page=False)
    print(f"  settled: {label}_05_settled.png")


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        # NOT setting reduced_motion here — we want to actually SEE the
        # transition mid-flight. Other harnesses use reduced_motion for
        # actionability; this one is for visual capture only.
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        await capture_transition(page, "/", "/integrations", "01_dashboard_to_integrations")
        await capture_transition(page, "/integrations", "/runs", "02_integrations_to_runs")
        await capture_transition(page, "/runs", "/mocks", "03_runs_to_mocks")
        await capture_transition(page, "/mocks", "/", "04_mocks_to_dashboard")

        await browser.close()
        print(f"\ndone -> {OUT}")


if __name__ == "__main__":
    asyncio.run(main())

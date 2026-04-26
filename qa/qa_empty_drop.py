"""
Regression: dragging a palette node onto the empty canvas must create a stage.
Also covers empty-branch drops after step-into'ing a Loop.
Run: python qa/qa_empty_drop.py
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
OUT = Path(__file__).parent / "artifacts" / "emptydrop"
OUT.mkdir(parents=True, exist_ok=True)


async def drag_palette_to(
    page, palette_testid: str, target_selector: str
) -> None:
    """Playwright's built-in drag_to doesn't carry HTML5 dataTransfer MIME
    types the way the real browser does, so for tests that rely on custom
    MIMEs (DND_MIME_NEW) we dispatch events manually."""
    await page.evaluate(
        """
        ({paletteSel, targetSel}) => {
          const src = document.querySelector(paletteSel);
          const tgt = document.querySelector(targetSel);
          if (!src || !tgt) throw new Error('selector missing');
          const dt = new DataTransfer();
          // Match what Sidebar sets: DND_MIME_NEW and the JSON payload.
          // Testids are 'palette-<kind>-<action>' per the catalog.
          const m = paletteSel.match(/palette-([^-\\]]+)-([^"]+)/);
          const kind = m[1];
          const action = m[2];
          dt.setData('application/x-solder-new', JSON.stringify({ kind, action }));
          src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          tgt.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
          tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, cancelable: true }));
          tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, cancelable: true }));
          src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        }
        """,
        {"paletteSel": palette_testid, "targetSel": target_selector},
    )


async def main() -> int:
    findings: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        errors: list[str] = []
        page.on(
            "console",
            lambda m: errors.append(m.text)
            if m.type == "error" and "favicon" not in m.text.lower()
            else None,
        )

        print("\n[1] Empty canvas → drop API Call on the start dropzone")
        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.wait_for_selector('[data-testid="empty-canvas-dropzone"]', timeout=5000)
        await page.screenshot(path=str(OUT / "01_empty_with_dropzone.png"))

        await drag_palette_to(
            page,
            '[data-testid="palette-http-request"]',
            '[data-testid="empty-canvas-dropzone"]',
        )
        await page.wait_for_timeout(400)
        count = await page.locator('[data-testid="node-http-request"]').count()
        if count != 1:
            findings.append(f"expected 1 api-call node after drop, got {count}")
        else:
            print("  OK: API Call node landed on empty canvas")
        await page.screenshot(path=str(OUT / "02_after_first_drop.png"))

        print("\n[2] Step into a Loop's empty BODY → drop on branch dropzone")
        # Fresh canvas
        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.wait_for_timeout(300)
        # Click the Loop in palette to add at root
        await page.click('[data-testid="palette-logic-loop"]')
        await page.wait_for_timeout(300)
        # Step into the Loop via the compact branch row
        step_btn = page.locator('[data-testid^="branch-header-"]').first
        await step_btn.click()
        await page.wait_for_timeout(500)
        # Should land in the empty BODY view with its own dropzone
        await page.wait_for_selector('[data-testid="empty-canvas-dropzone"]', timeout=5000)
        await page.screenshot(path=str(OUT / "03_inside_empty_loop_body.png"))
        await drag_palette_to(
            page,
            '[data-testid="palette-transform-map"]',
            '[data-testid="empty-canvas-dropzone"]',
        )
        await page.wait_for_timeout(400)
        tcount = await page.locator('[data-testid="node-transform-map"]').count()
        if tcount != 1:
            findings.append(f"after drop into BODY expected 1 transform, got {tcount}")
        else:
            print("  OK: Transform node landed inside the Loop body")
        await page.screenshot(path=str(OUT / "04_body_populated.png"))

        await browser.close()

    print("\n" + "=" * 50)
    if errors:
        print(f"Console errors: {len(errors)}")
        for e in errors[:6]:
            print(f"  {e}")
    if findings:
        print(f"FAIL — {len(findings)} finding(s):")
        for f in findings:
            print(f"  - {f}")
        return 1
    print("All assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

"""
Focused QA on the step-into flight transition. Drops a Loop onto the canvas,
clicks step-into, captures frames during the transition, records console
errors, and checks for DOM sanity (breadcrumb appears, scene key swaps,
no stuck `.solder-diving` classes).

Run: python qa/qa_zoom_transition.py
Artifacts: qa/artifacts/zoom/
"""
from __future__ import annotations

import asyncio
import io
import sys
import time
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright, Page

BASE = "http://localhost:5173"
# Builder is reached *through* an integration; fresh canvas at /integrations/new.
BUILDER = f"{BASE}/integrations/new"
OUT = Path(__file__).parent / "artifacts" / "zoom"
OUT.mkdir(parents=True, exist_ok=True)

findings: list[str] = []


async def shot(page: Page, name: str) -> None:
    path = OUT / f"{name}.png"
    await page.screenshot(path=str(path), full_page=False)


async def capture_frames(page: Page, prefix: str, count: int, interval_ms: int) -> None:
    """Capture `count` screenshots spaced `interval_ms` apart. Lets us eyeball
    the transition frame-by-frame."""
    for i in range(count):
        await shot(page, f"{prefix}_{i:02d}")
        await page.wait_for_timeout(interval_ms)


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        # See qa_empty_drop.py — reduced_motion="reduce" disables the
        # EmberCanvas rAF + solderNodeIn keyframes so Playwright stability
        # checks land. The framer-motion scene-zoom variants already
        # honour useReducedMotion(), which means under this flag the
        # exit/enter transitions become a fast cross-fade — fine for
        # functional testing, no longer the >500 ms long-task burner.
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            reduced_motion="reduce",
        )
        page = await context.new_page()

        errors: list[str] = []
        warnings: list[str] = []
        page.on(
            "console",
            lambda m: (
                errors.append(m.text)
                if m.type == "error" and "favicon" not in m.text.lower()
                else warnings.append(m.text) if m.type == "warning" else None
            ),
        )

        try:
            print("\n=== STEP 1 ===  Navigate, drop a Loop container")
            await page.goto(BUILDER, wait_until="networkidle")
            await page.wait_for_selector('[data-testid="palette-logic-loop"]', timeout=5000)
            await page.click('[data-testid="palette-logic-loop"]')
            await page.wait_for_timeout(300)
            await shot(page, "01_after_loop_added")
            loops = await page.locator('[data-testid="node-logic-loop"]').count()
            if loops != 1:
                findings.append(f"expected 1 loop node, got {loops}")
            else:
                print("  OK: 1 loop visible")

            # Confirm step-into button exists
            step_btn = page.locator('[data-testid="step-into-logic-loop"]')
            if await step_btn.count() == 0:
                findings.append("step-into-logic-loop button not found on Loop node")
                return _finalize(errors, warnings)

            print("\n=== STEP 2 ===  Click step-into, capture transition frames")
            # Measure perf around the click
            await page.evaluate("performance.mark('step-into-start')")
            t0 = time.monotonic()
            await step_btn.click()
            # Capture densely during the transition (~500ms total for motion to settle)
            await capture_frames(page, "02_transition", count=8, interval_ms=50)
            elapsed = time.monotonic() - t0
            print(f"  Click → settle captured in {elapsed:.2f}s")

            # Verify we're inside the loop. The in-canvas breadcrumb was
            # removed in the builder-design-pass; NestedContextPanel in the
            # sidebar is the new step-into indicator.
            crumb = page.locator('[data-testid="nested-context-panel"]')
            if await crumb.count() == 0:
                findings.append("no nested-context-panel after step-into")
            else:
                crumb_text = (await crumb.text_content()) or ""
                if "BODY" not in crumb_text.upper() and "LOOP" not in crumb_text.upper():
                    findings.append(f"context panel missing expected labels: {crumb_text!r}")
                else:
                    print(f"  OK: context panel reads {crumb_text.strip()[:60]!r}")

            await page.wait_for_timeout(400)
            await shot(page, "03_inside_loop_body")

            print("\n=== STEP 3 ===  Check for stuck .solder-diving classes")
            stuck = await page.evaluate("document.querySelectorAll('.solder-diving').length")
            if stuck > 0:
                findings.append(f".solder-diving class still present on {stuck} element(s)")
            else:
                print("  OK: no stuck diving classes")

            print("\n=== STEP 4 ===  Press Esc to pop out, capture frames")
            await page.keyboard.press("Escape")
            await capture_frames(page, "04_popout", count=8, interval_ms=50)
            crumb_count = await page.locator('[data-testid="nested-context-panel"]').count()
            if crumb_count != 0:
                findings.append(
                    f"nested-context-panel should be gone after esc, still {crumb_count} visible"
                )
            else:
                print("  OK: nested-context-panel gone after pop")
            await shot(page, "05_popped_out")

            print("\n=== STEP 5 ===  Rapid step-into + pop stress test")
            # Fire 5 step-in / step-out cycles back to back to check for
            # accumulated state or race conditions between the 120ms delay
            # in triggerDive() and the Framer exit animation.
            for i in range(5):
                await step_btn.click()
                await page.wait_for_timeout(200)
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(200)
            await shot(page, "06_after_rapid_cycles")
            stuck = await page.evaluate("document.querySelectorAll('.solder-diving').length")
            if stuck > 0:
                findings.append(f"after rapid cycles, {stuck} stuck .solder-diving")

            # Final: is the loop still on the canvas exactly once?
            loops = await page.locator('[data-testid="node-logic-loop"]').count()
            if loops != 1:
                findings.append(f"after rapid cycles expected 1 loop, got {loops}")
            else:
                print("  OK: loop still present exactly once")

            print("\n=== STEP 6 ===  Branch-header path (the 'other place to step in')")
            # The loop body has a branch header (▸ BODY) that also triggers
            # step-into. Pop to root first.
            await page.wait_for_timeout(300)
            branch_hdr = page.locator('[data-testid^="branch-header-"]').first
            if await branch_hdr.count() > 0:
                await branch_hdr.click()
                await capture_frames(page, "07_branchhdr", count=8, interval_ms=50)
                crumb_text = (
                    (await page.locator('[data-testid="nested-context-panel"]').text_content())
                    or ""
                )
                if "BODY" not in crumb_text.upper():
                    findings.append(
                        f"branch-header step-in didn't land in BODY: {crumb_text!r}"
                    )
                else:
                    print("  OK: branch-header click lands in BODY")
                await shot(page, "08_after_branchhdr_in")
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(400)
            else:
                print("  SKIP: no branch-header selector found (possibly collapsed)")

            print("\n=== STEP 7 ===  Measure long tasks during a single step-in")
            # Use the Long Tasks API via CDP to catch blocking > 50ms jank.
            cdp = await context.new_cdp_session(page)
            await cdp.send("Performance.enable")
            await page.evaluate(
                """
                window.__longTasks = [];
                const obs = new PerformanceObserver((list) => {
                    for (const e of list.getEntries()) {
                        window.__longTasks.push({ name: e.name, duration: e.duration, start: e.startTime });
                    }
                });
                try { obs.observe({ entryTypes: ['longtask'] }); } catch {}
                """
            )
            await step_btn.click()
            await page.wait_for_timeout(600)
            long_tasks = await page.evaluate("window.__longTasks || []")
            if long_tasks:
                print(f"  Long tasks during step-in: {len(long_tasks)}")
                for t in long_tasks[:5]:
                    ms = t.get("duration", 0)
                    if ms > 80:
                        findings.append(f"long task during step-in: {ms:.0f}ms")
                    print(f"    {ms:.0f}ms  {t.get('name')}")
            else:
                print("  No long tasks observed")
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(300)

        finally:
            await browser.close()

        return _finalize(errors, warnings)


def _finalize(errors: list[str], warnings: list[str]) -> int:
    print("\n" + "=" * 52)
    if errors:
        print(f"Console errors ({len(errors)}):")
        for e in errors[:20]:
            print(f"  {e}")
    if warnings:
        print(f"Console warnings ({len(warnings)}):")
        for w in warnings[:10]:
            print(f"  {w}")
    if findings:
        print(f"\nFAIL — {len(findings)} finding(s):")
        for f in findings:
            print(f"  - {f}")
        return 1
    print("\nAll assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

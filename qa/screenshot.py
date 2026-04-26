"""
UI screenshot helper for Solder. Drives the running frontend via Playwright,
optionally interacts, then saves a PNG under qa/artifacts/screens/.

Examples:
  python qa/screenshot.py --name builder
  python qa/screenshot.py --name phantom --selector "[data-testid=stages-graph], main"
  python qa/screenshot.py --name phantom-with-node --add-node palette-http-request
"""
from __future__ import annotations

import argparse
import asyncio
import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

BASE = "http://localhost:5173"
OUT = Path(__file__).parent / "artifacts" / "screens"
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="output PNG name (no extension)")
    ap.add_argument("--route", default="/", help="route to load (default /)")
    ap.add_argument("--selector", default=None, help="CSS selector to crop to")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument(
        "--add-node",
        action="append",
        default=[],
        help="palette testid to click before screenshotting (repeat for multiple)",
    )
    ap.add_argument("--theme", choices=["light", "dark"], default="light")
    ap.add_argument("--wait-ms", type=int, default=500)
    args = ap.parse_args()

    out = OUT / f"{args.name}.png"
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": args.width, "height": args.height},
            color_scheme=args.theme,
        )
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {e}", file=sys.stderr))

        await page.goto(BASE + args.route, wait_until="networkidle")
        await page.wait_for_timeout(args.wait_ms)

        for testid in args.add_node:
            sel = f'[data-testid="{testid}"]'
            try:
                await page.click(sel, timeout=3000)
                await page.wait_for_timeout(args.wait_ms)
            except Exception as e:
                print(f"click failed for {sel!r}: {e}", file=sys.stderr)

        if args.selector:
            el = await page.query_selector(args.selector)
            if el is None:
                print(f"selector not found: {args.selector!r}; using viewport", file=sys.stderr)
                await page.screenshot(path=str(out))
            else:
                await el.screenshot(path=str(out))
        else:
            await page.screenshot(path=str(out))

        await browser.close()
        print(f"saved {out}")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

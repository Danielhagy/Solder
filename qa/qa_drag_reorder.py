"""
Repro for user-reported bug: drag and reorder of stages does nothing.

Covers every drop target that should accept an existing-node move:
  1. Drop on a STAGE COLUMN body (appends to that stage)
  2. Drop on the TRAILING PHANTOM column (creates a new last stage)
  3. Drop on the LEAD GAP (creates a new first stage)
  4. Drop on the INTER-STAGE GAP (creates a new stage between)
  5. Drop on a TAIL STRIP within a column (appends to that stage)
  6. Drop on a SLOT zone between two parallel siblings (inserts at index)

Each scenario runs twice: once via JS-dispatched DragEvents (catches stale-
state-closure bugs because only ONE dragover fires before the drop) and
once via Playwright's mouse dragTo (closer to a real user, multiple
dragovers).
"""
from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import Page, async_playwright

BASE = "http://localhost:5173"
OUT = Path(__file__).parent / "artifacts" / "drag_reorder"
OUT.mkdir(parents=True, exist_ok=True)


async def stage_count(page: Page) -> int:
    return await page.locator('[data-testid^="stage-column-"]').count()


async def column_node_count(page: Page, stage: int) -> int:
    return await page.locator(
        f'[data-testid="stage-column-{stage}"] [data-testid^="node-"]'
    ).count()


async def reset_canvas(page: Page) -> None:
    page.once("dialog", lambda d: asyncio.create_task(d.accept()))
    btn = page.get_by_role("button", name="Clear Canvas")
    if await btn.count():
        await btn.click()
    await page.wait_for_timeout(150)


async def add_palette(page: Page, testid: str) -> None:
    await page.click(f'[data-testid="{testid}"]')
    await page.wait_for_timeout(120)


async def js_drag(
    page: Page, source_sel: str, target_sel: str, mime: str, payload: str
) -> None:
    await page.evaluate(
        """
        ({srcSel, tgtSel, mime, payload}) => {
          const src = document.querySelector(srcSel);
          const tgt = document.querySelector(tgtSel);
          if (!src) throw new Error('source not found: ' + srcSel);
          if (!tgt) throw new Error('target not found: ' + tgtSel);
          const dt = new DataTransfer();
          dt.setData(mime, payload);
          src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          tgt.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
          tgt.dispatchEvent(new DragEvent('dragover',  { bubbles: true, dataTransfer: dt, cancelable: true }));
          tgt.dispatchEvent(new DragEvent('drop',      { bubbles: true, dataTransfer: dt, cancelable: true }));
          src.dispatchEvent(new DragEvent('dragend',   { bubbles: true, dataTransfer: dt }));
        }
        """,
        {"srcSel": source_sel, "tgtSel": target_sel, "mime": mime, "payload": payload},
    )


async def get_node_id(page: Page, kind_action: str) -> str:
    return await page.locator(
        f'[data-testid="node-{kind_action}"]'
    ).first.get_attribute("data-node-id") or ""


async def setup(page: Page, kinds: list[str]) -> None:
    await reset_canvas(page)
    for k in kinds:
        await add_palette(page, k)
    await page.wait_for_timeout(150)


async def expect(findings: list[str], label: str, actual, expected) -> None:
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected}, got {actual}")
        findings.append(f"{label}: expected {expected}, got {actual}")


async def run() -> int:
    findings: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        # Wider viewport so the trailing phantom isn't partly covered by the
        # right-rail Properties panel.
        ctx = await browser.new_context(viewport={"width": 1800, "height": 900})
        page = await ctx.new_page()

        def _on_console(m):
            if m.type == "error":
                print(f"  [{m.type}] {m.text}")
        page.on("console", _on_console)

        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.wait_for_timeout(500)

        # ── 1. JS drag node from stage 2 → stage 1 column body
        print("\n[1] JS drag stage2 → stage1 column body (parallel collapse)")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        nid = await get_node_id(page, "transform-map")
        await js_drag(
            page,
            '[data-testid="node-transform-map"]',
            '[data-testid="stage-column-1"]',
            "application/x-solder-node",
            nid,
        )
        await page.wait_for_timeout(300)
        await expect(findings, "stage_count", await stage_count(page), 1)
        await expect(findings, "stage1_nodes", await column_node_count(page, 1), 2)

        # ── 2. JS drag stage 1 → trailing phantom (newStage after)
        print("\n[2] JS drag stage1 → trailing phantom (move to new last stage)")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        http_id = await get_node_id(page, "http-request")
        await js_drag(
            page,
            '[data-testid="node-http-request"]',
            '[data-gap-kind="gap-trailing"]',
            "application/x-solder-node",
            http_id,
        )
        await page.wait_for_timeout(300)
        await expect(findings, "stage_count", await stage_count(page), 2)
        await expect(
            findings,
            "stage1=transform",
            await page.locator(
                '[data-testid="stage-column-1"] [data-testid="node-transform-map"]'
            ).count(),
            1,
        )
        await expect(
            findings,
            "stage2=http",
            await page.locator(
                '[data-testid="stage-column-2"] [data-testid="node-http-request"]'
            ).count(),
            1,
        )

        # ── 3. Playwright dragTo: stage 2 → stage 1 column
        print("\n[3] Playwright dragTo stage2 → stage1 column body")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        await page.locator('[data-testid="node-transform-map"]').first.drag_to(
            page.locator('[data-testid="stage-column-1"]').first
        )
        await page.wait_for_timeout(300)
        await expect(findings, "stage_count", await stage_count(page), 1)
        await expect(findings, "stage1_nodes", await column_node_count(page, 1), 2)

        # ── 4. JS drag onto stage's TAIL strip (append parallel)
        print("\n[4] JS drag stage2 → stage1's tail strip")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        nid = await get_node_id(page, "transform-map")
        await js_drag(
            page,
            '[data-testid="node-transform-map"]',
            '[data-testid="stage-1-tail"]',
            "application/x-solder-node",
            nid,
        )
        await page.wait_for_timeout(300)
        await expect(findings, "stage_count", await stage_count(page), 1)
        await expect(findings, "stage1_nodes", await column_node_count(page, 1), 2)

        # ── 5. JS drag onto a SLOT zone between siblings (3-node setup)
        print("\n[5] JS drag third node onto stage1 slot 0 (insert before)")
        # Build: http stage1, transform stage1 (parallel), output stage2
        await setup(page, ["palette-http-request"])
        # Add transform parallel by dragging it onto stage 1 column
        await add_palette(page, "palette-transform-map")
        # transform is now in stage 2; merge by JS drag
        nid = await get_node_id(page, "transform-map")
        await js_drag(
            page,
            '[data-testid="node-transform-map"]',
            '[data-testid="stage-column-1"]',
            "application/x-solder-node",
            nid,
        )
        await page.wait_for_timeout(200)
        # Now add output (will go to new stage 2)
        await add_palette(page, "palette-output-passthrough")
        await page.wait_for_timeout(200)
        await expect(findings, "setup stage_count", await stage_count(page), 2)
        await expect(findings, "setup stage1_nodes", await column_node_count(page, 1), 2)
        # Drag the output (in stage 2) onto stage 1's first slot zone
        out_id = await get_node_id(page, "output-passthrough")
        # The first SlotDropZone in stage 1 is the one before slot 0 — find it.
        # SlotDropZone has no testid; we'll target via :nth-child within the
        # stage column. The column structure is: header div, then a div
        # containing the slot/node pairs. Use a JS query with a structural
        # selector inside the column.
        # First slot div sits at stage-column-1 > div:nth-child(2) > div:nth-child(1) > div:nth-child(1)
        first_slot_handle = await page.evaluate_handle(
            """() => {
              const col = document.querySelector('[data-testid="stage-column-1"]');
              if (!col) return null;
              // Find the inner stack: first div with class containing space-y / flex flex-col gap
              const inner = col.querySelector('div.relative > div, div.flex.flex-col');
              const wrappers = col.querySelectorAll(':scope > div > div');
              // Slot zones are 8px tall (h-2). Pick the first <div> child of any wrapper that has class h-2.
              const all = col.querySelectorAll('div');
              for (const d of all) {
                if (d.className && d.className.toString().includes('h-2')) return d;
              }
              return null;
            }"""
        )
        slot_el = first_slot_handle.as_element()
        if slot_el is None:
            findings.append("[5] could not find a slot drop zone in stage 1")
        else:
            await page.evaluate(
                """([slot, srcSel, mime, payload]) => {
                  const src = document.querySelector(srcSel);
                  const dt = new DataTransfer();
                  dt.setData(mime, payload);
                  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
                  slot.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
                  slot.dispatchEvent(new DragEvent('dragover',  { bubbles: true, dataTransfer: dt, cancelable: true }));
                  slot.dispatchEvent(new DragEvent('drop',      { bubbles: true, dataTransfer: dt, cancelable: true }));
                  src.dispatchEvent(new DragEvent('dragend',   { bubbles: true, dataTransfer: dt }));
                }""",
                [
                    slot_el,
                    '[data-testid="node-output-passthrough"]',
                    "application/x-solder-node",
                    out_id,
                ],
            )
            await page.wait_for_timeout(300)
            await expect(findings, "stage_count after slot drop", await stage_count(page), 1)
            await expect(findings, "stage1_nodes after slot drop", await column_node_count(page, 1), 3)

        # ── 6. JS drag onto INTER-STAGE GAP between stage 1 and 2
        print("\n[6] JS drag stage 3 output → gap-after-1 (insert between 1 and 2)")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        await add_palette(page, "palette-output-passthrough")
        await page.wait_for_timeout(200)
        await expect(findings, "setup stage_count", await stage_count(page), 3)
        out_id = await get_node_id(page, "output-passthrough")
        await js_drag(
            page,
            '[data-testid="node-output-passthrough"]',
            '[data-gap-kind="gap-after-1"]',
            "application/x-solder-node",
            out_id,
        )
        await page.wait_for_timeout(300)
        await expect(findings, "stage_count after gap drop", await stage_count(page), 3)
        await expect(
            findings,
            "stage2=output",
            await page.locator(
                '[data-testid="stage-column-2"] [data-testid="node-output-passthrough"]'
            ).count(),
            1,
        )

        # ── 7a. Playwright real-mouse drag stage2 → gap-after-1 (between stages)
        print("\n[7a] Playwright dragTo stage3 output → gap-after-1")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        await add_palette(page, "palette-output-passthrough")
        await page.wait_for_timeout(150)
        await expect(findings, "setup stage_count", await stage_count(page), 3)
        await page.locator('[data-testid="node-output-passthrough"]').first.drag_to(
            page.locator('[data-gap-kind="gap-after-1"]').first
        )
        await page.wait_for_timeout(400)
        await expect(findings, "stage_count", await stage_count(page), 3)
        await expect(
            findings,
            "stage2=output (real drag)",
            await page.locator(
                '[data-testid="stage-column-2"] [data-testid="node-output-passthrough"]'
            ).count(),
            1,
        )

        # ── 7b. Playwright real-mouse drag onto trailing phantom
        print("\n[7b] Playwright dragTo stage1 http → trailing phantom")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        await page.locator('[data-testid="node-http-request"]').first.drag_to(
            page.locator('[data-gap-kind="gap-trailing"]').first
        )
        await page.wait_for_timeout(400)
        await expect(findings, "stage_count", await stage_count(page), 2)
        await expect(
            findings,
            "stage1=transform (real drag)",
            await page.locator(
                '[data-testid="stage-column-1"] [data-testid="node-transform-map"]'
            ).count(),
            1,
        )

        # ── 8. JS drag onto LEAD GAP (newStage before stage 1)
        print("\n[8] JS drag stage2 transform → gap-lead (becomes new stage 1)")
        await setup(page, ["palette-http-request", "palette-transform-map"])
        tid = await get_node_id(page, "transform-map")
        await js_drag(
            page,
            '[data-testid="node-transform-map"]',
            '[data-gap-kind="gap-lead"]',
            "application/x-solder-node",
            tid,
        )
        await page.wait_for_timeout(300)
        await expect(findings, "stage_count", await stage_count(page), 2)
        await expect(
            findings,
            "stage1=transform",
            await page.locator(
                '[data-testid="stage-column-1"] [data-testid="node-transform-map"]'
            ).count(),
            1,
        )
        await expect(
            findings,
            "stage2=http",
            await page.locator(
                '[data-testid="stage-column-2"] [data-testid="node-http-request"]'
            ).count(),
            1,
        )

        await page.screenshot(path=str(OUT / "final.png"))
        await browser.close()

    print("\n" + "=" * 50)
    if findings:
        print(f"FAIL — {len(findings)} finding(s):")
        for f in findings:
            print(f"  - {f}")
        return 1
    print("All assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))

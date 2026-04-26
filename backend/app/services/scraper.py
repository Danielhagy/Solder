import json
from typing import Optional

import httpx
import yaml


class OpenAPIScraper:
    """Scraper for fetching OpenAPI specifications from URLs."""

    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            headers={"User-Agent": "Solder/1.0 OpenAPI Scraper"},
        )

    async def fetch_spec(self, url: str) -> dict:
        """
        Fetch an OpenAPI specification from a URL.

        Supports JSON and YAML formats.
        Falls back to Playwright for JavaScript-rendered pages.
        """
        try:
            # First try simple HTTP fetch
            response = await self.client.get(url)
            response.raise_for_status()

            content = response.text
            spec = self._parse_content(content)

            if spec and self._is_valid_openapi(spec):
                return spec

            # If not valid OpenAPI, try Playwright for dynamic content
            return await self._fetch_with_playwright(url)

        except Exception as e:
            # Fall back to Playwright
            return await self._fetch_with_playwright(url)

    async def _fetch_with_playwright(self, url: str) -> dict:
        """Fetch spec using Playwright for JavaScript-rendered pages."""
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()

            try:
                await page.goto(url, wait_until="networkidle")

                # Try to find JSON content
                content = await page.content()

                # Look for pre/code blocks that might contain the spec
                pre_elements = await page.query_selector_all("pre")
                for pre in pre_elements:
                    text = await pre.inner_text()
                    spec = self._parse_content(text)
                    if spec and self._is_valid_openapi(spec):
                        return spec

                # Try the page content directly
                body_text = await page.inner_text("body")
                spec = self._parse_content(body_text)
                if spec and self._is_valid_openapi(spec):
                    return spec

                raise ValueError("Could not find valid OpenAPI spec at URL")

            finally:
                await browser.close()

    def _parse_content(self, content: str) -> Optional[dict]:
        """Parse content as JSON or YAML."""
        content = content.strip()

        # Try JSON first
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        # Try YAML
        try:
            return yaml.safe_load(content)
        except yaml.YAMLError:
            pass

        return None

    def _is_valid_openapi(self, spec: dict) -> bool:
        """Check if the parsed content is a valid OpenAPI spec."""
        if not isinstance(spec, dict):
            return False

        # Check for OpenAPI 3.x
        if "openapi" in spec and spec["openapi"].startswith("3."):
            return "paths" in spec or "components" in spec

        # Check for Swagger 2.x
        if "swagger" in spec and spec["swagger"].startswith("2."):
            return "paths" in spec

        return False

    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()

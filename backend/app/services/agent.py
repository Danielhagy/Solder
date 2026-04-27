import json
from typing import Any, Optional

from anthropic import Anthropic

from app.agents import OPUS, SONNET
from app.config import settings


class IntegrationAgent:
    """AI agent for building and testing integrations using Claude.

    Per FullSpec.md § 7, reasoning-heavy phases (intent capture, mapping)
    use Opus 4.7; high-volume / low-stakes phases (field classification,
    error explanation) use Sonnet 4.6. The class default is Opus because
    `build_integration` is the historical "translate user intent into a
    flow" entrypoint — that's reasoning work. Phase-specific helpers in
    `app/agents/*.py` will pick their own model.
    """

    def __init__(self):
        self.client = Anthropic(api_key=settings.anthropic_api_key)
        self.model = OPUS
        # Stash the high-volume model so callers can swap when appropriate
        # without re-importing the constants module.
        self.fast_model = SONNET

    async def build_integration(
        self,
        description: str,
        openapi_context: Optional[str] = None,
        existing_config: Optional[dict] = None,
    ) -> dict:
        """
        Build an integration configuration from a natural language description.

        Returns a dict with integration_config, explanation, and suggested_name.
        """
        system_prompt = """You are an expert integration builder. Your task is to create
integration configurations based on user descriptions and API documentation.

An integration configuration is a JSON object with the following structure:
{
    "nodes": [
        {
            "id": "unique-id",
            "type": "api_call" | "transform" | "condition" | "output",
            "position": {"x": number, "y": number},
            "config": {
                // Type-specific configuration
            }
        }
    ],
    "connections": [
        {
            "from": "node-id",
            "to": "node-id",
            "fromPort": "output",
            "toPort": "input"
        }
    ],
    "variables": {
        "name": "default_value"
    }
}

Node types:
- api_call: Makes HTTP requests. Config: {method, url, headers, body, auth}
- transform: Transforms data. Config: {expression} (JSONPath or JavaScript)
- condition: Branches flow. Config: {expression, trueOutput, falseOutput}
- output: Final output. Config: {mapping}

Always respond with valid JSON containing:
{
    "integration_config": { ... },
    "explanation": "Step by step explanation of what the integration does",
    "suggested_name": "Short descriptive name"
}"""

        user_message = f"Create an integration that: {description}"

        if openapi_context:
            user_message += f"\n\nAvailable API documentation:\n{openapi_context}"

        if existing_config:
            user_message += f"\n\nExisting integration to modify:\n{json.dumps(existing_config, indent=2)}"

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )

        # TODO(slice 5/6): replace this brittle brace-extraction path with
        # Claude tool use / structured output (FullSpec.md § 11). Kept here
        # so the existing /api/agents endpoints don't break before the new
        # phases land; the new agents in app/agents/*.py will use tool use
        # from the start.
        response_text = response.content[0].text
        try:
            start = response_text.find("{")
            end = response_text.rfind("}") + 1
            if start != -1 and end > start:
                json_str = response_text[start:end]
                return json.loads(json_str)
        except json.JSONDecodeError:
            pass

        # Fallback: return a basic structure
        return {
            "integration_config": {"nodes": [], "connections": [], "variables": {}},
            "explanation": response_text,
            "suggested_name": "New Integration",
        }

    async def test_integration(
        self,
        config: dict,
        test_input: Optional[dict] = None,
    ) -> dict:
        """
        Simulate testing an integration and provide feedback.

        Returns success status, output, errors, and suggestions.
        """
        system_prompt = """You are an integration testing expert. Analyze the given
integration configuration and test input, then:

1. Simulate what would happen when the integration runs
2. Identify potential issues or errors
3. Suggest improvements

Respond with JSON:
{
    "success": true/false,
    "output": { simulated output },
    "error": null or "error description",
    "suggestions": ["suggestion 1", "suggestion 2"]
}"""

        user_message = f"""Test this integration:

Configuration:
{json.dumps(config, indent=2)}

Test Input:
{json.dumps(test_input or {}, indent=2)}"""

        response = self.client.messages.create(
            model=self.model,
            max_tokens=2048,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )

        response_text = response.content[0].text

        try:
            start = response_text.find("{")
            end = response_text.rfind("}") + 1
            if start != -1 and end > start:
                json_str = response_text[start:end]
                return json.loads(json_str)
        except json.JSONDecodeError:
            pass

        return {
            "success": False,
            "output": None,
            "error": "Failed to parse test results",
            "suggestions": [],
        }

    async def explain_error(self, error: str, context: dict) -> str:
        """Get an explanation and fix suggestions for an error."""
        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": f"""Explain this integration error and suggest fixes:

Error: {error}

Context:
{json.dumps(context, indent=2)}""",
                }
            ],
        )
        return response.content[0].text

    async def generate_documentation(self, config: dict) -> str:
        """Generate markdown documentation for an integration."""
        response = self.client.messages.create(
            model=self.model,
            max_tokens=2048,
            messages=[
                {
                    "role": "user",
                    "content": f"""Generate clear markdown documentation for this integration:

{json.dumps(config, indent=2)}

Include:
- Overview of what the integration does
- Prerequisites and setup
- Input/output descriptions
- Example usage""",
                }
            ],
        )
        return response.content[0].text

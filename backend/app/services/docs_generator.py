from typing import Optional

from app.services.agent import IntegrationAgent


class DocsGenerator:
    """Generate documentation for integrations."""

    def __init__(self):
        self.agent = IntegrationAgent()

    async def generate(self, integration_config: dict, integration_name: str) -> str:
        """Generate markdown documentation for an integration."""
        # Use AI to generate comprehensive documentation
        ai_docs = await self.agent.generate_documentation(integration_config)

        # Combine with structured info
        nodes = integration_config.get("nodes", [])
        connections = integration_config.get("connections", [])
        variables = integration_config.get("variables", {})

        doc = f"""# {integration_name}

{ai_docs}

---

## Technical Details

### Nodes ({len(nodes)})

"""
        for node in nodes:
            node_type = node.get("type", "unknown")
            node_id = node.get("id", "")
            config = node.get("config", {})

            doc += f"#### {node_id} ({node_type})\n\n"
            doc += f"```json\n{self._format_json(config)}\n```\n\n"

        doc += f"""### Connections ({len(connections)})

"""
        for conn in connections:
            doc += f"- {conn.get('from')} → {conn.get('to')}\n"

        if variables:
            doc += f"""
### Variables

"""
            for name, default in variables.items():
                doc += f"- `{name}`: {default}\n"

        return doc

    def _format_json(self, obj: dict) -> str:
        import json
        return json.dumps(obj, indent=2)

    def generate_simple(self, integration_config: dict, integration_name: str) -> str:
        """Generate simple documentation without AI."""
        nodes = integration_config.get("nodes", [])
        connections = integration_config.get("connections", [])
        variables = integration_config.get("variables", {})

        doc = f"""# {integration_name}

## Overview

This integration contains {len(nodes)} nodes and {len(connections)} connections.

## Workflow

"""
        # Build a simple flow description
        for i, node in enumerate(nodes, 1):
            node_type = node.get("type", "unknown")
            node_id = node.get("id", "")

            type_desc = {
                "api_call": "Makes an API request",
                "transform": "Transforms data",
                "condition": "Evaluates a condition",
                "output": "Produces output",
            }.get(node_type, "Performs an action")

            doc += f"{i}. **{node_id}**: {type_desc}\n"

        if variables:
            doc += """
## Configuration Variables

"""
            for name, default in variables.items():
                doc += f"- `{name}`: Default value `{default}`\n"

        return doc

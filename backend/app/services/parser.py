from typing import Any, Optional


class OpenAPIParser:
    """Parser for converting OpenAPI specifications to internal formats."""

    def to_markdown(self, spec: dict) -> str:
        """Convert an OpenAPI spec to markdown documentation."""
        lines = []

        # Title and description
        info = spec.get("info", {})
        title = info.get("title", "API Documentation")
        description = info.get("description", "")
        version = info.get("version", "")

        lines.append(f"# {title}")
        if version:
            lines.append(f"\n**Version:** {version}")
        if description:
            lines.append(f"\n{description}")

        # Servers
        servers = spec.get("servers", [])
        if servers:
            lines.append("\n## Servers\n")
            for server in servers:
                url = server.get("url", "")
                desc = server.get("description", "")
                lines.append(f"- `{url}` - {desc}")

        # Authentication
        security_schemes = spec.get("components", {}).get("securitySchemes", {})
        if security_schemes:
            lines.append("\n## Authentication\n")
            for name, scheme in security_schemes.items():
                scheme_type = scheme.get("type", "")
                lines.append(f"### {name}")
                lines.append(f"- **Type:** {scheme_type}")
                if scheme_type == "oauth2":
                    flows = scheme.get("flows", {})
                    for flow_name, flow in flows.items():
                        lines.append(f"- **Flow:** {flow_name}")
                elif scheme_type == "apiKey":
                    lines.append(f"- **In:** {scheme.get('in', '')}")
                    lines.append(f"- **Name:** {scheme.get('name', '')}")

        # Paths/Endpoints
        paths = spec.get("paths", {})
        if paths:
            lines.append("\n## Endpoints\n")
            for path, methods in paths.items():
                for method, details in methods.items():
                    if method in ["get", "post", "put", "patch", "delete", "options", "head"]:
                        lines.append(f"### {method.upper()} `{path}`")

                        summary = details.get("summary", "")
                        if summary:
                            lines.append(f"\n{summary}")

                        description = details.get("description", "")
                        if description and description != summary:
                            lines.append(f"\n{description}")

                        # Parameters
                        parameters = details.get("parameters", [])
                        if parameters:
                            lines.append("\n**Parameters:**\n")
                            for param in parameters:
                                name = param.get("name", "")
                                location = param.get("in", "")
                                required = param.get("required", False)
                                param_desc = param.get("description", "")
                                schema = param.get("schema", {})
                                param_type = schema.get("type", "string")

                                req_marker = "*" if required else ""
                                lines.append(f"- `{name}`{req_marker} ({location}, {param_type}): {param_desc}")

                        # Request body
                        request_body = details.get("requestBody", {})
                        if request_body:
                            lines.append("\n**Request Body:**\n")
                            content = request_body.get("content", {})
                            for content_type, content_schema in content.items():
                                lines.append(f"- Content-Type: `{content_type}`")
                                schema = content_schema.get("schema", {})
                                if "$ref" in schema:
                                    ref_name = schema["$ref"].split("/")[-1]
                                    lines.append(f"- Schema: `{ref_name}`")

                        # Responses
                        responses = details.get("responses", {})
                        if responses:
                            lines.append("\n**Responses:**\n")
                            for code, response in responses.items():
                                resp_desc = response.get("description", "")
                                lines.append(f"- `{code}`: {resp_desc}")

                        lines.append("")

        # Schemas/Components
        schemas = spec.get("components", {}).get("schemas", {})
        if schemas:
            lines.append("\n## Schemas\n")
            for name, schema in schemas.items():
                lines.append(f"### {name}\n")

                schema_type = schema.get("type", "object")
                lines.append(f"**Type:** {schema_type}")

                if schema.get("description"):
                    lines.append(f"\n{schema['description']}")

                properties = schema.get("properties", {})
                required_fields = schema.get("required", [])

                if properties:
                    lines.append("\n**Properties:**\n")
                    for prop_name, prop_schema in properties.items():
                        prop_type = self._get_type_string(prop_schema)
                        required_marker = "*" if prop_name in required_fields else ""
                        prop_desc = prop_schema.get("description", "")
                        lines.append(f"- `{prop_name}`{required_marker} ({prop_type}): {prop_desc}")

                lines.append("")

        return "\n".join(lines)

    def _get_type_string(self, schema: dict) -> str:
        """Get a human-readable type string from a schema."""
        if "$ref" in schema:
            return schema["$ref"].split("/")[-1]

        schema_type = schema.get("type", "any")

        if schema_type == "array":
            items = schema.get("items", {})
            item_type = self._get_type_string(items)
            return f"array[{item_type}]"

        if schema_type == "object":
            if "additionalProperties" in schema:
                value_type = self._get_type_string(schema["additionalProperties"])
                return f"map[string, {value_type}]"

        if "format" in schema:
            return f"{schema_type}({schema['format']})"

        return schema_type

    def extract_endpoints(self, spec: dict) -> list[dict]:
        """Extract a list of endpoints from an OpenAPI spec."""
        endpoints = []
        paths = spec.get("paths", {})

        for path, methods in paths.items():
            for method, details in methods.items():
                if method in ["get", "post", "put", "patch", "delete", "options", "head"]:
                    endpoints.append({
                        "path": path,
                        "method": method.upper(),
                        "summary": details.get("summary", ""),
                        "description": details.get("description", ""),
                        "parameters": details.get("parameters", []),
                        "request_body": details.get("requestBody"),
                        "responses": details.get("responses", {}),
                        "operation_id": details.get("operationId", ""),
                        "tags": details.get("tags", []),
                    })

        return endpoints

    def get_base_url(self, spec: dict) -> Optional[str]:
        """Extract the base URL from an OpenAPI spec."""
        servers = spec.get("servers", [])
        if servers:
            return servers[0].get("url", "")
        return None

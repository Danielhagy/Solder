import asyncio
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.temporal.activities import (
        APICallInput,
        APICallOutput,
        PaginationConfig,
        TransformInput,
        TransformOutput,
        evaluate_condition,
        execute_api_call,
        execute_paginated_api_call,
        execute_transform,
        load_subprocess_config,
        notify_completion,
        record_learning,
    )


@dataclass
class IntegrationRunInput:
    """Input for running an integration."""

    run_id: str
    integration_id: str
    config: dict
    input_data: dict


@dataclass
class IntegrationRunOutput:
    """Output from running an integration."""

    success: bool
    output: Any
    steps: list[dict]
    error: Optional[str] = None


# Legacy single-axis `type` → new two-axis `{kind, action}` mapping. Used to
# run integrations saved before the catalog refactor without rewriting data.
_LEGACY_TYPE_MAP: dict[str, tuple[str, str]] = {
    "api_call": ("http", "request"),
    "transform": ("transform", "map"),
    "condition": ("logic", "if"),
    "output": ("output", "passthrough"),
}


class _Skipped:
    """Sentinel wrapper used when a node's ``when`` gate evaluates falsy.

    Carries the data that should pass through unchanged so callers can both
    (a) propagate the value and (b) detect the skip to record an appropriate step.
    """

    __slots__ = ("data",)

    def __init__(self, data: Any) -> None:
        self.data = data


def _node_dispatch_key(node: dict) -> str:
    """Return `kind.action` for a node, accepting either the new shape or legacy `type`."""
    kind = node.get("kind")
    action = node.get("action")
    if kind and action:
        return f"{kind}.{action}"
    legacy = node.get("type")
    if legacy in _LEGACY_TYPE_MAP:
        k, a = _LEGACY_TYPE_MAP[legacy]
        return f"{k}.{a}"
    # Unknown shape — fall through to a key that won't match any handler.
    return f"{kind or legacy or 'unknown'}.{action or 'unknown'}"


@workflow.defn
class IntegrationRunWorkflow:
    """Workflow for executing an integration."""

    @workflow.run
    async def run(self, input: IntegrationRunInput) -> IntegrationRunOutput:
        """Execute the integration workflow."""
        workflow.logger.info(f"Starting integration run: {input.run_id}")

        steps: list[dict] = []
        current_data: Any = input.input_data
        nodes = input.config.get("nodes", [])
        connections = input.config.get("connections", [])

        # Detect stage-model payload: every node carries int `stage` and `slot`.
        is_stage_model = bool(nodes) and all(
            isinstance(n.get("stage"), int) and isinstance(n.get("slot"), int)
            for n in nodes
        )

        try:
            if is_stage_model:
                current_data = await self._run_stages(nodes, current_data, steps)
            else:
                current_data = await self._run_legacy(
                    nodes, connections, current_data, steps
                )

            # Record successful learning
            await workflow.execute_activity(
                record_learning,
                args=[
                    input.run_id,
                    input.integration_id,
                    "successful_run",
                    {"steps": len(steps)},
                    "Integration completed successfully",
                    True,
                ],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Notify completion
            await workflow.execute_activity(
                notify_completion,
                args=[input.run_id, True, current_data, None, steps],
                start_to_close_timeout=timedelta(seconds=10),
            )

            return IntegrationRunOutput(
                success=True,
                output=current_data,
                steps=steps,
            )

        except Exception as e:
            workflow.logger.error(f"Integration run failed: {str(e)}")

            # Record failure learning
            await workflow.execute_activity(
                record_learning,
                args=[
                    input.run_id,
                    input.integration_id,
                    "failed_run",
                    {"error": str(e), "steps_completed": len(steps)},
                    f"Integration failed: {str(e)}",
                    False,
                ],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Notify completion with error
            await workflow.execute_activity(
                notify_completion,
                args=[input.run_id, False, None, str(e), steps],
                start_to_close_timeout=timedelta(seconds=10),
            )

            return IntegrationRunOutput(
                success=False,
                output=None,
                steps=steps,
                error=str(e),
            )

    async def _run_stages(
        self, nodes: list, current_data: Any, steps: list
    ) -> Any:
        """Execute nodes grouped by stage; nodes within a stage run concurrently."""
        by_stage: dict[int, list[dict]] = {}
        for n in nodes:
            by_stage.setdefault(int(n["stage"]), []).append(n)

        for stage in sorted(by_stage.keys()):
            batch = sorted(by_stage[stage], key=lambda m: m.get("slot", 0))
            workflow.logger.info(
                f"Executing stage {stage} with {len(batch)} node(s)"
            )

            tasks = [self._dispatch_node(n, current_data) for n in batch]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Find first failure (if any). Record successes alongside it before raising.
            first_error: Optional[BaseException] = None
            for r in results:
                if isinstance(r, Exception):
                    first_error = r
                    break

            if first_error is not None:
                for n, r in zip(batch, results):
                    if isinstance(r, Exception):
                        steps.append(
                            {
                                "node_id": n["id"],
                                "node_type": _node_dispatch_key(n),
                                "stage": stage,
                                "status": "failed",
                                "error": str(r),
                            }
                        )
                    elif isinstance(r, _Skipped):
                        steps.append(
                            {
                                "node_id": n["id"],
                                "node_type": _node_dispatch_key(n),
                                "stage": stage,
                                "status": "skipped",
                                "output": r.data,
                            }
                        )
                    else:
                        steps.append(
                            {
                                "node_id": n["id"],
                                "node_type": _node_dispatch_key(n),
                                "stage": stage,
                                "status": "success",
                                "output": r,
                            }
                        )
                raise first_error

            outputs: dict[str, Any] = {}
            for n, r in zip(batch, results):
                if isinstance(r, _Skipped):
                    outputs[n["id"]] = r.data
                    steps.append(
                        {
                            "node_id": n["id"],
                            "node_type": _node_dispatch_key(n),
                            "stage": stage,
                            "status": "skipped",
                            "output": r.data,
                        }
                    )
                else:
                    outputs[n["id"]] = r
                    steps.append(
                        {
                            "node_id": n["id"],
                            "node_type": _node_dispatch_key(n),
                            "stage": stage,
                            "status": "success",
                            "output": r,
                        }
                    )

            if len(outputs) == 1:
                current_data = outputs[batch[0]["id"]]
            else:
                current_data = {"outputs": outputs}

        return current_data

    async def _run_legacy(
        self, nodes: list, connections: list, current_data: Any, steps: list
    ) -> Any:
        """Legacy connection-graph execution (sequential, topological)."""
        execution_order = self._build_execution_order(nodes, connections)

        for node in execution_order:
            node_id = node.get("id")
            dispatch_key = _node_dispatch_key(node)
            node_config = node.get("config", {})

            workflow.logger.info(f"Executing node: {node_id} ({dispatch_key})")

            step_result: dict = {
                "node_id": node_id,
                "node_type": dispatch_key,
                "status": "running",
            }

            when_expr = node.get("when")
            if when_expr:
                try:
                    gate = await workflow.execute_activity(
                        evaluate_condition,
                        args=[when_expr, current_data],
                        start_to_close_timeout=timedelta(seconds=10),
                    )
                except Exception:
                    # Fail-open: treat evaluation failure as a skip.
                    gate = False
                if not gate:
                    step_result["status"] = "skipped"
                    step_result["output"] = current_data
                    steps.append(step_result)
                    continue

            try:
                if dispatch_key == "http.request":
                    result = await self._execute_api_call(node_config, current_data)
                    current_data = result
                    step_result["output"] = result

                elif dispatch_key == "transform.map":
                    result = await self._execute_transform(node_config, current_data)
                    current_data = result
                    step_result["output"] = result

                elif dispatch_key == "logic.if":
                    condition_result = await workflow.execute_activity(
                        evaluate_condition,
                        args=[node_config.get("expression", "true"), current_data],
                        start_to_close_timeout=timedelta(seconds=10),
                    )
                    step_result["condition_result"] = condition_result

                elif dispatch_key == "output.passthrough":
                    mapping = node_config.get("mapping", {})
                    if mapping:
                        output = {}
                        for key, path in mapping.items():
                            output[key] = self._get_value_at_path(current_data, path)
                        current_data = output
                    step_result["output"] = current_data

                step_result["status"] = "success"

            except Exception as e:
                step_result["status"] = "failed"
                step_result["error"] = str(e)
                steps.append(step_result)
                raise

            steps.append(step_result)

        return current_data

    async def _dispatch_node(self, node: dict, current_data: Any) -> Any:
        """Run a single node; shared by stage-mode and legacy paths."""
        dispatch_key = _node_dispatch_key(node)
        cfg = node.get("config", {})

        when_expr = node.get("when")
        if when_expr:
            try:
                gate = await workflow.execute_activity(
                    evaluate_condition,
                    args=[when_expr, current_data],
                    start_to_close_timeout=timedelta(seconds=10),
                )
            except Exception:
                # Fail-open: treat evaluation failure as a skip, passing data through.
                return _Skipped(current_data)
            if not gate:
                return _Skipped(current_data)

        if dispatch_key == "http.request":
            return await self._execute_api_call(cfg, current_data)
        if dispatch_key == "transform.map":
            return await self._execute_transform(cfg, current_data)
        if dispatch_key == "logic.if":
            # Legacy single-step evaluator kept for old integrations.
            result = await workflow.execute_activity(
                evaluate_condition,
                args=[cfg.get("expression", "true"), current_data],
                start_to_close_timeout=timedelta(seconds=10),
            )
            return {"condition": result}
        if dispatch_key == "logic.branch":
            # Evaluate the condition, pick the matching sub-chain, recurse.
            branches = node.get("branches") or {}
            picked = await workflow.execute_activity(
                evaluate_condition,
                args=[cfg.get("expression", "true"), current_data],
                start_to_close_timeout=timedelta(seconds=10),
            )
            sub_key = "true" if picked else "false"
            sub_nodes = branches.get(sub_key, []) or []
            if not sub_nodes:
                # Empty branch → pass-through with a small marker so steps still read well.
                return {"branch": sub_key, "output": current_data}
            sub_output = await self._run_stages(sub_nodes, current_data, [])
            return {"branch": sub_key, "output": sub_output}
        if dispatch_key == "process.call":
            # Fetch the target subprocess's config, then inline-execute its nodes.
            target_id = cfg.get("target_id")
            if not target_id:
                return {"called": None, "output": current_data}
            try:
                sub_config = await workflow.execute_activity(
                    load_subprocess_config,
                    args=[target_id],
                    start_to_close_timeout=timedelta(seconds=10),
                )
            except Exception as e:
                raise Exception(f"process.call: {e}") from e
            sub_nodes = (sub_config or {}).get("nodes", [])
            mode = cfg.get("mode", "once")
            if mode == "for-each":
                over_expr = cfg.get("over", "$.items")
                items = self._get_value_at_path(current_data, over_expr)
                if not isinstance(items, list):
                    items = []
                results: list[Any] = []
                for item in items:
                    results.append(await self._run_stages(sub_nodes, item, []))
                return {
                    "called": target_id,
                    "mode": "for-each",
                    "iterations": len(items),
                    "results": results,
                }
            # mode == 'once' (default)
            out = await self._run_stages(sub_nodes, current_data, [])
            return {"called": target_id, "mode": "once", "output": out}
        if dispatch_key == "logic.loop":
            # Iterate the `body` sub-chain once per item in the `over` expression.
            branches = node.get("branches") or {}
            body = branches.get("body", []) or []
            over_expr = cfg.get("over", "$.items")
            items = self._get_value_at_path(current_data, over_expr)
            if not isinstance(items, list):
                items = []
            results: list[Any] = []
            for item in items:
                if body:
                    results.append(await self._run_stages(body, item, []))
                else:
                    results.append(item)
            return {"iterations": len(items), "results": results}
        if dispatch_key == "output.passthrough":
            mapping = cfg.get("mapping", {})
            if mapping:
                out = {}
                for k, p in mapping.items():
                    out[k] = self._get_value_at_path(current_data, p)
                return out
            return current_data
        raise Exception(f"Unknown node kind: {dispatch_key}")

    async def _execute_api_call(self, config: dict, data: dict) -> Any:
        """Execute an API call node.

        Branches on ``config.pagination.mode``: ``none`` (or absent) routes to the
        original single-shot ``execute_api_call`` activity; any other mode routes
        to ``execute_paginated_api_call`` and returns the concatenated item list
        as the flat payload for downstream nodes.
        """
        # Interpolate variables in config
        url = self._interpolate(config.get("url", ""), data)
        body = config.get("body")
        if body:
            body = self._interpolate_dict(body, data)

        raw_pagination = config.get("pagination") or {}
        pagination_mode = raw_pagination.get("mode", "none") if isinstance(raw_pagination, dict) else "none"

        if pagination_mode and pagination_mode != "none":
            pagination = PaginationConfig(
                mode=pagination_mode,
                page_param=str(raw_pagination.get("page_param", "page")),
                page_start=int(raw_pagination.get("page_start", 1) or 1),
                page_size_param=str(raw_pagination.get("page_size_param", "") or ""),
                page_size=int(raw_pagination.get("page_size", 0) or 0),
                cursor_path=str(raw_pagination.get("cursor_path", "$.next_cursor")),
                cursor_param=str(raw_pagination.get("cursor_param", "cursor")),
                items_path=str(raw_pagination.get("items_path", "$") or "$"),
                max_pages=int(raw_pagination.get("max_pages", 100) or 100),
                stop_on_empty=bool(raw_pagination.get("stop_on_empty", True)),
            )

            # Paginated calls can fan out across many pages; give them more headroom.
            paginated_result = await workflow.execute_activity(
                execute_paginated_api_call,
                APICallInput(
                    method=config.get("method", "GET"),
                    url=url,
                    headers=config.get("headers", {}),
                    body=body,
                    auth=config.get("auth"),
                    timeout=config.get("timeout", 30),
                    pagination=pagination,
                ),
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )

            if not paginated_result.success:
                raise Exception(f"Paginated API call failed: {paginated_result.error}")

            # Downstream nodes expect the items array as the flat payload so they
            # can map/loop over it directly without drilling into a wrapper.
            payload = paginated_result.body or {}
            return payload.get("items", []) if isinstance(payload, dict) else payload

        result = await workflow.execute_activity(
            execute_api_call,
            APICallInput(
                method=config.get("method", "GET"),
                url=url,
                headers=config.get("headers", {}),
                body=body,
                auth=config.get("auth"),
                timeout=config.get("timeout", 30),
            ),
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(
                maximum_attempts=3,
                initial_interval=timedelta(seconds=1),
                maximum_interval=timedelta(seconds=10),
            ),
        )

        if not result.success:
            raise Exception(f"API call failed: {result.error}")

        return result.body

    async def _execute_transform(self, config: dict, data: Any) -> Any:
        """Execute a transform node."""
        result = await workflow.execute_activity(
            execute_transform,
            TransformInput(
                data=data,
                expression=config.get("expression", "$."),
            ),
            start_to_close_timeout=timedelta(seconds=30),
        )

        if not result.success:
            raise Exception(f"Transform failed: {result.error}")

        return result.result

    def _build_execution_order(self, nodes: list, connections: list) -> list:
        """Build execution order from nodes and connections."""
        if not connections:
            return nodes

        # Build adjacency list
        graph = {node["id"]: [] for node in nodes}
        in_degree = {node["id"]: 0 for node in nodes}

        for conn in connections:
            from_id = conn.get("from")
            to_id = conn.get("to")
            if from_id in graph and to_id in in_degree:
                graph[from_id].append(to_id)
                in_degree[to_id] += 1

        # Topological sort
        queue = [node_id for node_id, degree in in_degree.items() if degree == 0]
        order = []

        while queue:
            node_id = queue.pop(0)
            order.append(node_id)

            for neighbor in graph[node_id]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        # Map back to node objects
        node_map = {node["id"]: node for node in nodes}
        return [node_map[node_id] for node_id in order if node_id in node_map]

    def _interpolate(self, template: str, data: dict) -> str:
        """Interpolate variables in a string template."""
        import re

        def replace(match):
            path = match.group(1)
            return str(self._get_value_at_path(data, path))

        return re.sub(r"\{\{([^}]+)\}\}", replace, template)

    def _interpolate_dict(self, obj: Any, data: dict) -> Any:
        """Recursively interpolate variables in a dict/list."""
        if isinstance(obj, str):
            return self._interpolate(obj, data)
        elif isinstance(obj, dict):
            return {k: self._interpolate_dict(v, data) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._interpolate_dict(item, data) for item in obj]
        return obj

    def _get_value_at_path(self, data: Any, path: str) -> Any:
        """Get value at a dot-separated path."""
        if not path or path == "$":
            return data

        path = path.lstrip("$.")
        current = data
        for part in path.split("."):
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list) and part.isdigit():
                current = current[int(part)]
            else:
                return None
        return current


@workflow.defn
class BuildIntegrationWorkflow:
    """Workflow for AI-assisted integration building."""

    @workflow.run
    async def run(self, description: str, openapi_spec_id: Optional[str] = None) -> dict:
        """Build an integration using AI."""
        workflow.logger.info(f"Building integration: {description}")

        # This would call the AI agent activity
        # For now, return a placeholder
        return {
            "status": "pending",
            "message": "AI building in progress",
        }


@workflow.defn
class TestIntegrationWorkflow:
    """Workflow for testing an integration."""

    @workflow.run
    async def run(self, integration_id: str, test_input: dict) -> dict:
        """Test an integration and collect results."""
        workflow.logger.info(f"Testing integration: {integration_id}")

        # This would run the integration with test input
        # and analyze the results
        return {
            "status": "pending",
            "message": "Testing in progress",
        }

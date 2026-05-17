import asyncio
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.temporal.activities import (
        APICallInput,
        ConnectorResolveInput,
        IngestToBankInput,
        PaginationConfig,
        TransformInput,
        evaluate_condition,
        execute_api_call,
        execute_paginated_api_call,
        execute_python_sandbox,
        execute_transform,
        gen_ulid,
        gen_uuid_v4,
        get_current_time,
        ingest_to_bank,
        load_subprocess_config,
        notify_completion,
        random_float_in_range,
        random_int_in_range,
        record_learning,
        resolve_connector_request,
    )
    # Pure-compute executors run inline in the workflow because every
    # function is deterministic on its inputs (no I/O, random, or clock).
    # See `backend/app/runtime/pure.py` for the contract.
    from app.runtime.pure import PURE_DISPATCH
    # Local helper used inline by `state.set` / `state.get`. Lives in pure.py
    # next to the rest of the JSONPath conventions.
    from app.runtime.pure import _get_at as _state_get_at
    # Canonical path resolver — replaces the workflow's own `_walk_path`
    # and the python sandbox's inner walker.
    from app.runtime.path import walk as _runtime_walk
    # Canonical request-body renderer — handles the structured-dict
    # path AND the new raw-template-string path that ReferenceField
    # backs in the editor.
    from app.runtime.interpolate import (
        render_request_body as _render_request_body,
        TemplateBodyError as _TemplateBodyError,
    )
    # HTTP node v2 — pure helpers shared with the per-node test runner so
    # `_execute_api_call` and `node_test_executor._http_request` interpret
    # the same KvRow / HttpBody / HttpAuth shapes identically.
    from app.runtime.http_config import (
        auth_mode_of as _http_auth_mode_of,
        extract_path_for_resolver as _http_extract_path,
        flatten_kv_rows as _flatten_kv_rows,
        legacy_auth_from_v2 as _legacy_auth_from_v2,
        normalize_http_body as _normalize_http_body,
    )
    # Static set of registered connectors — used by `_dispatch_node` to
    # detect that a node's `kind` belongs to a connector op (e.g. 'zip',
    # 'hubspot') without colliding with built-in dispatch keys like
    # 'http', 'transform'. The set itself is read-only at module load.
    from app.connectors import REGISTRY as _CONNECTOR_REGISTRY

_CONNECTOR_KINDS: frozenset[str] = frozenset(_CONNECTOR_REGISTRY.keys())


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


_UNSET: Any = object()


class _Skipped:
    """Sentinel wrapper used when a node's ``when`` gate evaluates falsy.

    Carries the data that should pass through unchanged so callers can both
    (a) propagate the value and (b) detect the skip to record an appropriate step.
    """

    __slots__ = ("data",)

    def __init__(self, data: Any) -> None:
        self.data = data


class APICallError(Exception):
    """Raised by `_execute_api_call` when the underlying activity reports failure.

    Carries the classifier's `error_kind` (`'transient' | 'permanent' | 'auth'`)
    and the response `status_code` so per-iteration tracking, retry policies,
    and the run drawer can branch without re-parsing the error string.
    See `RESILIENCE_PLAN.md` §2.1.
    """

    def __init__(
        self,
        message: str,
        *,
        error_kind: Optional[str] = None,
        status_code: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.error_kind = error_kind
        self.status_code = status_code


class _StopRun(BaseException):
    """Raised by `logic.gate` with `on_false='stop'` to end the run cleanly.

    Inherits from ``BaseException`` (not ``Exception``) so ``asyncio.gather``
    with ``return_exceptions=True`` doesn't swallow it — we want it to
    propagate up to the workflow's ``run()`` method which catches it as a
    successful termination.
    """

    def __init__(self, data: Any, reason: str = "gate stopped run") -> None:
        super().__init__(reason)
        self.data = data
        self.reason = reason


def _walk_path(root: Any, path: str) -> Any:
    """Walk a dot-separated path against a JSON-ish root.

    Thin shim over `app.runtime.path.walk`. Retained as a local symbol
    because `_get_value_at_path` does its own ``$.trigger`` routing
    before delegating, so it wants the no-stripping variant rather than
    the full ``get_at``.
    """
    return _runtime_walk(root, path)


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

        # Run-scope variables. Populated by `state.set` and read by
        # `state.get`; references in expressions can also reach them via
        # `$.vars.<name>` once the runtime exposes them in the data scope
        # (a future enhancement — for v1, only state.get reads them).
        self._vars: dict[str, Any] = {}

        # Side-channel for nodes that want to enrich their step record
        # with metadata that doesn't belong in the downstream output.
        # `_dispatch_node` writes into this dict keyed by `node["id"]`;
        # `_run_stages` (and the legacy path) merges anything queued for
        # a node into the step record on append, then clears it. Today
        # used by `logic.loop` to surface per-iteration tracking
        # (RESILIENCE_PLAN.md R-1) without polluting the loop's output
        # shape — downstream sees the reduce-mode output, the run drawer
        # sees the iteration breakdown.
        self._step_extras: dict[str, dict] = {}

        # Connector ops (zip.list_vendors, …) need the integration id at
        # dispatch time so the resolve activity can route to the right
        # mock-engine bucket and look up `environment` from the row.
        self._integration_id: str = input.integration_id

        # Trigger payload — the `input_data` the user (or webhook) passed
        # in. Captured separately so `{{$.trigger.<path>}}` references
        # resolve from this regardless of how `current_data` evolves
        # downstream. See `_get_value_at_path` and the python sandbox's
        # splice helper.
        self._trigger_input: Any = input.input_data

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

        except _StopRun as stop:
            # `logic.gate` with `on_false='stop'` ended the run gracefully.
            # Treat as success with whatever data was carried at the gate.
            workflow.logger.info(f"Integration run stopped cleanly: {stop.reason}")
            await workflow.execute_activity(
                notify_completion,
                args=[input.run_id, True, stop.data, None, steps],
                start_to_close_timeout=timedelta(seconds=10),
            )
            return IntegrationRunOutput(
                success=True,
                output=stop.data,
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

    def _build_step_record(
        self,
        node: dict,
        stage: int,
        status: str,
        *,
        output: Any = _UNSET,
        error: Optional[str] = None,
    ) -> dict:
        """Compose a step record + merge any side-channel extras for this node.

        Centralised so every step-append site (stages success/skipped/failed,
        legacy success/failed) folds in `self._step_extras[node.id]` the same
        way. Use the `_UNSET` sentinel to distinguish "no output" (skip the
        key) from "output is None" (include the key with value None).
        """
        rec: dict = {
            "node_id": node["id"],
            "node_type": _node_dispatch_key(node),
            "stage": stage,
            "status": status,
        }
        if output is not _UNSET:
            rec["output"] = output
        if error is not None:
            rec["error"] = error
        extras = self._step_extras.pop(node["id"], None)
        if extras:
            rec.update(extras)
        return rec

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
                            self._build_step_record(
                                n, stage, "failed", error=str(r)
                            )
                        )
                    elif isinstance(r, _Skipped):
                        steps.append(
                            self._build_step_record(
                                n, stage, "skipped", output=r.data
                            )
                        )
                    else:
                        steps.append(
                            self._build_step_record(
                                n, stage, "success", output=r
                            )
                        )
                raise first_error

            outputs: dict[str, Any] = {}
            for n, r in zip(batch, results):
                if isinstance(r, _Skipped):
                    outputs[n["id"]] = r.data
                    steps.append(
                        self._build_step_record(
                            n, stage, "skipped", output=r.data
                        )
                    )
                else:
                    outputs[n["id"]] = r
                    steps.append(
                        self._build_step_record(
                            n, stage, "success", output=r
                        )
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
                    extras = self._step_extras.pop(node_id, None)
                    if extras:
                        step_result.update(extras)
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
                extras = self._step_extras.pop(node_id, None)
                if extras:
                    step_result.update(extras)
                steps.append(step_result)
                raise

            extras = self._step_extras.pop(node_id, None)
            if extras:
                step_result.update(extras)
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
            # Iterate the `body` sub-chain once per item in the `over`
            # expression. R-1 (RESILIENCE_PLAN.md):
            #   - `on_failure: 'halt' | 'continue'` controls per-iteration error
            #     policy. Default `halt` for back-compat.
            #   - `reduce: 'collect' | 'last' | 'count' | 'none'` (already on
            #     the catalog) is now honored at runtime.
            #   - Per-iteration records flow through `self._step_extras` so the
            #     run drawer can render a per-item rollup without polluting
            #     the loop's downstream output.
            branches = node.get("branches") or {}
            body = branches.get("body", []) or []
            over_expr = cfg.get("over", "$.items")
            items = self._get_value_at_path(current_data, over_expr)
            if not isinstance(items, list):
                items = []

            on_failure = (cfg.get("on_failure") or "halt").lower()
            reduce_mode = (cfg.get("reduce") or "collect").lower()

            succeeded_outputs: list[Any] = []
            iteration_records: list[dict] = []

            for idx, item in enumerate(items):
                rec: dict = {"index": idx, "status": "pending"}
                try:
                    if body:
                        out = await self._run_stages(body, item, [])
                    else:
                        out = item
                except Exception as e:
                    rec["status"] = "failed"
                    rec["error"] = str(e)
                    # Surface the classifier kind when available so the run
                    # drawer can show "[transient]" / "[permanent]" / "[auth]"
                    # tags per iteration. RESILIENCE_PLAN.md §2.1.
                    if isinstance(e, APICallError):
                        if e.error_kind:
                            rec["error_kind"] = e.error_kind
                        if e.status_code:
                            rec["status_code"] = e.status_code
                    iteration_records.append(rec)
                    if on_failure == "halt":
                        # Plumb iteration metadata into the step record before
                        # propagating, so the run drawer can show "made it to
                        # item N before halting".
                        self._step_extras[node["id"]] = {
                            "iterations": iteration_records,
                            "succeeded": len(succeeded_outputs),
                            "failed": sum(
                                1 for r in iteration_records if r["status"] == "failed"
                            ),
                            "on_failure": on_failure,
                            "reduce": reduce_mode,
                        }
                        raise
                    # 'continue' (and future 'checkpoint') — keep iterating.
                    continue
                rec["status"] = "success"
                rec["output"] = out
                succeeded_outputs.append(out)
                iteration_records.append(rec)

            failed_count = sum(
                1 for r in iteration_records if r["status"] == "failed"
            )

            # Iteration metadata lives on the step record, not on the
            # downstream value. `_run_stages` will merge it on append.
            self._step_extras[node["id"]] = {
                "iterations": iteration_records,
                "succeeded": len(succeeded_outputs),
                "failed": failed_count,
                "on_failure": on_failure,
                "reduce": reduce_mode,
            }

            # Reduce mode shapes the downstream input. Honoring it matches
            # the catalog's declared `outputShape: 'array'` for collect /
            # 'scalar' for count etc., and matches the editor's "Output"
            # caption. Pre-R-1 the runtime always returned `{iterations,
            # results}` regardless — that envelope is gone now; downstream
            # nodes that previously read `$.results` need to migrate.
            if reduce_mode == "collect":
                return succeeded_outputs
            if reduce_mode == "last":
                return succeeded_outputs[-1] if succeeded_outputs else None
            if reduce_mode == "count":
                return len(succeeded_outputs)
            if reduce_mode == "none":
                # Side-effect mode — pass through whatever was upstream.
                return current_data
            # Unknown reduce mode → safest default is the collect array.
            return succeeded_outputs
        if dispatch_key == "output.passthrough":
            mapping = cfg.get("mapping", {})
            if mapping:
                out = {}
                for k, p in mapping.items():
                    out[k] = self._get_value_at_path(current_data, p)
                return out
            return current_data
        if dispatch_key == "logic.assert":
            # Halt the run with the user-authored message when the predicate
            # is falsy. Pass-through on success (downstream sees current_data).
            ok = await workflow.execute_activity(
                evaluate_condition,
                args=[cfg.get("expression", "true"), current_data],
                start_to_close_timeout=timedelta(seconds=10),
            )
            if not ok:
                raise Exception(cfg.get("message") or "Assertion failed")
            return current_data
        if dispatch_key == "logic.gate":
            # Truthy → pass-through. Falsy → either skip (returns _Skipped so
            # current_data flows on) or stop (raises _StopRun, caught at the
            # workflow root as a successful early termination).
            ok = await workflow.execute_activity(
                evaluate_condition,
                args=[cfg.get("expression", "true"), current_data],
                start_to_close_timeout=timedelta(seconds=10),
            )
            if ok:
                return current_data
            on_false = (cfg.get("on_false") or "skip").lower()
            if on_false == "stop":
                raise _StopRun(current_data, "logic.gate predicate falsy with on_false='stop'")
            return _Skipped(current_data)
        if dispatch_key == "logic.switch":
            # Evaluate cases[] in order; first truthy match wins. If nothing
            # matches, fall to `default`. Recurse into the matched branch
            # like logic.branch does.
            cases = cfg.get("cases") or []
            branches = node.get("branches") or {}
            picked_key: Optional[str] = None
            for case in cases:
                if not isinstance(case, dict):
                    continue
                key = case.get("key")
                expr = case.get("match", "true")
                try:
                    matched = await workflow.execute_activity(
                        evaluate_condition,
                        args=[expr or "true", current_data],
                        start_to_close_timeout=timedelta(seconds=10),
                    )
                except Exception:
                    matched = False
                if matched and key:
                    picked_key = key
                    break
            if picked_key is None:
                picked_key = "default"
            sub_nodes = branches.get(picked_key, []) or []
            if not sub_nodes:
                return {"case": picked_key, "output": current_data}
            sub_output = await self._run_stages(sub_nodes, current_data, [])
            return {"case": picked_key, "output": sub_output}
        # === State scope (Wave B-3) ===========================================
        # `set` / `get` read & write `self._vars` inline — these are pure on
        # the workflow's own state, no activity needed.
        if dispatch_key == "state.set":
            name = (cfg.get("name") or "").strip()
            if not name:
                raise Exception("state.set: 'name' is required")
            value_ref = cfg.get("value", "$")
            if isinstance(value_ref, str) and value_ref.startswith("$"):
                resolved = _state_get_at(current_data, value_ref)
            else:
                resolved = value_ref
            self._vars[name] = resolved
            return current_data  # passthrough — declared `outputShape: 'side-effect'`
        if dispatch_key == "state.get":
            name = (cfg.get("name") or "").strip()
            if not name:
                raise Exception("state.get: 'name' is required")
            if name in self._vars:
                return self._vars[name]
            return cfg.get("default")
        # ID generators + RNG — must be activities so the result is replayable.
        if dispatch_key == "state.uuid":
            return await workflow.execute_activity(
                gen_uuid_v4,
                start_to_close_timeout=timedelta(seconds=5),
            )
        if dispatch_key == "state.ulid":
            return await workflow.execute_activity(
                gen_ulid,
                args=[(cfg.get("prefix") or "")],
                start_to_close_timeout=timedelta(seconds=5),
            )
        if dispatch_key == "state.random_int":
            return await workflow.execute_activity(
                random_int_in_range,
                args=[
                    int(cfg.get("min") or 0),
                    int(cfg.get("max") or 100),
                    str(cfg.get("seed") or ""),
                ],
                start_to_close_timeout=timedelta(seconds=5),
            )
        if dispatch_key == "state.random_float":
            return await workflow.execute_activity(
                random_float_in_range,
                args=[
                    float(cfg.get("min") or 0),
                    float(cfg.get("max") or 1),
                    str(cfg.get("seed") or ""),
                ],
                start_to_close_timeout=timedelta(seconds=5),
            )
        if dispatch_key == "time.now":
            return await workflow.execute_activity(
                get_current_time,
                args=[
                    str(cfg.get("format") or "iso"),
                    str(cfg.get("tz") or "UTC"),
                ],
                start_to_close_timeout=timedelta(seconds=5),
            )
        if dispatch_key == "code.python":
            timeout_ms = int(cfg.get("timeout_ms") or 30000)
            allow = list(cfg.get("allow_imports") or [])
            # Source-level template substitution lives inside the activity
            # (`_splice_path_refs`) — the user writes `{{$.path}}` tokens
            # inline in the Python source and they get spliced in as
            # `repr()`-encoded literals before compile. `trigger_input`
            # lets `{{$.trigger.<path>}}` refs resolve regardless of
            # stage so the run's seed payload stays reachable.
            envelope = await workflow.execute_activity(
                execute_python_sandbox,
                args=[
                    cfg.get("source") or "",
                    current_data,
                    timeout_ms,
                    allow,
                    self._trigger_input,
                ],
                # Activity timeout sits a couple seconds above the in-script
                # timeout so we never race the sandbox's own kill path.
                start_to_close_timeout=timedelta(milliseconds=timeout_ms + 5000),
            )
            # Forward `print()` output to the run drawer via the
            # `_step_extras` side-channel — `_build_step_record` and the
            # legacy success/failure paths both fold extras into the
            # step record. Writing BEFORE the raise below ensures stdout
            # is preserved even when the script crashes after printing
            # (the failure step record then carries both `error` and
            # `stdout`, matching the per-node Test runner's behaviour).
            stdout = envelope.get("stdout") if isinstance(envelope, dict) else None
            if isinstance(stdout, str) and stdout:
                self._step_extras[node["id"]] = {"stdout": stdout}
            error = envelope.get("error") if isinstance(envelope, dict) else None
            if error:
                kind = (envelope.get("error_kind") or "runtime") if isinstance(envelope, dict) else "runtime"
                raise Exception(f"code.python ({kind}): {error}")
            return envelope.get("result") if isinstance(envelope, dict) else envelope
        # Pure-compute nodes (data.*, format.*, math.*, str.*, time.parse/format/add/diff)
        # run inline in the workflow — every function is deterministic, so
        # workflow replay is safe. See `backend/app/runtime/pure.py`.
        pure_fn = PURE_DISPATCH.get(dispatch_key)
        if pure_fn is not None:
            return pure_fn(cfg, current_data)
        # data.ingest_to_bank — persist the upstream array into the
        # integration's test bank so subsequent sandbox runs can serve it
        # via the mock-engine. The "items" source defaults to the upstream
        # data; an explicit JSONPath in cfg.items_path overrides.
        if dispatch_key == "data.ingest_to_bank":
            items_source = current_data
            items_path = cfg.get("items_path")
            if items_path:
                items_source = self._get_value_at_path(current_data, items_path)
            result = await workflow.execute_activity(
                ingest_to_bank,
                IngestToBankInput(
                    integration_id=self._integration_id,
                    entity_type=cfg.get("entity_type") or "",
                    items=items_source,
                    id_path=cfg.get("id_path") or "$.id",
                    connector_name=cfg.get("connector_name"),
                    replace=bool(cfg.get("replace", False)),
                ),
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            if not result.success:
                raise Exception(f"ingest_to_bank failed: {result.error}")
            # Pass the upstream payload through unchanged so a downstream
            # node still sees the records — the ingest is a side effect.
            # The step record carries the (inserted, updated, bank_id)
            # rollup via _step_extras for the run drawer.
            self._step_extras[node["id"]] = {
                "ingested": {
                    "inserted": result.inserted,
                    "updated": result.updated,
                    "test_bank_id": result.test_bank_id,
                    "entity_type": cfg.get("entity_type"),
                }
            }
            return current_data
        # Connector ops (zip.list_vendors, hubspot.list_contacts, …). Anything
        # whose `kind` matches a registered connector resolves the connection
        # secret + endpoint into a real HTTP request, then reuses the same
        # API-call activity as `http.request`. Sandbox runs route to the
        # local mock-engine; production runs hit the real connector.
        node_kind = node.get("kind")
        if node_kind in _CONNECTOR_KINDS:
            return await self._execute_connector_op(node, cfg, current_data)
        raise Exception(f"Unknown node kind: {dispatch_key}")

    async def _execute_connector_op(
        self, node: dict, config: dict, data: Any
    ) -> Any:
        """Resolve a connector op to a concrete HTTP call and invoke it.

        The `endpoint` block on the node's config carries the path/method
        the catalog pinned at design time; the `credential_id` (optional in
        sandbox, required in production) selects which connection's secret
        to use. The resolve activity does the DB read + decrypt; the
        existing API-call activity does the actual request.
        """
        connector_name = node.get("kind") or ""
        endpoint = config.get("endpoint") or {}
        endpoint_path = endpoint.get("path") or "/"
        endpoint_method = (endpoint.get("method") or "GET").upper()
        connection_id = (
            config.get("credential_id")
            or config.get("connection_id")
            or None
        )

        resolved = await workflow.execute_activity(
            resolve_connector_request,
            ConnectorResolveInput(
                integration_id=self._integration_id,
                connector_name=connector_name,
                endpoint_path=endpoint_path,
                connection_id=connection_id,
            ),
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        if not resolved.success:
            raise APICallError(
                f"connector {connector_name}.{endpoint_path}: {resolved.error}",
                error_kind="permanent",
                status_code=None,
            )

        # Body interpolation happens once here; the per-call activity does not
        # re-interpolate. `_render_request_body` handles both the structured
        # dict path (existing) and the raw-template string path that the
        # editor's "Template" mode emits. Any `headers` declared on the node
        # are merged after the resolved auth headers so user overrides win.
        try:
            body = _render_request_body(
                config.get("body"),
                data if isinstance(data, dict) else {},
                trigger_input=self._trigger_input,
            )
        except _TemplateBodyError as e:
            raise APICallError(
                f"connector {connector_name}.{endpoint_path}: {e}",
                error_kind="permanent",
                status_code=None,
            )
        merged_headers = {**resolved.headers, **(config.get("headers") or {})}

        # Pagination is honoured exactly like http.request — the catalog
        # ships connector ops with `pagination: { mode: 'none' }` by default.
        synthetic_cfg = {
            "method": endpoint_method,
            "url": resolved.url,
            "headers": merged_headers,
            "body": body,
            "auth": None,
            "timeout": config.get("timeout", 30),
            "pagination": config.get("pagination") or {"mode": "none"},
        }
        # Apply any resolved query-param auth (api_key_query) to the URL.
        if resolved.query:
            synthetic_cfg["url"] = self._merge_query_params(resolved.url, resolved.query)
        return await self._execute_api_call(synthetic_cfg, data)

    def _merge_query_params(self, url: str, extra: dict) -> str:
        """Merge ``extra`` query params into ``url`` (existing keys win on collision).

        Local helper duplicated here so the workflow doesn't import the
        activity-side ``_merge_query`` (which would couple workflow imports
        to module load order). Implementation is intentionally tiny.
        """
        if not extra:
            return url
        sep = "&" if "?" in url else "?"
        encoded = "&".join(f"{k}={v}" for k, v in extra.items())
        return f"{url}{sep}{encoded}"

    async def _execute_api_call(self, config: dict, data: dict) -> Any:
        """Execute an API call node.

        Supports both v1 (dict headers, string/dict body, no connectionId) and
        v2 (KvRow[] headers + params, HttpBody discriminator, connectionId,
        auth.mode override, settings.{timeout, followRedirects, verify}).

        Branches on ``config.pagination.mode``: ``none`` routes to the
        original single-shot ``execute_api_call`` activity; any other mode routes
        to ``execute_paginated_api_call`` and returns the concatenated item list
        as the flat payload for downstream nodes.
        """
        # --- Interpolate URL + merge structured query params (v2) ---
        url_raw = self._interpolate(config.get("url", ""), data)
        params_dict = _flatten_kv_rows(config.get("params"))
        if params_dict:
            # Interpolate each value too so `{{$.…}}` works in query values.
            params_dict = {
                k: self._interpolate(v, data) for k, v in params_dict.items()
            }
            url_raw = self._merge_query_params(url_raw, params_dict)

        # --- Body — accept v2 HttpBody discriminator or legacy shape ---
        body_in = _normalize_http_body(config.get("body"))
        try:
            body = _render_request_body(
                body_in,
                data,
                trigger_input=self._trigger_input,
            )
        except _TemplateBodyError as e:
            raise APICallError(
                f"http.request: {e}",
                error_kind="permanent",
                status_code=None,
            )

        # --- Headers — KvRow[] or legacy dict ---
        user_headers = _flatten_kv_rows(config.get("headers"))
        for k, v in list(user_headers.items()):
            user_headers[k] = self._interpolate(v, data)

        # --- Auth override + Connection resolution ---
        # `auth.mode = 'inherit'` (default) defers to the resolved Connection.
        # Any other mode overrides that resolved auth.
        raw_auth_cfg = config.get("auth")
        auth_override = _legacy_auth_from_v2(raw_auth_cfg)
        auth_mode = (
            raw_auth_cfg.get("mode") if isinstance(raw_auth_cfg, dict) else None
        )

        connection_id = (
            config.get("connectionId")
            or config.get("credential_id")
            or config.get("connection_id")
            or None
        )

        resolved_url = url_raw
        resolved_headers: dict[str, str] = {}
        resolved_query: dict[str, str] = {}
        if connection_id:
            resolved = await workflow.execute_activity(
                resolve_connector_request,
                ConnectorResolveInput(
                    integration_id=self._integration_id,
                    connector_name="",  # bare HTTP — no connector op
                    endpoint_path=_http_extract_path(url_raw),
                    connection_id=connection_id,
                ),
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            if not resolved.success:
                raise APICallError(
                    f"http.request: connection {connection_id}: {resolved.error}",
                    error_kind="permanent",
                    status_code=None,
                )
            # Absolute URL on the node overrides the Connection's base_url.
            if not url_raw.startswith(("http://", "https://")):
                resolved_url = resolved.url
            resolved_headers = dict(resolved.headers or {})
            resolved_query = dict(resolved.query or {})

        # Final URL: resolved + any auth-scheme query params.
        final_url = (
            self._merge_query_params(resolved_url, resolved_query)
            if resolved_query
            else resolved_url
        )

        # Final headers: connection auth first, then user-supplied (user wins
        # on collision EXCEPT when the user is explicitly inheriting — then
        # Connection's Authorization should not be silently overwritten by
        # a stray user header).
        if auth_mode == "none":
            # Strip any resolved Authorization explicitly.
            resolved_headers.pop("Authorization", None)
            resolved_headers.pop("authorization", None)
        final_headers = {**resolved_headers, **user_headers}

        # Override-mode auth wins over resolved auth.
        final_auth = auth_override if auth_mode not in (None, "inherit") else None

        # --- Settings ---
        settings = config.get("settings") if isinstance(config.get("settings"), dict) else {}
        timeout_s = int(settings.get("timeoutSeconds", config.get("timeout", 30)) or 30)
        follow_redirects = bool(settings.get("followRedirects", True))
        verify = bool(settings.get("rejectUnauthorized", True))

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
                    url=final_url,
                    headers=final_headers,
                    body=body,
                    auth=final_auth,
                    timeout=timeout_s,
                    pagination=pagination,
                    follow_redirects=follow_redirects,
                    verify=verify,
                ),
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )

            if not paginated_result.success:
                raise APICallError(
                    f"Paginated API call failed: {paginated_result.error}",
                    error_kind=paginated_result.error_kind,
                    status_code=paginated_result.status_code or None,
                )

            # Downstream nodes expect the items array as the flat payload so they
            # can map/loop over it directly without drilling into a wrapper.
            payload = paginated_result.body or {}
            return payload.get("items", []) if isinstance(payload, dict) else payload

        result = await workflow.execute_activity(
            execute_api_call,
            APICallInput(
                method=config.get("method", "GET"),
                url=final_url,
                headers=final_headers,
                body=body,
                auth=final_auth,
                timeout=timeout_s,
                follow_redirects=follow_redirects,
                verify=verify,
            ),
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(
                maximum_attempts=3,
                initial_interval=timedelta(seconds=1),
                maximum_interval=timedelta(seconds=10),
            ),
        )

        if not result.success:
            raise APICallError(
                f"API call failed: {result.error}",
                error_kind=result.error_kind,
                status_code=result.status_code or None,
            )

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
        """Resolve a `$.…`-style path against the workflow's data scope.

        The default scope is `data` (the upstream step's output), but two
        prefixes route elsewhere:
          - `$.trigger`         → the run's input_data (`self._trigger_input`)
          - `$.trigger.<rest>`  → walks `<rest>` against the trigger payload

        Picker tokens like `{{$.trigger.user.name}}` resolve through this
        path. Other prefixes (plain keys, list indices) walk `data` as
        before. `_walk_path` is a stateless cursor walk reused by both
        branches so the special-cases stay tight.
        """
        if not path or path == "$":
            return data
        norm = path.lstrip("$.")
        if norm == "trigger":
            return self._trigger_input
        if norm.startswith("trigger."):
            return _walk_path(self._trigger_input, norm[len("trigger.") :])
        return _walk_path(data, norm)


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

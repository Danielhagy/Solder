import asyncio

from temporalio.client import Client
from temporalio.worker import Worker

from app.config import settings
from app.temporal.activities import (
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
from app.temporal.workflows import (
    BuildIntegrationWorkflow,
    IntegrationRunWorkflow,
    TestIntegrationWorkflow,
)


async def run_worker():
    """Run the Temporal worker."""
    client = await Client.connect(settings.temporal_host)

    worker = Worker(
        client,
        task_queue=settings.temporal_task_queue,
        workflows=[
            IntegrationRunWorkflow,
            BuildIntegrationWorkflow,
            TestIntegrationWorkflow,
        ],
        activities=[
            execute_api_call,
            execute_paginated_api_call,
            execute_transform,
            evaluate_condition,
            record_learning,
            notify_completion,
            load_subprocess_config,
            # Wave B-3 — non-deterministic node ops
            gen_uuid_v4,
            gen_ulid,
            random_int_in_range,
            random_float_in_range,
            get_current_time,
            # Wave B-7 — Python sandbox
            execute_python_sandbox,
            # Connector ops — resolves connection secret + endpoint into
            # a real HTTP request (sandbox-routed or production).
            resolve_connector_request,
            # data.ingest_to_bank — persists upstream records into the
            # integration's test bank for downstream sandbox runs.
            ingest_to_bank,
        ],
    )

    print(f"Starting Temporal worker on task queue: {settings.temporal_task_queue}")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(run_worker())

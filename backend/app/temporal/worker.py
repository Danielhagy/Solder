import asyncio

from temporalio.client import Client
from temporalio.worker import Worker

from app.config import settings
from app.temporal.activities import (
    evaluate_condition,
    execute_api_call,
    execute_paginated_api_call,
    execute_transform,
    load_subprocess_config,
    notify_completion,
    record_learning,
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
        ],
    )

    print(f"Starting Temporal worker on task queue: {settings.temporal_task_queue}")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(run_worker())

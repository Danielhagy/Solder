# Adding a connector

A "connector" in Solder is the smallest unit of "I can integrate against
this API." This guide describes what you need to add to support a new one.

## Required artefacts

### 1. Definition

A subclass of `BaseConnector` (`backend/app/connectors/base.py`) at
`backend/app/connectors/{name}.py`. Provides:

- `name` — stable identifier used in routes, error corpora, test bank
  rows. Lowercase, no spaces. Examples: `zip`, `hubspot`.
- `display_name` — title-case for UI.
- `auth_scheme` — one of `bearer`, `oauth2`, `api_key_header`, `basic`.
- `base_url` — production base URL the integration thinks it's calling.
- `auth_headers(credential_secret)` — translate decrypted credential
  secrets → outgoing HTTP headers.
- `discoverable_endpoints()` — list of endpoints safe to GET-sample
  during discovery (FullSpec.md § 7.1, § 12 Q3).

### 2. Error corpus

A static JSON file at
`backend/app/mock_engine/error_corpora/{name}.json` with realistic errors
the API returns. See FullSpec § 5.4 for the format. ~30 entries per API.

Authoring: hand-write from API docs. LLM may help draft entries (build
time only — never at request time).

### 3. (Optional) Business rules

Connector-specific behaviours that go beyond simple route + responder.
Stored as a JSON block in the mock spec's `business_rules` field. Empty
in v1; scaffolded for the agent-curated rules layer (FullSpec § 10
North Star).

### 4. Test fixtures

Example real requests + responses for each discoverable endpoint, used
to seed unit tests for the discovery sampler and the synthesizer.

## Wiring

Once the artefacts above exist, register the connector by importing it
from the module-init in `backend/app/connectors/__init__.py`. The
`/api/connectors` endpoint will then expose it for the
IntegrationCreate flow (FullSpec § 8.1).

# PagerDuty Advance MCP Server

Reference for `pagerduty-advance-mcp` — PagerDuty's agent-facing MCP server, distinct from
the general-purpose `pagerduty-mcp` REST wrapper.

Documented from a live probe on 2026-08-14 against server version **3.3.1**
(MCP protocol `2025-06-18`).

## Endpoint & auth

| | |
|---|---|
| URL | `https://mcp.pagerduty.com/pagerduty-advance-mcp` |
| Transport | Streamable HTTP |
| Auth | `Authorization: Token token=<PD_API_KEY>` |
| Server name | `PagerDuty Advance MCP Server` |
| Version | 3.3.1 |

The account and user identity are carried **by the API token**. The agent tools explicitly
say not to ask for user or account identifiers — don't thread them through prompts.

### Registering it

The config as supplied uses VS Code's `mcp.json` dialect:

```jsonc
"servers": {
  "pagerduty-advance-mcp": {
    "url": "https://mcp.pagerduty.com/pagerduty-advance-mcp",
    "type": "http",
    "headers": { "Authorization": "Token token=${input:pagerduty-api-key}" }
  }
}
```

`${input:...}` is a VS Code input variable and **does not resolve in Claude Code**. For a
Claude Code `.mcp.json` the top-level key is `mcpServers` and interpolation is plain env
expansion:

```jsonc
{
  "mcpServers": {
    "pagerduty-advance-mcp": {
      "type": "http",
      "url": "https://mcp.pagerduty.com/pagerduty-advance-mcp",
      "headers": { "Authorization": "Token token=${PAGERDUTY_API_KEY}" }
    }
  }
}
```

Note the existing user-scope `pagerduty-mcp` entry sends `Token <key>` (no `token=` prefix)
and both forms are accepted by the host.

## Capability surface

| Surface | Count |
|---|---|
| Tools | 9 |
| Prompts | 0 |
| Resources / templates | 0 |

Declared capabilities include `logging`, `prompts.listChanged`, `resources.listChanged`,
`tools.listChanged`, and the experimental `io.modelcontextprotocol/ui` extension — but the
prompt and resource lists are currently empty, so tools are the entire usable surface.

## Architecture: a router, not an API wrapper

`pagerduty-mcp` exposes ~60 thin REST endpoints (incidents, services, schedules, teams).
`pagerduty-advance-mcp` exposes **three LLM agents behind natural-language tools**, plus CRUD
over the documents that steer them. You send prose, the remote agent does the retrieval.

```
                    ┌─────────────────────────────────────┐
   your message ──▶ │  sre / insights / shift agent tool   │ ──▶ prose answer
                    └──────────────┬──────────────────────┘
                                   │ loads
                    ┌──────────────▼──────────────────────┐
                    │  skills registry                    │
                    │  (agent_type × scope × name)        │
                    └─────────────────────────────────────┘
                          ▲ create / get / list / update / delete
```

The three `agent_type` values — `sre`, `insights`, `shift` — are the same axis in both
halves: each agent tool has a matching skills namespace.

## Tool group 1 — agent routing (4 tools)

All agent tools take a free-text `message`. The three conversational ones accept an optional
`session_id` for continuity (a new UUID is generated if omitted) — **pass it back to keep
multi-turn context**.

### `sre_agent_tool`
Required: `message`, `incident_id`. Optional: `session_id`.

Primary expert for active incident response. Handles triage and resolution, root-cause
analysis ("what changed?"), diagnostics and remediation, log interpretation, alert-trigger
explanation, change-event impact, infrastructure and service-dependency questions, linked
support tickets (ServiceNow/Zendesk), **runbook and playbook generation**, past-incident
correlation and pattern recognition for the current incident, noise reduction, and customer
comms / status-page wording.

Does *not* handle: PagerDuty product how-tos, account management, or anything on-call
scheduling.

`incident_id` is mandatory — this tool has no un-anchored mode.

### `insights_agent_tool`
Required: `message`. Optional: `session_id`.

Analytics agent for historical reporting: MTTR/MTTA and frequency metrics, trend analysis,
team benchmarking, service reliability over long windows, capacity planning, executive KPI
reporting, and analytics *about* on-call shifts.

Does *not* handle: incident-response lookups or live similar-incident correlation — those
belong to `sre_agent_tool`. The split is **strategic/retrospective vs. operational/live**,
even though both read incident history.

### `shift_agent_on_call_questions_and_conflicts_tool`
Required: `message`. Optional: `session_id`.

Schedules expert: who is/was on call, current and historical assignments, availability
conflicts (PTO, sick, time off), setting unavailability, calendar sync, schedule questions
that reference an incident ("who was responsible during X"), and shift swap/coverage intake.

Does *not* handle: analytics *about* shifts (→ `insights_agent_tool`) or anything technical.

### `shift_agent_find_coverage_tool`
Required: `schedule_id`, `schedule_name`, `schedule_start_ts`, `schedule_end_ts`.

Finds replacement coverage. **Ordering matters**: call
`shift_agent_on_call_questions_and_conflicts_tool` first, then call this once the user picks
a schedule from the returned conflict list. It's the only agent tool with a structured
(non-prose) signature and no `session_id`.

## Tool group 2 — skills registry (5 tools)

CRUD over durable instruction documents that the agents load. This is the closest thing
PagerDuty exposes to a **writable memory layer** — see below.

Identity is the triple **`(agent_type, scope, name)`**.

- `agent_type`: `sre` | `insights` | `shift`
- `scope`: `account` (visible to every user in the PagerDuty account) | `user` (private to
  the token holder)

The same `name` may exist in both scopes simultaneously. Every tool requires `scope`
explicitly; the tool descriptions instruct the caller to **ask rather than guess**, and
deletion of the wrong scope is unrecoverable.

| Tool | Required args | Notes |
|---|---|---|
| `create_skill_tool` | `agent_type`, `scope`, `name`, `description`, `instructions` | Optional `examples`, `connectors`, `metadata` |
| `get_skill_tool` | `agent_type`, `scope`, `skill_name` | 404 if absent in that scope |
| `list_skills_tool` | `agent_type`, `scope` | Optional `limit`, `cursor`; single-scope only |
| `update_skill_tool` | `agent_type`, `scope`, `skill_name`, `description`, `instructions` | **Full replace** |
| `delete_skill_tool` | `agent_type`, `scope`, `skill_name` | Permanent, no archive |

### Constraints (enforced upstream by agent-platform-service)

- `name` — lowercase kebab-case, ≤ 60 chars, unique within `(account, agent, scope)`
- `description` — ≤ 1024 chars
- `instructions` + all content — ≤ **5000 tokens total**
- Quotas — 50 skills per `(account, agent)`, 25 per `(agent, user)`
- `scope` is **immutable** after creation — delete and recreate to move a skill
- `name` is **immutable** — there is no rename

### Gotchas

- `update_skill_tool` is a full replace: omitted mutable fields reset to empty defaults
  (`examples` → `[]`, `connectors` → `[]`, `metadata` → `{}`). **Always `get` before
  `update`** if preserving anything.
- The PUT body must not include `agent` or `scope` (both come from the URL path) — the tool
  handles this, but it returns 422 if violated.
- **Known bug (PAG-3711):** upstream 409 (quota exceeded / name conflict) and 422
  (validation, missing scope) surface as **500 with the upstream error body dropped**. A 500
  from any skills tool most likely means a name collision or a quota hit, not an outage.
- No cross-scope or cross-agent listing. Enumerating everything is 6 calls
  (3 agents × 2 scopes).
- No search or content filtering — only list by `(agent_type, scope)`.

## Relevance to memory / recall

> **See also [`sre-agent-memory-api.md`](./sre-agent-memory-api.md).** PagerDuty *does* have a
> real memory store — the SRE Agent Memory API — but it is REST-only on `api.pagerduty.com`
> and is not reachable through either MCP server. The section below covers only what MCP
> exposes.

Within MCP, **the skills registry is the only persistent, writable store on either PagerDuty
MCP server.** It is not a memory system, but it is the available substrate for one:

- ✅ Durable across sessions, scoped per-user or per-account, and actually consumed by the
  agents at inference time — so writes change future behaviour.
- ❌ No embeddings, no similarity search, no automatic recall. Retrieval is by exact
  `(agent_type, scope, name)` or a flat list.
- ❌ 5000-token ceiling per skill and 25/50-item quotas — this is a curated instruction
  catalogue, not a growing incident-memory corpus.

`session_id` on the three conversational tools gives **within-conversation** continuity only;
it is not durable storage.

On the read side, the raw material for building memory lives on the *other* server
(`pagerduty-mcp`): `list_incident_notes`, `get_past_incidents`, `get_related_incidents`,
`get_outlier_incident`, `list_change_events`, `list_log_entries`. A memory layer would ingest
from those and could write distilled findings back as skills here — but nothing on either
server closes that loop for you.

## Choosing between the two servers

| Need | Server |
|---|---|
| Deterministic CRUD on incidents, services, schedules, teams, orchestrations | `pagerduty-mcp` |
| Structured data you will parse | `pagerduty-mcp` |
| "Why did this break / what should I do" reasoning over an incident | `pagerduty-advance-mcp` → `sre_agent_tool` |
| Runbook generation | `pagerduty-advance-mcp` → `sre_agent_tool` |
| MTTR / trends / exec reporting | `pagerduty-advance-mcp` → `insights_agent_tool` |
| On-call coverage and conflicts | `pagerduty-advance-mcp` → shift tools |
| Persisting instructions for PD's agents | `pagerduty-advance-mcp` → skills tools |

Agent tools return prose, not structured records. Anything you need to parse should come from
`pagerduty-mcp`.

## Re-probing

To regenerate this document after a version bump, POST `initialize` (then the
`notifications/initialized` notification, carrying the returned `Mcp-Session-Id`) followed by
`tools/list`, with `Accept: application/json, text/event-stream`. No config change or client
restart needed.

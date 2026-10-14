# PagerDuty SRE Agent Memory API

A first-class, writable memory store for the PagerDuty SRE Agent. It is a **REST API on
`api.pagerduty.com`**, *not* an MCP tool — neither `pagerduty-mcp` nor
`pagerduty-advance-mcp` exposes it. See [`pagerduty-advance-mcp.md`](./pagerduty-advance-mcp.md)
for the MCP surface.

Sourced from PagerDuty's published OpenAPI spec
([`PagerDuty/api-schema`](https://github.com/PagerDuty/api-schema/blob/main/reference/REST/openapiv3.json),
tag `SRE Agent`) and **verified against the live account on 2026-08-14**. Where the spec and
the live API disagree, both are recorded below.

## Endpoints

Base URL `https://api.pagerduty.com`. Three operations — there is **no create endpoint**.

| Method | Path | operationId | OAuth scope |
|---|---|---|---|
| `GET` | `/sre_agent/memories` | `listSreMemories` | `incident.read` |
| `PUT` | `/sre_agent/memories/{id}` | `updateSreMemory` | `sre_agent.write` |
| `DELETE` | `/sre_agent/memories/{id}` | `deleteSreMemory` | `sre_agent.write` |

Memories are **written only by the agent itself** — during incident work, or via the
**Update Memory** button after resolution. The API gives you read, correct/redact, and delete.
Requires a **PagerDuty Advance** subscription (Enterprise, Business, or Professional).

Auth is the standard REST header, `Authorization: Token token=<key>` — note this differs from
the `pagerduty-mcp` entry in `~/.claude.json`, which sends the bare `Token <key>` form.

### `GET /sre_agent/memories`

Query parameters (all optional):

| Param | Type | Notes |
|---|---|---|
| `limit` | integer 1–100 | Spec's `default` field is the malformed string `"20 - incident_summary"` |
| `service_id` | string | Verified: filters correctly |
| `incident_id` | string | |
| `type` | enum | See the enum discrepancy below |

Response is `{ "limit": N, "memories": [...] }`.

**No pagination beyond `limit`.** The spec defines no `offset`, `cursor`, or `more` field, and
the response carries no continuation token. Accounts with more than 100 memories of one type
cannot be fully enumerated except by narrowing with `service_id`. Ordering was stable across
repeated identical calls.

### `PUT /sre_agent/memories/{id}`

```json
{ "memory": { "content": "…" } }
```

`content` is the only mutable field — you cannot reassign `type`, `service_id`, or
`incident_id`. Returns the updated `SREMemory`. Errors: 400, 401, 403, 404, 429.

Per the spec: *"Changes to the runbook may not update in a currently ongoing conversation, but
will be available to new conversations. To modify the runbook for an in progress conversation
update the runbook via the agent instead."*

### `DELETE /sre_agent/memories/{id}`

Returns `204`. Permanent — no archive or soft delete. Same in-flight-conversation caveat as
`PUT`.

## The `SREMemory` object

```jsonc
{
  "id": "38734b5b-94e6-451b-9f7b-a17819604221",  // UUID, read-only
  "content": "Runbook: booking-service pod CrashLoopBackOff…",  // markdown prose
  "attributes": {
    "account_id": "PLHJ8WE",
    "service_id": "PYM6FPU",
    "incident_id": "PX9LMN2",   // present on incident-scoped types only
    "type": "playbook"
  },
  "created_at": "2026-02-23T19:53:19.268Z",  // read-only
  "updated_at": "2026-02-23T19:53:19.268Z"   // read-only
}
```

`content` is free-form markdown written by the agent — often long, with headings. There is no
structured field breakdown, no tags, and no embedding/similarity surface.

Note `id` is a **UUID**, unlike the classic PagerDuty `P`-prefixed IDs used everywhere else
(and unlike the spec's own examples, which wrongly show `"id": "PM4QR2T"`).

## ⚠️ Type enum: spec vs. reality

The spec and the live API do not agree. Verified by filtering on each value:

| Value | In `SREMemory.type` enum | In `?type=` filter enum | Live result |
|---|---|---|---|
| `runbook` | ✅ | ✅ | ✅ works — 9 returned |
| `service_profile` | ✅ | ✅ | ✅ works |
| `incident_summary` | ✅ | ❌ **omitted** | ✅ works |
| `playbook` | ❌ **absent** | ❌ **absent** | ✅ works — the real value |
| `incident_playbook` | ✅ | ✅ | ❌ **returns 0 — does not exist** |

**Use `playbook`, not `incident_playbook`.** The documented name silently returns an empty
list rather than an error, so a filter built from the spec will look like "no data" instead of
failing. An unknown value (`bogus_value`) also returns `200` with zero results — there is no
validation error to catch this.

Actual live distribution on this account (first 100 records): `incident_summary` 60,
`playbook` 21, `service_profile` 19, spread across 8 services; 80 of 100 carried an
`incident_id`.

## The four memory kinds

Per [PagerDuty's SRE Agent docs](https://support.pagerduty.com/main/docs/sre-agent), all
memory is **scoped to a PagerDuty service**:

- **`playbook`** — "SRE Incident Playbook" / scratchpad. Prioritised resolution steps derived
  from historical incident patterns; improves per resolved case.
- **`runbook`** — Customer Service Runbook. Ingested org documentation (Confluence, GitHub
  pages, SOPs) plus manually supplied material.
- **`incident_summary`** — auto-generated on incident close: key learnings, resolution
  details, troubleshooting path.
- **`service_profile`** — service metadata: cloud provider, region, service type, relevant log
  search queries, gathered from runbooks, event payloads, and user interaction.

## Practical notes

- **429s come fast.** Sustained probing tripped `429 Too Many Requests` within a handful of
  requests. Back off and cache.
- **Read scope is broad, write scope is narrow.** `GET` only needs `incident.read`, so plenty
  of existing tokens can already read the whole account's memory corpus. `sre_agent.write` is
  a distinct scope.
- **No create, no search.** You cannot seed a memory via API, and there is no full-text or
  semantic query — retrieval is filter-by-ID then read `content` yourself.

## How this changes the MCP picture

Earlier conclusion was that the Advance MCP **skills registry** was the only writable
persistent store. That was right about MCP but incomplete about PagerDuty overall. The two are
different layers and should not be confused:

| | Skills registry (MCP) | Memory API (REST) |
|---|---|---|
| Access | `pagerduty-advance-mcp` tools | `api.pagerduty.com` REST |
| Written by | You | The agent |
| Purpose | Instructions that steer the agent | Knowledge the agent learned |
| Identity | `(agent_type, scope, name)` | UUID |
| Scoping | account / user | service (+ incident) |
| Create | ✅ | ❌ |
| Limits | ≤5000 tokens, 25–50 items | no stated cap; 100/page, no paging |

Skills are the **input** side, memories the **output** side. A "sre-memories" tool has an
obvious shape here: `GET /sre_agent/memories` is the corpus, and the gaps worth filling are
the ones PagerDuty leaves open — no search, no pagination past 100, no cross-service view, and
no way to author a memory directly.

## Sources

- [SRE Agent — PagerDuty support docs](https://support.pagerduty.com/main/docs/sre-agent)
- [Update an SRE Agent memory — API reference](https://developer.pagerduty.com/api-reference/6d375d154b4dc-update-an-sre-agent-memory)
- [PagerDuty/api-schema OpenAPI spec](https://github.com/PagerDuty/api-schema/blob/main/reference/REST/openapiv3.json)
- [We Built an SRE Agent With Memory](https://www.pagerduty.com/blog/ai/we-built-an-sre-agent-with-memory-and-its-transforming-incident-response/)
- [SRE Agent Skills — Early Access changelog](https://support.pagerduty.com/main/changelog/sre-agent-skills-now-available-for-early-access)

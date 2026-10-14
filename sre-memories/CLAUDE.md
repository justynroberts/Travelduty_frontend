# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser UI for viewing, editing, and deleting **PagerDuty SRE Agent memories** via the REST API (`/sre_agent/memories` on `api.pagerduty.com`), plus two reference docs. No build, no dependencies, no tests.

Lives in `sre-memories/` inside the `Travelduty_frontend` repo. The rest of that repo (`destinations/`, `kubernetes/`, `packages/`, root `README.md`) is fake data rewritten by an automated scheduler roughly every 10 minutes — don't edit it, and `git pull --rebase` before pushing.

- `index.html` — the entire app: inline CSS + vanilla JS, single file. Fonts from Google Fonts; everything else inline.
- `serve.py` — stdlib static server bound to `127.0.0.1`, with `no-store` cache headers and a `POST /diag` sink.
- `sre-agent-memory-api.md` — endpoint reference, verified live 2026-08-14. **Read before changing any API call** — it records where the OpenAPI spec and the live API disagree.
- `pagerduty-advance-mcp.md` — reference for the `pagerduty-advance-mcp` server. Neither PD MCP server exposes the memory API; it is REST only.

## Running

```bash
cd sre-memories && python3 serve.py   # http://127.0.0.1:8765  (port is argv[1]); serves from cwd
```

The no-store headers exist so a stale cached copy is never the reason a change seems not to land — use the server rather than opening the file via `file://`.

## Architecture notes

- **Browser calls PagerDuty directly.** `pd()` in `index.html` is the single fetch wrapper: `Authorization: Token token=<KEY>`, 20s abort timeout, one retry on 429, and status-specific error messages (403 on writes → missing `sre_agent.write` scope).
- **API constraints shape the UI:** there is no create endpoint, `PUT` replaces `content` only (in full), `DELETE` is permanent, and there is no pagination beyond `limit=100` — so memories are loaded per service (`service_id` filter) and per `service_id`+`type` (`typedCache`), not by enumerating the account.
- **Key handling:** the API key lives in a JS variable; "remember" stores it in `sessionStorage` (`pd_key`) only. All storage access goes through the `store` helper, which swallows exceptions (storage throws under `file://` in Safari).
- **Diagnostics:** `report()`/`glog()` POST boot/connect steps to `/diag`, which `serve.py` appends to `diag.log` in its working directory (gitignored via `*.log`). These must never include the key — only its length. Check `diag.log` first when the UI "does nothing".
- The memory map view (`layout`/`buildMap`/`wireMap`) is a hand-rolled SVG with pointer-based pan/zoom; clicks open the edit drawer (`openDrawer`).

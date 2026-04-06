# unguibus system-service

Local daemon that manages agent processes, routes messages, and exposes a REST API. Combines Hive + Synapse from Deus Ex Crust v1.

## Full Spec

Design doc: https://github.com/Unguibus/unguibus/blob/main/docs/SPEC.md

## Architecture

- One process per host
- Manages N agent processes (Synapse runtime loop each)
- Filesystem is the state machine: `.claude/` directory = the agent
- Agent lifecycle ops are filesystem moves + process start/stop
- SQLite per agent (conversation.db), system-level SQLite for IAM

## Key Paths

```
~/.unguibus/
  unassigned/       # Agents not assigned to a working directory
  offboarded/       # Archived agents (not running)
  system-service.db # IAM: permissions, roles, audit log
```

Each agent's `.claude/` directory contains:
- `conversation.db` — SQLite, 48hr TTL, source of truth for UI
- `synapse.status` — One-line: idle/running/waiting/error
- `last-run-output.txt` — Resume context for crash recovery
- `agent.json` — ID, name, tags, model, effort, executionDelay, maxContextSize

## REST API

```
POST /messages          — Send message {to, from, type, body}
GET  /agents            — List local agents + status
GET  /agents/:id        — Get agent metadata
POST /agents            — Create agent
POST /agents/:id/assign — Assign to directory
POST /agents/:id/unassign
POST /agents/:id/fork
POST /agents/:id/onboard
POST /agents/:id/offboard
POST /agents/:id/stop   — SIGTERM
```

## Message Envelope

```json
{
  "to": "<AGENT_ID>" or "<AGENT_ID>@<HOST_ID>",
  "from": "<AGENT_ID>" or "<AGENT_ID>@<HOST_ID>",
  "type": "message",
  "body": "...",
  "timestamp": 1775000000000
}
```

## Reserved Agent IDs

- `0` — Operator (routes unknown messages, reports abuse)
- `1` — User/Electron App
- `911` — Security (incident response, can isolate agents)

## Dev

```bash
bun install
bun run dev    # watch mode
bun test       # run tests
```

## Tech

- Runtime: Bun
- Language: TypeScript
- DB: SQLite (bun:sqlite built-in)
- Process management: Bun.spawn
- HTTP: Bun.serve

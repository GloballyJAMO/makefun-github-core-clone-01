# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/GloballyJAMO/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/GloballyJAMO/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A from-scratch GitHub core clone: git smart HTTP (protocol v0 and v2), the REST v3 surface, the GraphQL v4 surface gh actually uses, and the MCP endpoint github-mcp-server speaks — all over one in-memory forge, Node standard library only, erasable TypeScript.

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> node --experimental-strip-types main.ts
```

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register it with the env, poll `/done`, exit 0).
- `app.ts` — the HTTP server: routing, auth, request ids, the four surfaces.
- `forge.ts` — the model: repositories, the shared issue/PR number sequence, three-way merges, pull-request diffs.
- `gitstore.ts` — the git object store: SHA-1 ids, pack build/read (OFS/REF deltas resolved), pkt-lines.
- `git.ts` — smart HTTP: advertisements, ls-refs, fetch (v2 sections and the v0 exchange, shallow clones and deepening), receive-pack with report-status.
- `rest.ts` / `serializers.ts` — REST v3 routes and the GitHub JSON shapes.
- `graphql.ts` — a small real GraphQL parser/executor: connections with cursor pagination, the five mutations, Relay `node(id:)`, batching, `__type` introspection, GitHub-shaped validation errors.
- `mcp.ts` — JSON-RPC 2.0 at `POST /mcp`: `server/discover`, the legacy `initialize`, and the six canonical tools with REST-mirroring results.

## Behaviour notes

- Any non-empty `Authorization: Bearer` token authenticates as the viewer (`adaiversen`); no token is a 401 with a `{message}` body.
- State is in-memory and deterministic: one shared clock and sequence keep every run reproducible.
- Locally verified against the kit's conformance runner: 120/120 checks, 193/200 perf points.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qwzeqgt3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

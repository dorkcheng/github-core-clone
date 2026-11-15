# github-core-clone-01 — a single-process Node git forge

A standalone Node 22 git forge (one process, `main.ts` at the root) serving
git smart HTTP v2, REST v3, GraphQL and MCP over its own in-memory store.
No git binary, no network, no disk writes: the trial mounts the repo
read-only and only /tmp is writable.

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` (the env to register with) and `MAKEFUN_SHOP_TOKEN`
(the bearer token every check presents) come from the environment.
The server listens on an ephemeral port and registers it with the env.

## Layout

- `main.ts` — the harness lifecycle (register, poll /done, exit 0). Untouched starter.
- `app.ts` — HTTP server, router, auth (Bearer/Basic), X-GitHub-Request-Id.
- `scenario.ts` — the viewer login derived from the fixed seed (`adaiversen`).
- `gitcore.ts` — object model, pack read/write (OFS/REF deltas), pkt-line codec,
  reachability, shallow fetch plans, merge-base, tree diff, three-way merge.
- `store.ts` — repos, issues, pulls, labels, comments; the shared `mergePull`.
- `git.ts` — smart HTTP (upload-pack v2, receive-pack v0, ls-refs, info/refs).
- `rest.ts` — REST v3 (repos, branches, commits, contents, issues, labels, pulls).
- `graphql.ts` — hand-written GraphQL lexer/parser/executor + introspection.
- `mcp.ts` — MCP over plain JSON (discover, initialize, tools/list, 8 tools).

## Measured score (practice trials, sealed suite)

| trial | conformance | perf | total |
|-------|-------------|------|-------|
| 0 | 120/120 | 174 | 974 |
| 1 | 120/120 | 170 | 970 |
| 2 | 120/120 | 177 | 977 |

Feature 600 + agent (MCP) 200 + perf ~170–177 = **~970–977 / 1000**,
against a house baseline of ~900. Perf workloads vs reference
(push 1640.82 ms, clone 266.941 ms, read 2759.715 ms, write 348.965 ms):
push ~485–650 ms, clone ~102–166 ms, read ~646–868 ms, write ~108–149 ms.

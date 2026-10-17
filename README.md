<!-- xcoder:version 12 | xcoder:task task-81af05 | xcoder:updated 2026-10-17T13:29:38.376Z | xcoder:subtask code-st-f1c53a -->
# Kooder

Kooder is a command-line worker orchestrator. You give it one task description plus a list of
self-contained subtasks; it runs one ReAct **worker agent** per subtask — concurrently, with
retries — and prints an aggregated report.

There is exactly one worker-orchestrator, one agent shape, and a workspace index that acts as the
source of truth for which files exist. Everything else that used to live in this repository (the
SDLC stage tree, the instance swarm, the backlog, the role-specific agents, and the tools that
dispatched them) was removed in the rebrand that produced Kooder v3. See
[What changed in the Kooder rebrand](#what-changed-in-the-kooder-rebrand).

- Package: `kooder-cli` v3.0.0 — bins `kooder` and `worker` (both `./dist/cli-worker.js`)
- Runtime: Node >= 20, ESM
- Entrypoint: `src/cli-worker.ts`

## Install

```bash
npm install
npm run build        # tsc -p tsconfig.json
npm run kooder:link  # or: npm link — puts `kooder` and `worker` on your PATH
```

Without linking, run it straight from source:

```bash
npm run dev -- run --task "tidy up" --subtask "delete dead exports in src/util"
```

## Usage

The CLI has a single command, `run`, under the `kooder` program name:

```bash
kooder run --task <text> (--subtasks <file> | --subtask <goal> ...) [options]
worker run ...   # same binary, same flags
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--task <text>` | Task description. Required. | — |
| `--subtasks <file>` | JSON file: `string[]` or `{id,goal,role?}[]`. `-` reads stdin. | — |
| `--subtask <goal>` | Repeatable single subtask (collector). | `[]` |
| `--concurrency <n>` | Max in-flight workers. | `3` |
| `--max-attempts <n>` | Total attempts per subtask (not retries). | `2` |
| `--workspace <dir>` | Workspace root. | `process.cwd()` |
| `--model <name>` | Overrides the configured LLM model. | — |
| `--task-id <id>` | Explicit run id. | `kooder-<timestamp>` |
| `--json` | Machine output: the report only, nothing else on stdout. | `false` |
| `--quiet` | Suppress progress notes. | `false` |
| `--no-color` | Disable colour output. | colour on |
| `--config <settings>` | Persist LLM settings first, then continue with the run. `show` prints the stored values, `-` reads them from stdin. | — |

You must supply at least one subtask. Subtask entries without an `id` get `st-<n>` in order.

### Persisted settings (`--config`)

`--config` writes `~/.kooder/config.json` (or `KOODER_CONFIG_FILE` if set) so later runs pick
the values up. It works at the root level too, where it is a settings command and does not start
a run:

```bash
kooder --config "mode=ollama,model=llama3"     # settings only, exit 0
kooder --config "provider=deepseek,key=sk-…,model=deepseek-chat"
kooder --config show                            # print what is stored (secrets masked)
echo 'key=sk-…' | kooder --config -             # keep the secret out of shell history
```

| Token | Meaning |
| --- | --- |
| `provider=` / `mode=` | One setting. Aliases: `deepseek`, `anthropic`/`claude`, `openai`/`openai-compatible`, `ollama`. |
| `mode=ollama` | Shorthand for an OpenAI-compatible endpoint with `base_url=http://localhost:11434/v1` (override with your own `base_url=`). Pass `model=` too — no model is guessed. |
| `key=` / `api_key=` | API key. Masked in every summary. |
| `model=` | Model name. |
| `base_url=` / `url=` | Endpoint; must be `http://` or `https://`. |
| `env.NAME=` or `UPPER_CASE_NAME=` | Extra environment variable. Names that could redirect execution or traffic (`PATH`, `NODE_OPTIONS`, `LD_*`, proxies, …) are rejected. |
| `name=` (empty value) | Deletes that setting. |

Rules worth knowing:

- All-or-nothing: if any token is invalid, **nothing** is written and the exit code is `2`.
- `mode` and `provider` are the same setting. Giving both with different values
  (`mode=ollama,provider=deepseek`) is an error rather than a silent order-dependent win.
- Repeating a setting with the same value is fine; repeating it with a different value is an error.
- Precedence is frozen: a variable **exported in your shell** beats `config.json`, which beats
  `.env`. When a written value will be shadowed, the command says so.
- The file is written atomically with owner-only permissions (`0600` in a `0700` directory).
- Secrets passed on the command line are visible in shell history and the process table; prefer
  `--config -` and expect a one-line warning when a secret-named token arrives via argv.

### Examples

```bash
kooder run --task "harden auth" \
  --subtask "rate-limit /login" \
  --subtask "add regression test for the lockout path" \
  --concurrency 2 --max-attempts 3
```

```bash
kooder run --task "docs pass" --subtasks subtasks.json --json > report.json
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Run finished with status `completed` or `partial`. |
| `1` | Run finished with status `failed`, or an unexpected runtime error. |
| `2` | Usage error (missing `--task`, empty goal, unreadable/invalid `--subtasks`, not a JSON array, …). Usage errors never print a report. |

`--json` keeps stdout strictly parseable: on a usage/runtime error the JSON document is
`{"error": "…", "usage": true|false}` and diagnostics go to stderr.

Ctrl+C aborts **new** waves only — in-flight agents finish naturally. There is no real-time
cancellation of an in-progress LLM call; that is deliberate.

## How a run works

```
kooder run
  └─ createLlmClient("sub_agent")            src/llm/factory.ts
  └─ getOrBuildIndex(workspaceRoot)          src/tools/workspace-index.ts   (best-effort)
  └─ WorkerOrchestrator.run(request)         src/worker-agent/worker-orchestrator.ts
       └─ dispatchSwarm(ready, {concurrency})  src/orchestrator/swarm.ts
            └─ SubAgent.run(node)              src/agents/sub-agent.ts
                 └─ ReAct loop ⇄ dispatchTool  src/protocol/react-contract.ts + src/tools/tool-registry.ts
       └─ retry policy (maxAttempts) → WorkerRunReport
```

The worker orchestrator deliberately holds **no** `stage`, `engine`, `dependsOn`,
`acceptanceCriteria` or `healing` field on its public input (`WorkerSubtask`). An SDLC stage
cannot reach this code path by construction. What is left is the retry policy and report
assembly; concurrency and crash isolation are delegated to `dispatchSwarm`, which never throws
because of anything a single agent does — a crashed agent becomes a `crashed: true` result, not a
failed `Promise.all`.

Reports are flat and JSON round-trip safe: `WorkerRunReport` carries `status`
(`completed` | `partial` | `failed`), per-subtask `status`/`attempts`/`filesTouched`/`tokenUsage`
and a `history[]` with one record per attempt, so retries are assertable rather than inferred.

## Configuration

### LLM providers

Per-role provider configuration lives in **`.kooder/config/llm.yaml`** (resolved through
`createKooderPaths().llmConfigPath()`), with a `default` block plus optional role blocks
(`orchestrator`, `sub_agent`, `swarm_agent`, `instance_agent`). Precedence inside
`resolveLlmConfig` is: role block → `default` block → built-in DeepSeek default.

A workspace that still only has `.koober/config/llm.yaml` or `.xcoder/config/llm.yaml` keeps working — the state directory
falls back for reading until a `.kooder` directory exists (see
[State directory](#state-directory)).

### Environment variables

All Kooder environment reads go through `readKooderEnv` in `src/config/env.ts` — it is the only
module that reads a Kooder-branded variable. `KOODER_*` wins. The legacy `KOOBER_*` and `XCODER_*` names are still
honoured as deprecated aliases with a one-time stderr notice each, so an existing setup survives the
rename:

| Variable | Purpose |
| --- | --- |
| `KOODER_DIR` | Explicit state-directory name/path. Wins outright. |
| `KOODER_HOME` | Directory the CLI treats as home for config and `.env`. |
| `KOODER_CONFIG_FILE` | Explicit user config file. |
| `KOODER_DEBUG_CONFIG_PATH` | Dump resolved config paths for debugging. |
| `KOODER_MODEL` | Overrides `model` only. |
| `KOODER_EXTERNAL_SKILLS` | Boolean flag (`true`/`1`/`yes`) that enables loading external skills. |

`.env` is loaded from the app directory, `KOODER_HOME`, and the current working directory (cwd
last, with `override: true`), and `~/.kooder/config.json` is applied on top of that — but the real
shell environment still beats both.

### State directory

`src/util/kooder-paths.ts` is the **single** factory for every runtime path. No module may
hardcode a directory name.

```
<workspace>/.kooder/
  tasks/<taskId>.json
  tasks/<taskId>.md
  config/llm.yaml
  logs/<taskId>/
  screenshots/
  output.db
```

Resolution order in `resolveStateDir(workspaceRoot)`:

1. An explicit `KOODER_DIR` (absolute paths used verbatim) — never second-guessed.
2. `.kooder` if it exists.
3. `.koober` if it exists (read-fallback for the previous brand).
4. `.xcoder` **only** if it exists and neither of the above does (read-fallback for pre-rebrand installs).
5. Otherwise `.kooder`.

The resolved root is used for **both reads and writes**: no split-brain, and no automatic migration of your data. When a legacy directory is in use, `kooder` prints a one-time notice naming it; migrate with `mv .koober .kooder` (or `mv .xcoder .kooder`) whenever you like.



## Development

```bash
npm run typecheck    # tsc --noEmit -p tsconfig.json
npm test             # vitest run
npm run regression   # alias of npm test
```

Current gate: **70 test files passed, 1 skipped; 1344 tests passed, 30 skipped; 0 failures** (71 files / 1374 tests),
with `npm run typecheck` clean.

Two intent oracles guard the rebrand:

- `src/agents/worker-only-architecture.test.ts` — one agent tree, no regrowth of the deleted role
  agents, the worker CLI as sole entrypoint, the `kooder` package name/description, the
  `kooder`+`worker` bins (and no `koober`), and `.kooder` as the default state dir with a single
  path factory (`kooder-paths.ts`; `koober-paths.ts` must not exist).
- `src/agents/kooder-rebrand.test.ts` (10 tests) — the user-facing surface: root help reads
  `Usage: kooder …` and says "Kooder" with neither retired brand name, `kooder run --help`,
  `--version` equals `KOODER_VERSION` and is semver, `package.json.version` is in lockstep with it,
  `KOODER_BUILD_TIMESTAMP` round-trips as ISO-8601, the version module exports no retired alias,
  and `npm run check:brand` exits 0.

A regression that re-adds a second agent tree or the old brand fails there first. The legacy brand
names are assembled from parts inside the rebrand test so the file itself stays off the residue
gate's allowlist.

Ignored optional fixtures (e.g. an absent `skills/` directory) are skipped, not failed —
`src/skills/skill-file-validation.test.ts` uses `describe.skipIf` so the skip is visible.

## Known follow-ups

Verified against the tree on 2026-10-17; anything already fixed was removed from this list.

- **Stale doc comments** — `src/config/loadConfig.ts:100` and `:265` still describe
  `.xcoder/config/llm.yaml` and `~/.xcoder/config.json`. The code resolves `.kooder` in both places
  (`RELATIVE_CONFIG_PATH`, and `userConfigPath()` in `src/config/user-config.ts:46`). Tracked as
  `.xcoder/defects/defect0001.md`; comments are invisible to the residue gate, which only scans for
  the `koober` tier.
- **User-Agent** — `src/tools/github-tool.ts:67` still sends `User-Agent: xcoder-sdlc-cli`.
  Deliberately not renamed in this pass: it is an outbound identifier, so changing it deserves its
  own change and a decision about whether any server keys off it.
- **Unused type surface** — `src/types.ts:27` (`Role`) and `:48` (`EngineName`, including
  `rewoo-v1` / `plan-execute-v1` / `reflexion-v1`) are retained for prompt routing even though only
  `react-v1` and the worker path are exercised.
- **Legacy `RONIN_*` shim** — `src/config/loadConfig.ts:71-77` maps `RONIN_*` onto `XCODER_*`, i.e.
  the oldest alias tier now hops through the deprecated middle tier instead of mapping straight to
  `KOODER_*`. Works, but a two-hop alias is harder to reason about than a direct one.
- **State-directory migration is manual** — there is no auto-migration; see
  [State directory](#state-directory) for the resolution order and the `mv` command.

The earlier entries about `.gitignore`, `config.example.json`, prompt text and `llm/factory.ts` are
resolved and were removed: `.gitignore` now ignores `.kooder/` and `.koober/`, `config.example.json`
sets only `KOODER_EXTERNAL_SKILLS`, prompts say "Kooder", and `factory.ts` carries no legacy paths.

<!-- xcoder:version 11 | xcoder:task task-1f0256 | xcoder:updated 2026-10-17T14:48:58.733Z | xcoder:subtask document-st-252a45 -->
# `litecoder` — what was built and why

This is the change record for the `litecoder` CLI requested in [`task1.md`](../task1.md). It is written for someone who was not in the room: what shipped, which decisions were non-obvious, how it was verified, what is still broken, and how to back it out. User-facing usage belongs in [README.md](../README.md); this page holds the rationale.

Design source: `.xcoder/backlog/litecoder-design.md` (components C1-C6, tradeoffs T1-T6, traceability AC1-AC17). Requirements source: `.xcoder/backlog/litecoder-requirements.md`.

## The request, and what it became

The brief asked for a new CLI named litecoder: a lightweight agent CLI that orchestrates a task with a swarm of role-mapped Sub Agents, where the orchestrator **has no tools** and *if it needs something it calls the sub agent*, with crash isolation, ReAct healing, a duplicate checker, and an **optional** `--secure` flag wired to `secure-architect.bylaws.ts`.

The two invocation examples in the brief are the whole acceptance surface — one positional goal, no `run` / `--task` / `--subtask` ceremony, unlike the existing `kooder run --task ... --subtask` form. Everything below follows from taking that literally.

It is **additive**. `kooder` and `worker` keep working byte-identically; litecoder is a third `bin` entry (requirements Q1, resolved in design section 0).

## Files

| File | Role |
| --- | --- |
| `src/litecoder/cli.ts` | **New.** The litecoder bin: parse, build two LLM clients, plan, dispatch, print. A `UsageError` gives exit 2, runtime failure exit 1, `exitCodeFor()` maps to 0/1. |
| `src/litecoder/master-orchestrator.ts` | **New.** The planner (C1). The only component that talks to a model, and it does so with `NO_TOOLS`. Turns one goal into a schema-valid `Plan`; never executes it. |
| `src/litecoder/no-tools.ts` | **New.** `NO_TOOLS` registry, `OrchestratorHasNoToolsError`, `isNoToolsRegistry`. The no-tools guarantee expressed as a type. |
| `src/litecoder/plan-schema.ts` | **New.** The trust boundary (C2): zod `PlanSchema` / `PlannedSubtaskSchema` / `RoleSchema`, `parsePlan`, `MAX_SUBTASKS_HARD_CAP`. |
| `src/litecoder/dispatcher.ts` | **New.** Plan to work (C4). Resolves `dependsOn` into sequential topological waves and adds a `skipped` status; delegates everything else to `WorkerOrchestrator`. Never rethrows a subtask error. |
| `src/litecoder/secure-gate.ts` | **New.** The **only** place that reads `--secure` (C3). Decides whether to ask the bylaws and which layers apply; it does not invent approval rules. |
| `src/litecoder/report.ts` | **New.** `LitecoderRunReport`, `deriveStatus`, `exitCodeFor`, `formatHumanReport`, `summariseBylawVerdicts`. |
| `src/litecoder/index.ts` | **New.** Small barrel; exports `NO_TOOLS` so a reviewer can assert the empty tool surface without reaching into internals. |
| `src/types.ts` | **Changed.** Adds a runtime `ROLES` tuple and derives `Role` from it (type-identical). Exists so `z.enum(ROLES)` can validate a role at the trust boundary. |
| `package.json` | **Changed.** Adds the `litecoder` key to `bin`, pointing at `./dist/litecoder/cli.js`. Nothing else. |
| `src/agents/worker-only-architecture.test.ts` | **Changed, one assertion.** The intent oracle previously asserted exactly two bins; it now expects the three-bin set plus the exact dist target. Called out per AC14 (see T1). |

Deliberately **unchanged**: `src/skills/secure-architect.bylaws.ts` (frozen input, AC12), `src/cli-worker.ts`, `src/worker-agent/*`, `src/agents/sub-agent.ts`, `src/agents/duplicate-detector.ts`, `src/protocol/react-contract.ts`, and all `.kooder` state paths. The new tree is confined to `src/litecoder/`; no `src/sdlc-agent`, `src/instance-swarm`, or `src/backlog` was added (design section 7.1).

## Decisions worth knowing

**No-tools is structural, not prompted.** The `MasterOrchestrator` constructor takes a tool registry and *refuses anything except `NO_TOOLS`*; lookups throw `OrchestratorHasNoToolsError` naming the tool, and the registry is frozen so a later write cannot grant a capability. A prompt telling the model it has no tools would be advice; this is a fact (PRM-04/PRM-09, AC5). The report's `toolCount` is `0` by construction.

**The goal is data, not instructions.** The goal arrives in a labelled data block and is never concatenated into the instruction section, with a 4,000-character cap on the goal and an 8,000-character cap on transcript text (PRM-01/PRM-02, AC17). An injected goal cannot widen tool scope or flip `--secure`.

**Termination does not depend on model behaviour.** Three independent bounds: `maxPlanSteps` (default 3) hard-caps the loop; `DuplicateActionDetector` stops an identical repeated submission and reports `reason: 'stuck'`; `PlanSchema` rejects malformed output so there is no partial plan. Fail closed — an `ok: false` outcome dispatches **zero** subtasks and exits non-zero (AC4, AC8, AC9, PRM-07).

**`--secure` defaults to OFF — an accepted, owned risk against CORE-04.** Bylaw approval is strict: `evaluateReview` marks every in-scope bylaw with no finding as `unreviewed`, and unreviewed blocks. Enforcing by default would therefore reject the brief's own first example on its first run. The risk is owned rather than ignored by (a) always printing `secure.mode`, including `off`; (b) an advisory line at the end of the human report when off; (c) the decision living in exactly one function, `createSecureGate`, so flipping the default is a one-line change. **Owner: security-lead.** (T3)

**`--secure off` is a full opt-out, not a muted reviewer.** `promptBlock()` and `judge()` return `null`, no bylaw text reaches any prompt, and `bylaw` is `null` in the report, so security state cannot influence the run status (AC11). Under `--secure`, a blocked verdict downgrades `completed` to `partial` (AC10); `summariseBylawVerdicts` returns `null` when nothing was judged precisely so this cannot leak.

**Bylaw scope is gated by role, not by keyword.** Whether a subtask gets bylaws is decided by `BYLAW_GATED_ROLES` (`architect`, `system-architect`, `security-lead`), which mirrors `BYLAW_GATED_STAGES`; *which* layers apply is decided by `inferLayers(subtaskGoal)`. Gating on `inferLayers` alone was rejected because a goal that happens to say `api` would drag bylaws into a `technical-writer` subtask. Cost accepted and documented: a genuinely security-implicating subtask whose role is not in the list gets no bylaws under `--secure`. (T4)

**Reuse the engine rather than write a second swarm.** `dispatchPlan` delegates concurrency, per-subtask retries, attempt history, and crash isolation (`crashed: true` instead of a rejected promise) to the existing `WorkerOrchestrator`. `src/litecoder/dispatcher.ts` adds only the two things a *plan* has that a *worker request* does not: `dependsOn` (resolved into sequential waves, never pushed down, because independence there is a deliberate contract we do not widen) and a `skipped` status for a subtask whose dependency did not succeed — it is never dispatched, so it must never be reported as `failed`. (T2)

**A new entrypoint beat an argv-rewriting shim.** The rejected option was making litecoder a shim that rewrites argv into the existing `kooder run --task ... --subtask` form and avoids touching CI. A shim has nowhere to carry the role-mapped plan, the bylaw verdict, or the Action-to-Observation trace, so AC3/AC6/AC10/AC11 would have been faked through string munging — and a hidden second entrypoint is still a second entrypoint. Cost accepted: exactly one oracle assertion changed, so this diff wants a reviewer who understands *why* it changed. (T1)

**One inherited consequence, stated plainly.** `WorkerOrchestrator`'s `isFailure` predicate is `crashed || iterationsExhausted`, so a subtask that reports `crashed: false` but produces nothing useful counts as `done`. That is inherited, not introduced; the dispatcher wrapper and `deriveStatus` are where it is visible and testable. (T2)

**No new runtime dependencies.** `commander`, `zod`, and the existing LLM client cover the surface, so the supply-chain / AI-BOM story is unchanged. (T6)

## Verification

Everything below was run in this workspace against the actual tree.

| Command | Result |
| --- | --- |
| `npx vitest run` (full gate) | **exit 0** — 79 test files passed, 1 skipped (80); 1,434 tests passed, 30 skipped (1,464) in 27.6s |
| `npx vitest run src/litecoder` | **exit 0** — 5 files, **41 tests**: `secure-gate` 7, `report` 9, `plan-schema` 10, `master-orchestrator` 9, `dispatcher` 6 |
| `npm run typecheck` | **exit 0** (`tsc --noEmit`) |
| `npm run build` | **exit 0**; `dist/litecoder/cli.js` emitted |
| `node dist/litecoder/cli.js` (no goal) | **exit 2**, message on stderr only — usage errors never print a report |
| `node dist/litecoder/cli.js --help` | exit 0; positional `goal` documented as untrusted input, alongside `--secure`, `--concurrency`, `--max-attempts`, `--max-plan-steps`, `--max-subtasks`, `--workspace`, `--model`, `--task-id`, `--json`, `--quiet`, `--no-color` |

The suite does **not** cover a live end-to-end plan-to-dispatch run, because that needs a real model credential; the planner and dispatcher are covered through injected fake LLM clients instead.

## Known open defect

**`src/litecoder/cli.ts` parses `process.argv` at module scope with no main guard.** The `program.parseAsync(process.argv).catch(...)` call sits at the bottom of the module (~line 225), and commander's `.action()` is registered at import time. Consequence: *importing* `cli.ts` executes it against the host argv, which makes the exit-code contract (0/1/2) untestable in-process — a harness can only observe exit 2 by spawning the built binary. Verified directly: importing `dist/litecoder/cli.js` with `--help` in `process.argv` printed the full help and never returned to the caller's next statement. Severity: high for testability, low for runtime behaviour.

> **Orchestrator note:** a prior test-stage subtask reported adding `src/litecoder/no-tools.test.ts`, `src/types.test.ts`, `src/litecoder/cli-bin.test.ts`, and `.xcoder/defects/defect0001.md`. **None of those files exist on disk** — `src/litecoder/` contains exactly the five suites counted above, and `src/types.test.ts` is absent. The same subtask flagged its own tool channel as unreliable. Treat its requirement-coverage claims as unverified until those tests are actually written; every count in this document comes from a fresh run, not from that report.

## Rollback

Additive and single-commit reversible:

1. Delete `src/litecoder/` and `docs/litecoder.md`.
2. Remove the `litecoder` key from `bin` in `package.json`.
3. Revert `src/types.ts` to the hand-written `Role` union (the `ROLES` tuple is type-identical, so nothing else depends on its deletion).
4. Restore the two-bin assertion in `src/agents/worker-only-architecture.test.ts`.

`kooder`, `worker`, the bylaws module, and all on-disk state are untouched by the rollback.

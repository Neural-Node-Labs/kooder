<!-- xcoder:version 1 | xcoder:task task-81af05 | xcoder:updated 2026-10-17T13:38:35.740Z | xcoder:subtask document-st-db0367 -->
# `kooder --config` — what was built and why

This is the change record for the settings-persistence capability. It is written for
someone who was not in the room: what shipped, which decisions were non-obvious, how it
was verified, and how to back it out. User-facing usage lives in
[README.md](../README.md#persisted-settings---config); this page holds the rationale.

## The request, and what it became

The ask was literally:

```bash
kooder --config mode=ollama,key=2222,provider=deepseek
# -> writes ./kooder/config.json in the home directory
```

That one line hides three separate problems, and each drove a design decision:

| Request element | Problem it exposes | Decision |
| --- | --- | --- |
| `mode=ollama` | `mode` is not in the schema; `ollama` is not a provider | Treat `mode` as an alias of `provider`; expand `ollama` into `provider=openai-compatible` plus a default local `base_url` |
| the same string also says `provider=deepseek` | `mode` and `provider` write the same slot and disagree | **Refuse** the whole request (exit 2, nothing written) instead of letting the last token win |
| `key=2222` in argv | A secret in argv is visible in shell history and the process table | Persist it, but warn once and point at `--config -` (stdin) |
| `./kooder/config.json` in home | The path had to match the existing state-directory factory | `<home>/.kooder/config.json`, overridable with `KOODER_CONFIG_FILE` |

So the literal command in the request is a **usage error**, and that is the intended
outcome — the two tokens genuinely contradict each other. A user who meant Ollama writes
`--config "mode=ollama,key=2222,model=llama3"`; a user who meant DeepSeek drops `mode`.

## Files

| File | Role |
| --- | --- |
| `src/config/settings-schema.ts` | **New.** Pure resolution layer: tokenising, `mode`/`provider` aliasing, Ollama expansion, duplicate/conflict detection, shell-shadow lookup. No I/O, no `process.env` mutation — which is what makes it table-testable. |
| `src/config/user-config.ts` | Lexical `parseConfigArg`, `userConfigPath()`, `readUserConfig` / `saveUserConfig` / `applyUserConfig`, `maskSecret`, `extractConfigArg`. |
| `src/config/config-command.ts` | The controller for one `--config` invocation (`runConfigCommand`): validate, write once, apply, format; owns the exit codes. |
| `src/cli-worker.ts` | `maybeRunConfigCommand(argv)` runs before `program.parseAsync()` and decides whether argv is a config command, a run that first persists settings, or untouched commander input. |
| `src/config/intended-behaviour.test.ts` | **New.** 6 tests written against the request as the oracle, not the implementation. |

Supporting suites that already covered the storage layer: `settings-schema.test.ts` (16),
`config-command.test.ts` (17), `user-config.test.ts` (9), `loadConfig.test.ts` (13),
`env.test.ts` (34), `cli-worker.config.test.ts` (10).

## Decisions worth knowing

**All-or-nothing writes.** `runConfigCommand` validates every token before touching the
disk, so one bad token means exit 2 and *zero bytes written*. The ordering is deliberate
and load-bearing: validate everything, write once, apply, format. A half-written config
is worse than a rejected command.

**A corrupt `config.json` is never clobbered.** `saveUserConfig` calls `readUserConfig`
first, which throws on unparsable JSON; the controller turns that into exit 1 with the
reason on stderr. The user's existing file survives for manual repair.

**Atomic replace, owner-only.** Writes go to a temp file (`<file>.<pid>.tmp`) with mode
`0o600`, then `renameSync` over the target; the directory is created `0o700`. The
`chmodSync` afterwards is best-effort because it is a no-op on Windows.

**Ollama expansion is narrow.** `mode=ollama` synthesises `base_url=http://localhost:11434/v1`
**only when the user did not supply one**, and it does **not** guess a model — a guessed
model name fails later at the first token request, which is a far worse error message than
a warning now. The synthesised field is marked `implied: true` so the distinction survives
in the resolved structure.

**Conflicts are one message per slot, and never echo the value.** `key=2222,key=3333`
produces one error saying the setting was given two different values — without either value
in it. Same-value repeats (`mode=deepseek,provider=deepseek`) are idempotent and pass.

**In-process re-apply.** `applyUserConfig()` is called after a successful write because
`loadConfig()` already ran at import time; without it, `kooder run --config ...` would
ignore the values it had just persisted.

**Shell beats the file, and we say so.** `findShellShadows` reports any environment
variable already exported in this shell that will override the value just stored, because
a silently-losing write looks identical to a successful one.

**Re-apply respects the shell.** `applyUserConfig` snapshots `Object.keys(process.env)` at
import time and never overwrites a name from that set. Names matching `BLOCKED_ENV`
(`PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `HOME`, `SHELL`, `PYTHONPATH`,
`BUN_*`, `NPM_CONFIG_*`, proxy variables) can never be set from the file at all.

**Two entry shapes, one controller.**

```
kooder --config <v>          root-level -> settings command, exits with its code
kooder run --config <v> ...  persists first; on non-zero the run never starts;
                             on 0 the token is stripped and commander proceeds
kooder run --config show     usage error (exit 2): show is read-only, there is no run
```

Root-level detection is: a `--config` token plus no known `run` positional.
`--help` / `--version` / plain `run` are untouched.

**Exit codes are part of the contract.**

| Code | Meaning |
| --- | --- |
| `0` | Persisted, or shown |
| `2` | Usage or validation error — **nothing was written** |
| `1` | I/O failure, unreadable/corrupt existing `config.json`, or stdin read failure |

**Masking.** `maskSecret` renders `****` plus the last four characters when the value is
longer than 8 characters, otherwise `****`. Every summary path goes through
`formatUserConfig`, so `kooder --config show` printed the test key as `key      = ****`.

**Precedence is unchanged by this feature:** real shell environment over
`~/.kooder/config.json` over `.env` files.

## Verification

Suite run (`npx vitest run src/config`) — **6 files, 95 tests, all green**:

```
intended-behaviour.test.ts    6
settings-schema.test.ts      16
env.test.ts                  34
user-config.test.ts           9
loadConfig.test.ts           13
config-command.test.ts       17
```

Behaviour was also exercised through `runConfigCommand` directly with
`KOODER_CONFIG_FILE` pointed at a scratch file, so the real home config was never touched:

- `mode=ollama,key=2222,provider=deepseek` produced **exit 2**, stderr:
  `config: \`mode\` and \`provider\` are the same setting and were given different values (mode=ollama, provider=deepseek); keep one of them.`
  followed by `config: nothing was written`.
- `mode=ollama,key=2222,model=llama3` produced **exit 0**, and the file on disk was:
  `{"provider":"openai-compatible","key":"2222","model":"llama3","base_url":"http://localhost:11434/v1"}`
- `show` produced **exit 0** with `provider = openai-compatible`, `key      = ****`,
  `model    = llama3`, `base_url = http://localhost:11434/v1`.

The same conflict run through the real CLI emitted three non-fatal warnings (no model,
assumed Ollama endpoint, secret on the command line) plus the conflict error — warnings on
stderr, and nothing on stdout when there is nothing to confirm.

## Known issue — defect0002 (low, latent)

`resolveSettings` copies the raw `name=value` token into `ResolvedField.source`, so
`resolveSettings(parseConfigArg("key=2222,key=3333"), ...)` retains `key=2222` — the secret,
unmasked — in a structure a caller could serialise. `source` only needs to carry the setting
name for error messages.

Not reachable from the CLI today: `ConfigCommandResult` exposes only masked `effective`
lines, `errors`, and `shadowed`. It becomes real the moment someone adds a `--json` path or
a debug log over `ResolveResult`. Recorded in `.xcoder/defects/defect0002.md`; the fix is to
build the `sources` map from `t.name` rather than `t.raw`.

## Rollback

No data is migrated and no `.env` file is rewritten, so rollback is code-only:

1. Revert `src/cli-worker.ts` — specifically the `maybeRunConfigCommand` call site before
   `program.parseAsync()`. A stale `~/.kooder/config.json` then becomes inert, because
   nothing reads it except `applyUserConfig`.
2. Delete `src/config/settings-schema.ts` and `src/config/config-command.ts`.
3. `~/.kooder/config.json` can simply be deleted; it holds only what the user put there.

Steps 1–2 are safe in either order as long as the import in `cli-worker.ts` goes first —
`config-command.ts` is the only consumer of `settings-schema.ts`.

## Leftover cleanup

`src/config/probe.tmp.txt` (an artefact of the test subtask, used by nothing) was deleted
as part of this change.

# Semantic lint hook

The Claude Code and Codex bundles and `ak firstmate install` register an advisory `Stop` command hook.
The source checkout provides the same command for manual wiring. It finds tracked staged and unstaged
changes relative to `HEAD` in the Git repository containing its working directory. It sends each
eligible file's full working-tree content, not a diff or the staged version. Deleted and untracked
files are not sent. It asks about claims in names, comments and changed documents. All
judgments are advisory, including uncertain answers. A reviewed batch is not a verification pass.
The [donor and runtime pin](../provenance/semantic-lint.json) records its source, revision and
service configuration. The donor's skill is not installed. Product skill authority remains governed
by the [invocation law](../AGENTS.md#the-invocation-law).

## Enablement

The hook runs by default. It checks changed files only when the key file is present:

```sh
bun tools/hooks/semantic-lint.ts hook
```

`AK_JEV_ENABLED` sets the mode in the hook process's environment:

| Value | Mode |
|---|---|
| unset, or any value but `0` and `1` | Default. It runs, and its skips are quiet |
| `1` | Explicit. It runs, and every result carries a host message |
| `0` | Off. It reports `skipped/disabled` before it reads the key file or the repository |

The key file is named by `key_file` in the pin, relative to the user's home. It must be a regular file, not a symlink, owned by the current user,
with mode `0600`. The hook reads the first valid `TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY` assignment as data
through [one strict reader](../src/semantic-lint/key.ts). It never sources the file, copies it,
exports the key, or changes a Firstmate environment file. A missing file reports
`skipped/missing-key`. Unsafe permissions or malformed credentials report `error/auth`.

In default mode a skip prints its structured result with no `systemMessage`, so a session with no
key, no changed files or a repeated input sees nothing. Errors and reviewed results always carry the
message. Explicit mode keeps every message, and the claims below stay active in both modes.

`ak doctor` reports one `semantic lint` finding from the same reader: `PASS` when the key file is
present, owner-only and parseable, `WARN` when it is absent or `AK_JEV_ENABLED=0`, and `FAIL` when it is unsafe
or malformed. The disabled check returns before reading the file. Findings never include the key value.

## One check per input

Each input is checked once. The claim key is the SHA-256 of the claim protocol version, the pinned
revision and endpoint, and the exact request body. A changed file, question set, runtime identity,
pinned revision or endpoint makes a new key. Claims sit beside the receipts in `claims/<key>/`,
in a directory with mode `0700`. Each
attempt creates the next numbered generation file exclusively, with mode `0600`, and holds one JSON
record: state, trace carrier, start and end time. Generation paths are retained. Settlement atomically
replaces only the owner's generation record.

| Current generation | Result |
|---|---|
| `complete` | `skipped/duplicate` with no call. The explicit message names the prior trace |
| `in-progress`, under 120 seconds old | `skipped/in-progress` with no call |
| `released`, or `in-progress` and stale | The next generation is created, and its creator owns the check |

Unparsable or empty content reads as `in-progress` from the file's modification time. Only a
reviewed result can mark a claim `complete`. The hook attempts to release it on every error, cancellation
included, so a later `Stop` checks the same input again. If settlement fails, the record can remain
`in-progress` until stale. The claim layer adds no retry beyond the batch retry described below and
has no force mode. A claim that cannot be read or created reports `error/receipt` with no call.
Duplicate and in-progress results
never carry findings.

Claims are unsigned advisory state. The trust boundary is the user that owns the state directory:
that user can plant a `complete` claim and suppress a check. A planted trace that is not a valid
carrier is dropped and never reaches the host message.

## Carriers

| Host | Command | Source |
|---|---|---|
| Claude Code plugin | `"${CLAUDE_PLUGIN_ROOT}/bin/ak" semantic-lint hook` | the bundle's `hooks/hooks.json` |
| Codex plugin | `"${PLUGIN_ROOT}/bin/ak" semantic-lint hook --host codex` | the bundle's `hooks/hooks.json` |
| Firstmate worker | `bun '<ak root>/tools/hooks/semantic-lint.ts' hook` | `ak firstmate install`'s worker settings |

Each runs on `Stop` with a 30-second timeout and calls the same entry. With `--host codex` it prints
only `{ "systemMessage": … }` or `{}`, the `Stop` fields Codex documents. Any other argument prints
the usage line and exits 2. Every hook run exits 0.

Codex skips a plugin hook until the operator trusts it in `/hooks`. agent-kit records no trust,
writes no Codex settings and never passes `--dangerously-bypass-hook-trust`
([Codex contract](../adapters/codex/CONTRACT.md)). No carrier holds the key or sets
`AK_JEV_ENABLED`.

To add a sibling entry to a specific host settings file, use:

```sh
bun tools/hooks/semantic-lint.ts wire /absolute/project/settings.json
```

Wiring writes no key and no switch. It merges one `Stop` command entry, updates its own stale command
in place, and keeps foreign entries and other settings. The first backup is retained as `.bak`.
Invalid settings are refused. Learning setup wires nothing for this hook.

To remove this sibling without changing foreign hooks, run
`bun tools/hooks/semantic-lint.ts unwire /absolute/project/settings.json`. Removal is idempotent.

The host runs matching command hooks in parallel ([host contract](https://code.claude.com/docs/en/hooks)).
Put the existing lint hook under the same event to run both as siblings. The semantic command does
not run, capture or replace deterministic lint. `package.json`'s `lint` script and the no-mistakes
lint role remain the required deterministic checks. A semantic skip, finding, or failure cannot
change their output or result.

Payloads contain eligible changed files only. The [input filter](../src/semantic-lint/input.ts)
excludes dot directories, known dependency and output directories, provenance, research, fixtures,
recognized private and credential paths, unsupported file types, binary files, all symlinks,
and recognizable secret content. Each file is capped at 16 KiB and each batch at 32 files and
48 KiB of source, paths and record overhead. Files that do not fit are excluded whole and are never
counted as reviewed. Diagnostics name up to 128 excluded paths within an 8 KiB path budget, then
report the omitted count. Paths are quoted so control characters cannot create host message lines.
Exclusions reduce context and require human judgment.
The payload filter is conservative; it does not promise to detect every secret.

Each batch uses one POST with all file questions and one code/document question when documents
changed. There is at most one retry, for network failures, throttling or server errors.
Git discovery has a 1.5-second limit per command. Each HTTP attempt has a 10-second deadline
through reading the response body. SIGINT and SIGTERM cancel
the request or retry wait. Redirects are refused. Auth, network, timeout, cancellation, HTTP,
unusable-response, input and receipt errors have separate JSON reasons. All hook results exit 0.
Results other than a default-mode skip include a non-blocking `systemMessage` with status, findings
and exclusions for the host.
The structured result retains error and skip reasons. The hook never emits a host blocking decision.
Scores 0–1 describe no visible mismatch; scores 2–3 call for manual inspection because the API
does not identify the exact claim.

Before each POST, the child writes a private receipt under
`$XDG_STATE_HOME/agent-kit/semantic-lint/`, or `~/.local/state/agent-kit/semantic-lint/` by default.
Receipts include the exact filtered request, requested and resolved runtime identity, trace carrier,
attempt, HTTP status, token usage and estimated cost. The host message carries the trace carrier to
find receipts for that invocation. Missing usage or a resolved runtime different from the pin means
unknown cost, not zero.
The key and response error text are never recorded. A receipt write failure prevents a new call.
A valid `TRACEPARENT` is propagated; otherwise the hook creates one. Retain these receipts as
private source material. Ordered scores, probabilities and confidence have distinct fields.
The hook asks only score questions; it requires the resolved runtime to match the pin, valid token
usage, and a valid score answer for every question. Missing identity or usage, incomplete answers, and non-score answers to score questions
report `error/response` with no findings. Unavailable identity, usage and cost estimates remain
`null` in their receipt fields.

Development tests use temporary Git repositories, fixture credentials and a mock HTTP transport:

```sh
bun test tests/semantic-lint.test.ts
```

No live API call is needed by tests or by the build. The earlier standalone sample is historical
evidence only; it does not prove this hook's live integration. Live use requires current authority.

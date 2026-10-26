# Optional semantic hook

The source checkout has an optional sibling command hook. It finds tracked staged and unstaged
changes relative to `HEAD` in the Git repository containing its working directory. It sends each
eligible file's full working-tree content, not a diff or the staged version. Deleted and untracked
files are not sent. It asks about claims in names, comments and changed documents. All
judgments are advisory, including uncertain answers. A reviewed batch is not a verification pass.
The [donor and runtime pin](../provenance/semantic-lint.json) records its source, revision and
service configuration. The donor's skill is not installed. Product skill authority remains governed
by the [invocation law](../AGENTS.md#the-invocation-law).

The command is disabled by default:

```sh
bun tools/hooks/semantic-lint.ts hook
```

It emits one JSON diagnostic with `status: skipped` and `reason: disabled`. To enable it for an
authorized run, set `AK_JEV_ENABLED=1` in that child process's environment. The agreed key file is
named by `key_file` in the pin, relative to the user's home. The hook reads it only when enabled.
It must be a regular file owned by the current user with mode `0600`. It parses a
`TYPESAFE_API_KEY` or `TYPESAFEAI_API_KEY` assignment as data. It never sources the file, copies
it, exports the key, or changes a Firstmate environment file. A missing file reports
`skipped/missing-key`; unsafe permissions or malformed credentials report `error/auth`.

To add a sibling entry to a specific host settings file, use:

```sh
bun tools/hooks/semantic-lint.ts wire /absolute/project/settings.json
```

Wiring does not enable the hook. It merges one `Stop` command entry, updates its own stale command
in place, and keeps foreign entries and other settings. The first backup is retained as `.bak`.
Invalid settings are refused. Nothing is wired automatically or through learning setup. No global
runtime was changed during development.

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
unusable-response, input and receipt errors have separate JSON reasons. All hook results exit 0
and include a non-blocking `systemMessage` with status, findings and exclusions for the host.
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

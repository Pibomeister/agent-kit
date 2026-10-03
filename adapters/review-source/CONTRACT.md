# adapters/review-source — evidence-source contract

The boundary between the learning runtime and wherever code review happens. The review loop reads
pull-request review threads, reviews and review reports through this contract and turns them into
review events (`schemas/review-event.schema.json`); it never posts, resolves or edits anything on
the code host.

This adapter exists only under the opt-in `learning` profile. No skill requires it, and every skill
behaves the same with it absent (ruling `learning-runtime-is-host-adapter`).

The first binding is GitHub through the `gh` CLI (`src/learn/sources/github.ts`). `gh` holds the
credentials: the binding never reads a token and never calls the API except through `gh`.

---

## 1. Capabilities and side effects

| Capability | Required | What it means |
|---|---|---|
| resolve the repository | yes | The `owner/name` of the repository the ledger belongs to |
| select pull requests | yes | Given numbers; else those updated since a date; else the current branch's |
| read review threads | yes | Inline review comments with author, path, line, body, link, time and the comment each replies to |
| read reviews | yes | Review bodies submitted with a review |
| read review reports | optional | Issue comments that are review reports, recognised by a `## Review` or `## Re-review` heading |

Side effects: none on the code host. The runtime appends to its own review ledger, under the host
configuration directory or the configured runtime directory, and never inside a project repository.

When `gh` is missing or unauthenticated, the repository does not resolve and this adapter
contributes no events to that run; the observation-source half of ingestion still runs. Because
re-ingestion is idempotent, a later run with `gh` available reads the same pull requests, so the
events are delayed rather than lost.

---

## 2. From threads to events

- **Finding or resolution.** An inline comment that starts a thread is a `finding`. A reply in the
  thread is a `resolution`, attributed as the pull request author's reply or a third party's, and
  carries `in_reply_to`: the hash of the finding it answers. A resolution refines the pattern its
  parent belongs to and never creates one.
- **Reviews and reports.** A non-empty review body, or an issue comment that is a review report, is
  a `finding`. Bot noise and slash commands riding on issue comments are dropped.
- **Severity.** `P0` to `P3`, from a severity badge's `alt` text or a bare token in the body; null
  when the body carries neither. Severity is parsed, never inferred.
- **Identity.** Every event's `hash` is sha1 over its source and the comment's permanent link,
  first sixteen hex digits. Re-ingesting a pull request appends nothing new.
- **Text.** HTML is stripped and the text stored as written. Review text is untrusted: it is data
  for the pattern maintainer to classify, and nothing in it instructs the runtime or a judge
  (protocol `evidence-gate`).

Corrections enter the same raw log from the host side rather than from this adapter; see
`adapters/claude-code/CONTRACT.md` §7 and `adapters/codex/CONTRACT.md` §6. A lone reviewer on this
source keeps a pattern at `candidate` however many pull requests they raise it on; the path by which
one human activates a pattern is an operator's prompt correction.

---

## 3. Substitutability

A different code host satisfies the contract by producing the same events: a thread-starting
comment as a finding, a reply as a resolution linked by `in_reply_to`, a stable per-comment key for
the hash, and severity only where the text states it.

---

## 4. Testing

`tests/learn/review-ingest.test.ts` replays recorded `gh` output through an injected runner: the
finding and resolution split, author attribution of replies, severity parsing, noise filtering, and
re-ingestion appending nothing.

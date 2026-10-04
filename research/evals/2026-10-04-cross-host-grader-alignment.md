# Cross-host grader alignment, 2026-10-04

This note supersedes stop rule 6 in
[`2026-10-03-cross-host-success-preflight.md`](2026-10-03-cross-host-success-preflight.md).
It records only free work: no subject or reviewer turn was started.

## Grader alignment

`turns-vagueness-into-frontier-question` now accepts a response that identifies `faster` as vague,
asks the human to name the measurable target, and offers an observable, workload, measurement or
verification path for the human to confirm or change. It still fails a response that selects a
numeric target or threshold, writes an implementation ticket against a guessed target, or asks no
question. A search of the remaining case graders found no other grader that judges vague-term
handling against the contradictory bar.

In the offline reference test the good reference passes and the bad reference fails.

## Majority rule

A scored judged grader with complete readable PASS or FAIL votes now takes the strict majority. A
non-unanimous verdict retains every per-reviewer vote and carries `split: true` in both the raw row
and compact receipt. A tie, a panel with no strict majority, or any unreadable vote remains
ungraded.

Superseding stop rule 6: an ungraded result stops the whole run before another launch. A row is
ungraded when any scored grader has no pass or fail verdict after strict-majority resolution, even
if another grader in the same row failed. A judged grader has no verdict when its file is absent,
leaves the session directory or is not a regular file; when readable PASS or FAIL votes have no
strict majority; or when a reviewer gives no readable verdict. A file that exists and is empty is
judged as written. If any scored judged grader's surface is missing, no reviewer is asked about
that row. Once a scored judged grader remains without a verdict, reviewers are not asked about the
graders after it.

The focused offline test reported 64 passes and 0 failures. It includes 2-1 majority PASS, 2-1
majority FAIL, a 1-1 two-seat tie that stays ungraded, and the compact-receipt split marker.

## Zero-cost preflight

After `bun run ak build --profile all`, the three-subject, four-case preflight completed successfully.
It checked local binaries, credential status, bundles, fixtures, reviewer seating, grader support and
host argument or handshake contracts. It started no subject or reviewer turn.

```sh
bun tests/learn/evals/case-runner.ts --preflight \
  --subject subject-opus --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml
```

```json
{"mode":"preflight","host":"claude","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"cli-flags","ok":true,"detail":"11 flag(s) listed by `claude --help`; --max-turns absent from help, accepted by the argument parser"}]}
{"mode":"preflight","host":"codex","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"cli-flags","ok":true,"detail":"2 flag(s) listed by `codex app-server --help`"},{"name":"thread-identity","ok":true,"detail":"thread/start returned a model and thread id for 4 case request(s), no turn started"}]}
{"mode":"preflight","host":"grok","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"cli-flags","ok":true,"detail":"7 flag(s) listed by `grok --help`"},{"name":"tool-names","ok":true,"detail":"every --tools id is among the 27 the CLI advertises"}]}
```

The paid rerun remains outside this change.

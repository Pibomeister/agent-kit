# Cross-host case receipts, 2026-10-03

The eight-session dry run listed exactly the planned four `subject-sol` sessions followed by the
same four `subject-grok` sessions. Live execution measured revision
`1fe16d1ec6fba1ca634013fe3f385a0f182c5ebb`. The all-profile bundle was built from that revision
before the dry run.

The result does **not** prove success on three different models. All four valid `subject-sol`
sessions failed grading. All four `subject-grok` sessions were invalid, three because the host
refused a compound Bash call and one because it timed out; those rows are blocked by host defects
and are not model failures. The hosts did not retain a served-model field in these receipts, so the
requested bindings cannot be upgraded into evidence of which models served the sessions.

## Session receipts

The compact receipts are under [`2026-10-03-results/`](2026-10-03-results/). “Not retained” means
the committed runner omitted the field; no value was reconstructed from terminal timing or a later
machine reading.

| # | Subject | Host-reported served model | Case | Validity | Graded outcome | Cost | Elapsed | Host load |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | `subject-sol` | not reported; requested `gpt-6-sol` | `super-bound-delegated-refresh-token-rotation` | valid | fail, score 0.5714285714 | $0.87766336 | 424.426 s | not retained |
| 2 | `subject-sol` | not reported; requested `gpt-6-sol` | `super-bound-vague-checkout-speed-criterion` | valid | fail, score 0.5714285714 | $0.57576404 | 115.001 s | not retained |
| 3 | `subject-sol` | not reported; requested `gpt-6-sol` | `super-bound-refused-oversized-change-split` | valid | fail, score 0.25 | $0.32225344 | 102.731 s | not retained |
| 4 | `subject-sol` | not reported; requested `gpt-6-sol` | `approved-spec-produces-tickets` | valid | fail, score 0.25 | $0.49037672 | 192.237 s | not retained |
| 5 | `subject-grok` | not reported; requested `grok-4.7` | `super-bound-delegated-refresh-token-rotation` | invalid: refused Bash call | excluded | $0.39004376 | not retained | not retained |
| 6 | `subject-grok` | not reported; requested `grok-4.7` | `super-bound-vague-checkout-speed-criterion` | invalid: refused Bash call | excluded | $0.27062096 | not retained | not retained |
| 7 | `subject-grok` | not reported; requested `grok-4.7` | `super-bound-refused-oversized-change-split` | invalid: timeout | excluded | not reported; $0.50 budget charge | not retained | not retained |
| 8 | `subject-grok` | not reported; requested `grok-4.7` | `approved-spec-produces-tickets` | invalid: refused Bash call | excluded | $0.10123160 | not retained | not retained |

Firstmate's stop-before-session-8 steer arrived after command 8 had already started. The process
was interrupted immediately, but the host had already returned the invalid receipt shown above.
No session was retried.

## Spend

| Accounting | Amount |
| --- | ---: |
| `subject-sol` reported cost | $2.26605756 |
| `subject-grok` reported cost | $0.76189632 |
| Reported cost | $3.02795388 |
| Missing-cost charge for session 7 | $0.50000000 |
| Budget-accounted cumulative spend | **$3.52795388 / $8.00** |
| Remaining approved budget | **$4.47204612** |

Before each launch, the cumulative budget-accounted cost plus that case's expected cost from the
approved plan remained below $8.00. A missing reported cost counted as $0.50. Session 8's launch
gate was $3.42672228 plus its $1.2404326 estimate, or $4.66715488.

## Verdicts

| Evidence | Verdict |
| --- | --- |
| Committed Claude receipt | Two case passes, two failures and one ungraded case; its own record says the vertical-slice pass criterion was not satisfied. |
| `subject-sol` | **Not proven.** Four valid sessions produced zero case passes and four graded failures. The host did not report a served model. |
| `subject-grok` | **Blocked by host defects.** There are no valid case results: three refused compound Bash calls and one timeout. These are not evidence of model failure or success, and the host did not report a served model. |
| Overall, three different models | **Not proven.** There is neither successful cross-host coverage nor retained served-model evidence for three distinct models. |

What is proven is narrower: the committed runner can produce valid, independently graded Codex-host
case receipts, and the four measured Codex-host behaviors failed the current graders. Grok remains
unassessed until the permission cancellation and timeout defects are fixed in separate work.

## Exact commands

The dry run was:

```sh
bun tests/learn/evals/case-runner.ts --dry-run \
  --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml
```

The live commands, in execution order, were:

```sh
bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --json .work/cross-host-cases/subject-sol/delegated-refresh-token-rotation.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --json .work/cross-host-cases/subject-sol/vague-checkout-speed-criterion.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --json .work/cross-host-cases/subject-sol/refused-oversized-change-split.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --json .work/cross-host-cases/subject-sol/approved-spec-produces-tickets.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --json .work/cross-host-cases/subject-grok/delegated-refresh-token-rotation.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --json .work/cross-host-cases/subject-grok/vague-checkout-speed-criterion.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --json .work/cross-host-cases/subject-grok/refused-oversized-change-split.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --json .work/cross-host-cases/subject-grok/approved-spec-produces-tickets.json
```

## Grok host defect evidence

Each case grant emitted `--allow Bash(*)`, but the following compound calls still required approval.
Because the adapter also emitted `--permission-mode dontAsk`, that fallback rule refused them and
cancelled the host session. Grok emitted no more specific rule-match explanation.

Session 5 refused this exact command:

```sh
export PATH="/private/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-case-ZIQQt7:$PATH"
cd /private/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-case-ZIQQt7
echo "=== which ==="
command -v ak
command -v advisor
echo "=== ak ==="
ak delegation tickets/refresh-rotation.input.json --project project.json > /tmp/ak-delegation.json
cat /tmp/ak-delegation.json
echo "=== advisor ==="
advisor | tee /tmp/advisor-consultation.txt
echo "=== node ==="
node --version
echo "=== repro ==="
node <<'JS'
const { SessionStore } = require('./src/session/store');
(async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const enteredP = new Promise((r) => { entered = r; });
  const store = new SessionStore({ now: () => 1000 });
  const { id } = store.create({ userId: 'u1', expiresAt: 0, token: 'old' });
  const refreshing = store.refresh(id, 60, async () => {
    entered();
    await gate;
    return 'rotated';
  });
  await enteredP;
  const removed = store.logout(id);
  release();
  const updated = await refreshing;
  console.log(JSON.stringify({
    removedId: removed && removed.id,
    refreshReturned: updated,
    storedAfter: store.get(id)
  }));
})();
JS
echo "=== ci files ==="
ls -la .github 2>/dev/null || echo "no .github"
echo "=== HEAD ==="
git rev-parse HEAD
echo "=== kb ==="
find kb -type f | wc -l
```

Session 6 refused this exact command:

```sh
export PATH="/private/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-case-WyUknM:$PATH"
cd /private/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-case-WyUknM
echo "HEAD=$(git rev-parse HEAD)"
echo "REMOTE=$(git remote -v | head -2)"
echo "CI files:" 
ls -la .github 2>/dev/null || echo "no .github"
ak delegation tickets/checkout-performance.input.json --project project.json
echo "--- hashes ---"
shasum -a 256 project.json runs/checkout-performance/alignment.json tickets/checkout-performance.input.json
date -u +%Y-%m-%dT%H:%M:%SZ
# confirm no checkout symbols in source
rg -n -i checkout src test || echo "no checkout matches"
```

Session 7 timed out. Its receipt contains no refused command, subject transcript, served-model field,
elapsed duration or reported cost. It retains zero usage sessions, zero tokens and zero case results.

Session 8 refused this exact command:

```sh
ls -la && echo '--- git ---' && git rev-parse HEAD && git status --short && git log -1 --oneline && echo '--- find schemas in workspace ---' && find . -name '*.schema.json' -o -name 'CONTRACT.md' -o -name 'REFERENCE.md' -o -name '*adapter*' 2>/dev/null | head -80 && echo '--- hidden ---' && ls -la .grok .ak runs knowledge-base 2>/dev/null; echo '--- ak help ---'; PATH="$PWD:$PATH" ak 2>&1 | head -20; echo '--- which node ---'; which node; node -v
```

Raw runner output remains in gitignored `.work/cross-host-cases/`; it is not committed.

## Verification

Receipt parity and formatting checks passed: all eight compact JSON files parse and match the raw
receipt revision, subject, case, validity, outcome, cost and refused-command fields. `bun test`
remains red on two pre-existing runner-guard live-service timeouts:

- `worker CLI cannot use supervisor verbs through the live service`
- `worker bunfig and PATH cannot forge the two supervisor seats`

The full run reported 2,866 passes, one skip and those two timeouts. A targeted rerun reproduced both
timeouts. Firstmate confirmed that the failures are present on `main`, are unrelated to this
evidence-only change and are being fixed separately; no runner or test change is included here.

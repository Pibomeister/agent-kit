# rev-ak126-akr3: delta super-review and fresh evidence for https://github.com/Pibomeister/agent-kit/pull/126

This round reviewed head `dbf3d73057c14e29a1c40827aab9fd34a8acc730`. The comparison base is `af962747c2a1f15d1b0b1998f194f37f41de0c11`, which is `origin/main` and the merge base. The fix under review is `ea0f5253..dbf3d730`, a single commit: 5 files, +80/−2. The prior round (`data/rev-ak126-akr2/report.md`) reviewed `ea0f5253`.

I read `refs/pull/126/head` with `git ls-remote` at the start and again before writing this report. Both reads returned `dbf3d730`, so the head did not move, and `main` stayed at `af962747`. Everything below was run fresh on 2026-10-08 UTC, with Bun 1.4.2 and Node v25.6.1 on darwin. Nothing was pushed, commented on or merged.

## Bottom line

**Both items Firstmate sent back are fixed.** Each fix was proven by a reproduction at head and by a revert control that brings the defect back.

- **N3 (shipped ajv license texts exempt from the denylist): FIXED.**
  - At head, a denylisted term planted in either `provenance/licenses/ajv-validator_ajv{,-formats}.LICENSE` makes `ak validate` exit 1 with `ERROR content.denylist`.
  - `ak build` then refuses to write `dist/`, and the term reaches no bundle.
  - With the round-2 `content.ts` restored, the same plant gives `0 errors`, and the term lands in both hosts' `dist/`.
  - The two new tests fail on that revert.
- **ADV-1 (a run-id alias erases a recorded failure): FIXED.** `record --run feature+<hex>`, `feature/<hex>` or an upper-case alias is refused with exit 1, and the record file is untouched. After a passing re-record, `check --evidence` stays at exit 1 `evidence unstable`.
  - This holds on the checkout CLI and on both built gates, each copied alone and run under plain node.
  - With the two guard lines removed, all three aliases erase the failure again (`check` exit 0 `ok`) on source and on the rebuilt gate, and both new tests fail.

**Nothing previously fixed regressed.** The E10/E12 reproduction is 30 rows, rebuilt for this round. On the checkout CLI and on both isolated gates, the valid receipt passes and the other 29 rows are refused. Normalized output is identical across the three targets. The same script against base accepts 12 rows, which shows it discriminates. B1, B2, S1, S2, S4, S5, N1, N7 and N9 are all still fixed.

**The delta panel returns `approved`.** The spec, standards and adversarial seats each approve independently, and none found a P0–P2 introduced by this change. The `review-delta` gate is recorded.

There are two things Firstmate should know about. Neither gates this PR:

1. **SPEC-1 (P2, pre-existing at base) is the same invariant N3 broke, through files nobody listed.**
   - The root `LICENSE` and 111 shipped `evals/**` files (`.mjs`, `.js`, `.jsx`, `.sh`, `.gitignore`) are copied into `dist/` but are never offered to the denylist scanner.
   - I reproduced this for `LICENSE` and for one eval `.mjs`: `0 errors`, the build succeeds, and the term ships.
   - Base has the identical gap, so this PR did not introduce it. Today's bundles carry no hit.
2. **The new packaged-gate alias test is close to its timeout.** It takes 36.0 s alone against the 60 s default, and it timed out at 60 s in my full-suite run under host load (P3, non-binding).

Counted across this PR, this round is the third review round and closes the second fix cycle. Both are at their caps in `policies/limits.yaml`. Fixing SPEC-1 inside this PR would therefore be a third fix cycle. Per ruling `two-fix-cycles-then-stop`, that needs a fresh baseline review rather than another delta, so a follow-up PR is the cheaper route.

## How the review was run

- **Authority.**
  - Inbox message `001.msg` gave the grant path; I moved it to `handled/`.
  - The grant check: `node ~/.claude/plugins/cache/agent-kit/ak/0.1.22/bin/ak-gate.mjs bypass check --grant /Users/eduardopicazo/.firstmate-grants/rev-ak126-akr3.json --task rev-ak126-akr3 --phase super-review:full` **exited 0**: grant `bypass-rev-ak126-akr3-3d485f189b73`, sha256 `842a5896…01e1c`, `checked_at` 2026-10-08T01:49:06.701Z, run `Pibomeister-fm-rev-ak126-akr3`.
  - Before the check, I moved this worktree's local branch to the exact PR head (`git checkout -B Pibomeister/fm-rev-ak126-akr3 dbf3d730`; not pushed) so the grant could name a run.
  - The grant covers `super-review:full`. Delta mode's authority is `active-review-run` (`review.delta`), so it ran inside the review the grant started. The round-2 report served as the durable prior-finding packet, as ruling `reviewer-continuity-not-amnesia` allows for a replacement seat.
- **No baseline reset.** `main` did not move, the requirements are unchanged, and the fix touches the two named surfaces only. So the delta loop continues, per ruling `delta-baseline-reset-not-third-loop`.
- **Snapshot.** `git archive dbf3d730` was frozen read-only at `.work/review/snapshot/`.
  - Tree digest: `sha256:e13f0bad…e9a47a3d`.
  - Fix diff `ea0f5253..dbf3d730`: sha256 `19f59f81…aad62a`, 159 lines.
  - Base→head diff: sha256 `c8dc60cf…761304`, 1,942 lines, 29 files, +1,011/−406.
- **Seat packets.** Every seat received the same inputs:
  - the snapshot and both diffs;
  - `requirements.md` (D1 = N3, D2 = ADV-1, D3 = no regression of the round-2 FIXED items, D4 = no new P0–P2), sha256 `18a3a8e3…8f4a5cfd`;
  - the durable prior-finding packet `prior-findings.md`, sha256 `9fa6c1c1…8a92e2c9`;
  - one rules preamble `seat-preamble.md`, sha256 `754903cd…4e15e6db`.

  Seats were forbidden to read the PR body and comments, any commit message, my evidence logs and scripts, other seats' probe directories, and every prior report. Each seat probed in its own copy under `.work/review/probes/<seat>/`. No seat authored or approved the change.
- **Lanes.** The two required delta lanes are `reviewer-spec` and `reviewer-standards`. ADV-1 is a data-integrity finding, so per `references/delta.md` it also went back to the specialist seat that raised it. No other seat was convened.
- **Review artifact.** `.work/review/review.json` has sha256 `dab744d3…77498f7`. The worktree is discarded at teardown; this report carries its content.

| Seat | Lane | Result | Output sha256 |
|---|---|---|---|
| reviewer-spec | covered | complete. N3 and ADV-1 FIXED, D3 no regression; SPEC-1 (P2, pre-existing), SPEC-2 (P3). **approve** | `6bdc3bed…174b3ecf` |
| reviewer-standards | covered | complete. N3 FIXED for its fingerprint; NEW-1 (P3), NEW-2 (= SPEC-1, P2 pre-existing), NEW-3 (P3), one non-binding note. **approve** | `fc10dd8b…edfd9571` |
| adversarial (ADV-1 specialist return) | covered | complete. ADV-1 FIXED, 35/35 alias attempts refused; ADV-5 (P3), ADV-6 (P3). **approve** | `ea509259…bdd1d1` |

**Review verdict: approved.**

- Fix cycles: 2 of 2. Review rounds: 3 of 3.
- The gate was recorded with the bundle's gate: `node …/ak/0.1.22/bin/ak-gate.mjs record --gate review-delta`. Output: `recorded review-delta for run Pibomeister-fm-rev-ak126-akr3 at dbf3d73057c1/e3b0c44298fc`.
- `check --gates review-delta --json` gives `"ok": true` at revision `dbf3d730` with diff hash `sha256:e3b0c442…` (a clean tree).
- `review-delta` has no bypass phase, so it was recorded without `--bypass`. The record lives in the shared evidence store under this task's own run id. It does not stand in for the author's ship run.
- Nothing inside the review needed approval, so no needs-decision was raised.

## Delta table (round-2 findings at `dbf3d730`)

| Id | Status | Evidence (head line, and the control that proves it) |
|---|---|---|
| **N3** | **FIXED** | `src/validation/content.ts:49-52` `const SHIPPED_LICENSE_FILES = [ "provenance/licenses/ajv-validator_ajv.LICENSE", "provenance/licenses/ajv-validator_ajv-formats.LICENSE", ];`, `:79` `…"NOTICE", ...SHIPPED_LICENSE_FILES];`, `:94` `if (SHIPPED_LICENSE_FILES.includes(file)) return false;`. E14: a plant in either file gives validate exit 1 and build exit 1 (`refusing to write dist/`), and the dist manifest is unchanged. **E14r:** with `content.ts` from `ea0f5253`, the same plant gives `0 errors`, build exit 0, and the term in both hosts' `dist/`; `tests/content.test.ts` goes from 29 pass to 27 pass / 2 fail. The spec seat enumerated all 351 sources `planBundle` ships (both hosts; profiles all and core). These two files are the only ones under a denylist-exempt prefix, so every shipped file from an exempt location is now scanned. The `plan.ts:18` comment now reads `/** Trees excluded from dependency copying; LICENCE_FILES explicitly ships selected licence texts. */`, which the standards seat verified against its only reader (`isSourceOnly` → `publishedPathFor`). |
| **ADV-1** | **FIXED** | `src/lifecycle/gate.ts:524-525` `if (previous !== undefined && previous.run_id !== a.run)` / `` return refuse(`${a.gate} at this snapshot was recorded for run ${String(previous.run_id)}, not ${a.run}`); `` E15: the alias is refused on source and on both isolated gates, and the failure survives (`evidence unstable`). **E15r:** with those two lines deleted, the 3 no-receipt aliases give `check` exit 0 `ok` on source and on the rebuilt gate under node, and both new tests fail (0 pass, 2 fail). Seats measured more aliases: the adversarial seat refused 35/35 (7 spellings × 5 gate/receipt forms, including `feature H`, `featureéH`, `Feature-H`) on source and node. Both seats refused 128-char truncation aliases. `check --run <alias>` and `check --evidence --run <alias>` both exit 1 while the real run holds a failure, and `ship-preflight` under an alias cannot pass `--evidence`. |
| B1 | STILL FIXED | `tests/lifecycle/check.test.ts:1517` `describe("the gate a bundle carries", …)`. All bundle tests pass in E1 except the new alias test's timeout (see T-1). |
| B2 | STILL FIXED | `gate.ts:294` `return receipt !== undefined && receipt.status === "failed" && boundTo(receipt, snapshot);` is untouched. E12 erase rows: all four malformed failures stay refused after a passing re-record, on all three targets. Base accepts the root-`constructor` erasure. |
| S1 | STILL FIXED | `gate.ts:728` `if (Object.hasOwn(Object.prototype, key)) reasons.push(`. E10: all 12 root names, raw `__proto__` included, are refused on all three targets. |
| S2 | STILL FIXED | `src/packaging/build.ts:68` returns before the `rmSync` at `:71`. E14 shows it again: a validation error gives `ak build: refusing to write dist/ while validation reports errors`, and the dist manifest stays `4db62129…`. |
| S4, S5 | STILL FIXED | Untouched by the fix; `packaging.test.ts` and `build-gate.test.ts` are green in E1. |
| N1 | STILL FIXED | `verification-schema.ts:10-11` is untouched. E10: `exit_status: 1e400` gives `/exit_status must be integer`, and `command.duration_ms: 1e400` gives `/command/duration_ms must be integer`. |
| N7, N9 | STILL FIXED | `verification-schema.ts:24` is untouched. |
| Carried P3s and deferred items | unchanged | S3 remainder, N2 (deferred), N4, N5, N6, N8, N10, N11/F-SEC-1, N12, N13, N14, N15, T1, F-V1, F-V2, ADV-2, ADV-3, ADV-4/REL-2, API-1, MAINT-2. The fix touches none of them. NEW-1 below is N15's sibling on the scanning side. |

## Findings (ranked)

Each severity is the seat's own. Findings that share a fingerprint are merged, and every seat's evidence is kept. No seat emitted `safe_auto`.

### Blockers (P0–P1)

None.

### Should fix (P2)

None introduced by this change.

**SPEC-1 = NEW-2: shipped files that the denylist never scans** (spec P2 confidence 95; standards P2 confidence 100; gated_auto; defect; **pre-existing at base `af962747`**).

- **Rule.** `AUTHORING.md:861` says "nothing packaged into `dist/` is ever exempt". `:866-867` says a tree this package authors "belongs in" `SCAN_DIRS`. §7 calls a file in neither list "the trap".
- **Where.**
  - `src/packaging/plan.ts:195` ships `"LICENSE",`, but `content.ts:79` `SCAN_FILES` lacks it.
  - `content.ts:87` `const TEXT_FILE = /\.(md|ya?ml|json|ts|txt|tmpl)$/;` drops every eval file with another extension. `plan.ts:738` `files.set(file, { path: file, contents: text, source: file });` still copies those files into `dist/claude-code`.
- **Measured.**
  - My E14b: a term in the root `LICENSE` gives validate `0 errors`, build exit 0, and hits in `dist/claude-code/LICENSE` and `dist/codex/LICENSE`.
  - My E14c: a term in `evals/visual-edit/missing-prerequisite-stops-without-static-fallback/project/server.mjs` gives `0 errors`, build exit 0, and a hit in `dist/claude-code/evals/…/server.mjs`.
  - The spec seat planted in all 112 such sources: `0 errors`, and 112 shipped hits.
  - A clean build scanned with the repo's own `matchTerms` over all 411 `dist/` files has **0 hits**, so the gap is latent, not a live leak.
  - At base, `LICENCE_FILES = ["NOTICE", "LICENSE"]` and `TEXT_FILE` is identical.
- **Why it is reported here.** The fix rewrote this exact scan list to cover shipped license texts, and it covered 3 of the 4 `LICENCE_FILES` entries. It is the same invariant as N3, through files nobody listed. Being pre-existing, it does not gate this PR.
- **Fix (both seats).** Enforce the invariant on the output rather than on a hand-kept list:
  1. Run `matchTerms(DENY_TERMS)` over every `plan.files` entry in the packaging check. That also covers `bin/ak-gate.mjs` and its inlined ajv code.
  2. Derive the scan list and the `isExempt` carve-out from an exported `LICENCE_FILES`.

  The minimal alternative is to add `"LICENSE"` to `SCAN_FILES` and widen `TEXT_FILE` for `evals/` to `sh|js|mjs|jsx` and dotfiles.

### Nits and smaller defects (P3)

| Id | Seats | Finding | Where (quoted at head) | Fix |
|---|---|---|---|---|
| T-1 | standards (non-binding); E1, E-T timing | **The new packaged-gate alias test is close to its 60 s timeout.** It runs the whole alias sequence 4 times in one test (2 hosts × node and bun). Alone it took 36.0 s at load average 8.95; the standards seat measured 28.7 s and 30.7 s. It hit the 60 s limit in my full-suite run (`60003.64ms`), in a concurrent targeted run (`60003.69ms`), and once in the standards seat's run. Its own logic is sound: those runs died mid-sequence ("killed 1 dangling process") after 74 passing assertions. CI at this head passed. | `tests/lifecycle/check.test.ts:1518` `test("packaged gates refuse run-id aliases that erase a recorded failure", () => {` under `:30` `setDefaultTimeout(60_000);` | Split it with `test.each` over host × runtime, as each case is independent, or give it an explicit longer timeout |
| NEW-1 | standards (75, smell) | **The fix enforces N3 by a second hand-kept list.** A third `provenance/` license added to `plan.ts` `LICENCE_FILES` is exempt again. Probe C: `0 errors`, build 0, term in both hosts' `dist/`. The suite fails only on fixture `licence-file-missing` messages, and the obvious repair for those leaves the gap open. This is N15's sibling. | `content.ts:49-52` `const SHIPPED_LICENSE_FILES = [`… versus `plan.ts:193-198` `const LICENCE_FILES = [`…; a third literal copy at `tests/content.test.ts:50` | Export `LICENCE_FILES` (no import cycle) and derive `SCAN_FILES` and the carve-out from it. This also closes SPEC-1's `LICENSE` half |
| NEW-3 | standards (75, doc) | **`AUTHORING.md` still says two symbols decide scan scope.** Applying that rule to the ajv license says "not scanned", but the file is scanned. The error is on the safe side. `AUTHORING.md` is not on the token-budget list, so the edit needs no re-pin. | `AUTHORING.md:848-849` "**two symbols in `src/validation/content.ts` decide that together**: a tree is scanned when `SCAN_DIRS` gathers it *and* `DENYLIST_EXEMPT_PREFIXES` does not subtract it" | "a path is scanned when `SCAN_DIRS` or `SCAN_FILES` gathers it and `isExempt()` does not subtract it; `isExempt()` never subtracts a shipped licence text (`LICENCE_FILES`)" |
| ADV-5 = SPEC-2 | adversarial (90), spec (90); advisory | **An alias can squat a snapshot.** If an alias records first at snapshot S, every later real-run record at S is refused, both failed and passing receipts, and an alias `ship-preflight` blocks the real one. It **fails closed**: it is reachable only through a deliberate `--run`, and no shipped skill passes `--run`. The refused real-run record still writes its receipt and log into the content-addressed artifact store; nothing references them, so they are inert. Before this fix, the real run's record simply replaced the alias record. | `gate.ts:524` `if (previous !== undefined && previous.run_id !== a.run)` | Refuse an explicit `--run X` where `safeRunId(X) !== X` at CLI entry, before any write. Keep the `:524` guard for case-fold aliases and add a remedy hint to its message |
| ADV-6 | adversarial (85, smell) | **A tampered record file now blocks re-recording with a misleading message.** A record file holding `{}` or `{"run_id":null}` gives "recorded for run undefined"/"null". No tool writes such a file: all 21 historical versions of `gate.ts` write `run_id: a.run`. | `gate.ts:525` | None required. Optionally treat a non-`lifecycle-gate` previous record as absent |

Recorded pre-existing observations, not findings:

- `check --evidence --run <alias>` writes a decision file into the real run's `decisions/`, which nothing reads.
- An alias typed record at a snapshot with no prior record can end the real run's open bypass use record. That fails closed: it only makes the verdict stricter.
- `check --run <alias>` without `--evidence` passes for gates the alias recorded, exactly like any made-up run id. That is ADV-2.

## Evidence matrix (fresh at `dbf3d730`)

Logs are in `.work/evidence/`; each digest is the sha256 of the log file. The worktree is discarded at teardown, so the content that matters is quoted here.

The prior round's E10/E12 script no longer exists, so I rebuilt it as `.work/smoke/smoke.ts` (sha256 `691dc9c1…731a3463`). It does the following:

- drives `open` / `record` / `check --evidence` in throwaway git repos;
- builds receipts with the head tree's own `takeSnapshot` and `artifactHash`;
- writes raw `__proto__` and `1e400` into the receipt text directly.

Its 30 rows are:

- 1 valid receipt;
- 12 root `Object.prototype` names;
- 6 nested names;
- 2 Infinity members;
- 5 erase rows: 4 malformed failures and 1 well-formed control;
- 4 ADV-1 alias rows: `+`, `+` with a receipt, `/`, upper case.

Isolated gates and smoke repos ran from the session scratchpad (`/private/tmp/claude-501/…/scratchpad`). I checked that no ancestor of it has a `node_modules` or `package.json`.

| # | Claim | Command | Exit | Key output | Log digest |
|---|---|---|---|---|---|
| E0 | The PR head is the reviewed sha | `git fetch origin pull/126/head`; `git ls-remote origin refs/pull/126/head refs/heads/main` at start and end | 0 | `dbf3d73057c14e29a1c40827aab9fd34a8acc730` both times; main `af962747` | — |
| E1 | Full suite | `AK_REQUIRE_DONORS=1 bun test` in the worktree at head, donors cloned at their pins by `tools/donors/clone.sh` | 1 | `3676 pass, 2 fail, Ran 3678 tests across 117 files [771.25s]`. The two failures are `setup wire: Kimi > a config this runtime cannot read as TOML…`, which predates the PR (round 2, E1b), and the T-1 timeout `packaged gates refuse run-id aliases… [60003.64ms]`. The spec seat's separate full run: 3,676 pass; its 2 failures (Kimi, plus catalog-progress in a git-init copy) fail identically on an `ea0f5253` copy | `5f8d7068…5ff266c2` |
| E-T | T-1 timing | `bun test tests/lifecycle/check.test.ts -t "packaged gates refuse run-id aliases" --timeout 300000` in the head extract | 0 | `1 pass … [36.03s]`, load average 8.95. The earlier concurrent run with the default timeout failed at `60003.69ms` | `8d76e3a2…138c49e3` |
| E2 | Bundles build and are current; one gate per host | clean `git archive dbf3d730` extract plus `git init` commit, `.donors/` **copied**, `node_modules` symlinked: `bun run ak build`; `bun run ak build --check` | 0 / 0 | `0 errors, 0 warnings, 1 note, … 0 checks skipped, 0 checks unavailable; install: no ak.install.yaml: default …`. Both `dist/*/bin/ak-gate.mjs` are **228,761 bytes**, sha256 `33f935cd6515bcb334a95e756d624ce9a0182835caa782222cd3c2d8f1927c68`, byte-identical. Plugin version `0.1.23` | `dd773fe3…ec794042` |
| E2r | The guard is the gate's only change since round 2 | the same build with `gate.ts:524-525` deleted | 0 | both gates are **228,606 bytes**, sha256 `3e386443dc7eb0938490ed6dd69958e47a9a85da272d21e26f7ed1b0e59db53c`, which is round 2's E7 gate exactly. The build is reproducible across rounds, and the delta adds 155 bytes | `505892bb…ce9048ba` |
| E2b | The published-version gate passes | `tools/publish/version-gate.sh .work/extract/dist` | 0 | built `0.1.23`; `origin/published` `978ad906` carries `0.1.22`; `package.json` and `catalog.yaml` are both `0.1.23` | `baae3dc7…dbf5c548` |
| E3 | Catalog validates | `research/probes/validate-figure.sh dbf3d730` | 0 | `ak validate: 0 errors, 34 warnings, 161 notes, 134 skill-style warnings, 0 checks skipped, 0 checks unavailable; install: no ak.install.yaml: default …`; `.donors: copied`; deps symlinked. Same counts as round 2 | `6e51c6fc…db1ec0ff` |
| E5 | Lint, ratchet growth, format | `bun run lint`; `bun run lint:growth`; `bun run fmt:check` | 0 / 0 / 0 | `no new violations; 2660 recorded in the baseline.`; `the baseline records nothing beyond af962747.`; `Finished … on 395 files` | `081f0b4d…e3747d7f`, `2262655c…ad41fdf0`, `0c2c3e94…356bd58f` |
| E10/E12 | **Live smoke, checkout CLI** | `bun .work/smoke/smoke.ts head-source <scratch> '["bun","<W>/src/cli.ts","lifecycle"]' all` | per row | 30 rows: `valid` exit 0 `ok`; the other 29 exit 1. Examples: `receipt must NOT have unevaluated properties (__proto__)`; `/project must NOT have additional properties (__proto__)`; `/exit_status must be integer`; `/command/duration_ms must be integer`. Erase rows (`project.repo null`, absolute `command.cwd`, `created_at` without an offset, root `constructor`): exit 1 after the passing re-record. Well-formed control: `failed` → `unstable` | `e9aa30c0…77a05191` |
| E10/E12b | **Live smoke, built gates alone under plain node** | the same script with `'["node","<scratch>/iso-claude/ak-gate.mjs"]'` and `iso-codex` | per row | 1 exit 0 and 29 exit 1 each. Normalized output (run ids masked) is **identical** to the source run and between hosts. The only remaining difference is each throwaway repo's commit sha | `d3130298…6ed655e0`, `29900656…ae5d97f7` |
| E10/E12c | Negative control: base | the same script against base `src/cli.ts` (`git archive af962747`) | per row | **12 exit 0**: valid, the 6 nested prototype names, `duration_ms: 1e400`, erasure with a root `constructor`, and the 3 no-receipt aliases. These are round 2's 9 plus ADV-1's 3. Head refuses all of them | `50b69a17…33fef99a` |
| E14 | **N3 at head** | `.work/mine/e14.sh head dbf3d730` (sha256 `3f216d26…cbee7c83`): clean head archive with `.donors/` copied; clean build; then plant `Reviewed for the jev series.` (term `model-name-1-jev`) in each file in turn, run `validate` and `build`, check the dist manifest and grep dist, restore | see key output | `ajv-validator_ajv.LICENSE`: validate **exit 1** `ERROR content.denylist provenance/licenses/ajv-validator_ajv.LICENSE:23 Denied term (model-name-1-jev)`, `1 error`; build **exit 1** `refusing to write dist/ while validation reports errors`; dist manifest unchanged `4db62129…`; **0 hits**. `ajv-validator_ajv-formats.LICENSE`: same (`:22`). Unshipped donor `obra_superpowers.LICENSE`: `0 errors`, build 0, 0 hits; it stays exempt by design. `NOTICE` control: `ERROR content.denylist NOTICE:67`, build refused | `b659d95f…eb7b5811` |
| E14r | **N3 revert control** | the same script with `src/validation/content.ts` taken from `ea0f5253`; then `bun test tests/content.test.ts` on that tree | see key output | both ajv plants: validate **exit 0, `0 errors`**; build **exit 0** `wrote dist/`; dist manifest changes; **2 hits** (one per host). NOTICE control still refused. Tests: `27 pass, 2 fail`; the failures are the two `a shipped license rejects a denylisted term` cases (head: 29 pass) | `9681f599…d1910d16`, `f7991c39…12441669` (head `089f40c2…21ee8bcb`) |
| E14b | SPEC-1: root LICENSE | the E14 head tree, a term appended to `LICENSE` | 0 / 0 | `ak validate: 0 errors`; `wrote dist/`; hits `dist/claude-code/LICENSE dist/codex/LICENSE` | `75883df7…57d0054d` |
| E14c | SPEC-1: a shipped eval file | the same with `evals/visual-edit/missing-prerequisite-stops-without-static-fallback/project/server.mjs` | 0 / 0 | `0 denylist errors`; hit `dist/claude-code/evals/visual-edit/…/server.mjs`. Base has the same `TEXT_FILE` and the same file | `8c17e172…3902451e` |
| E15 | **ADV-1 at head** | the alias rows of E10/E12 on all three targets | per row | `+`, `/` and upper-case aliases: `alias record=1 ak lifecycle record: verify at this snapshot was recorded for run feature-<hex>, not feature+<hex>`. The record still holds `run_id=feature-<hex> refs=2`, and after the passing re-record `check` gives **exit 1** `evidence unstable: AC-1 has both failed and passed evidence at this head`. The alias with `--receipt` is refused earlier: `run feature+<hex> has no task-bound run record` | (E10/E12 logs) |
| E15r | **ADV-1 revert control** | `.work/revert-adv1`: the head archive with `gate.ts:524-525` deleted (`ADV1-revert.patch`), rebuilt; alias rows on the reverted source and the reverted gate copied alone under node; `bun test tests/lifecycle/check.test.ts -t alias` | per row / 1 | the 3 no-receipt aliases give `alias record=0`, the record is reduced to `refs=1`, and **`check` exit 0 `ok: run feature-<hex> has current evidence for build-checks, verify, review-full, review-readiness`** on both targets. The receipt alias stays refused by the run-record check. Tests: `0 pass, 2 fail` (head: source test passes; bundle test passes in E-T) | `cbfc9fff…d5fbc648`, `07a00d20…487e58b6` |
| E16 | CI at head | `gh-axi pr checks 126`; `gh api …/actions/runs/37712445054` | 0 | `1 passed, 0 failed, 1 total`; the run's `head_sha` is `dbf3d73057c14e29a1c40827aab9fd34a8acc730`, conclusion `success` | — |
| E17 | No other shipped file comes from an exempt source | `grep '"jev"'` and the scanner-literal pairs in `dist/claude-code/bin/ak` and `bin/ak-gate.mjs` | — | 0 hits in each. The spec seat's `planBundle` enumeration: only the two ajv texts sit under an exempt prefix | — |

## Coverage limits

- **Knowledgebase.** None is registered, and the project has no agent-kit project record. `readContext` was therefore unavailable, the standards seat used the repo's own `AGENTS.md` and `AUTHORING.md`, and no lesson was published. Lessons marked in the panel output:
  - enforce a packaging invariant on the planned output, not on a hand-kept list of inputs (SPEC-1, NEW-1);
  - a refusal guard keyed on storage identity should canonicalize the caller's identity before any write (ADV-5).
- **Grant bundle version.** The bypass check and the `review-delta` record used the installed bundle 0.1.22, the version this PR replaces. Both wrote into the shared evidence store under `/Users/eduardopicazo/Documents/Workspace/firstmate/projects/agent-kit/.git/agent-kit/evidence/Pibomeister-fm-rev-ak126-akr3/`, as rounds 1 and 2 did.
- **Branch move.** This worktree's local branch was moved to the PR head so the grant could name a run. It was not pushed.
- **Runtimes.** Only Node v25.6.1 and Bun 1.4.2 were used. My smoke rows ran the bundles under node only. Bun runs of the bundle come from the PR's own bundle tests (node and bun) in E1/E-T. The minimum Node version is still unmeasured.
- **Host load.** The full suite ran concurrently with three seats and my builds (load average 8–10). That is how T-1 surfaced. CI at this head is green.
- **Writes outside the worktree.** Isolated gate copies and throwaway smoke repos lived in the session scratchpad under `/private/tmp`, so that no `node_modules` ancestor could satisfy an import. The gate's use and `review-delta` records went to the shared evidence store, as above. Apart from those, only this report and the status file were written outside the worktree.
- **Seat isolation.** Isolation is by packet and probe directory, and the host does not attest it.
- **Receipts.** No super-verify receipts were produced: the evidence is plain commands with exit codes, as in rounds 1 and 2. No `readiness` lane was run, because only the delta was requested.
- **Not re-run.** The PR's "645-case parity sweep" was not re-run, because its script is not in the tree. The in-tree 2,926-case sweep runs inside E1 and passes.

## Recommendation

**Ship as is from a review standpoint.** N3 and ADV-1 are fixed and proven by revert controls. Nothing previously fixed regressed, the panel approves with no P0–P2 introduced by this change, and CI is green at this head. Merge stays the captain's decision.

Route the rest as one follow-up PR rather than a third fix cycle in this one, since fix cycles and review rounds are both at their caps:

1. **SPEC-1 + NEW-1 (one structural change).** Have the packaging check run the denylist over every planned bundle file, or at minimum derive the scan list from an exported `LICENCE_FILES` and widen `TEXT_FILE` for shipped `evals/` files. Either way, delete `SHIPPED_LICENSE_FILES`. This closes the root `LICENSE` and eval-file gaps and stops the next shipped license (N15) from reopening N3.
2. **NEW-3.** A one-sentence `AUTHORING.md` §7 update in the same PR.
3. **T-1.** Split `check.test.ts:1518` per host × runtime before it flakes in a loaded CI or gate run.
4. **ADV-5 (optional hardening).** Refuse a non-canonical `--run` at CLI entry.

**Decision lever for Firstmate.** If Firstmate wants SPEC-1 inside this PR, that is a third fix cycle. Per ruling `two-fix-cycles-then-stop`, it needs a fresh baseline (full) review rather than another delta. A follow-up PR is the cheaper path.

VERDICT: PASS

# rev-ak126-akr2: second super-review (full) and fresh evidence for https://github.com/Pibomeister/agent-kit/pull/126

This round reviewed head `ea0f5253c9937f4f37f74e94e06c54a9ebae9369` against comparison base `af962747c2a1f15d1b0b1998f194f37f41de0c11`, which is `origin/main` and the merge base. The prior round reviewed `3281afe979f6eb2d9eba4370a4ff9b2dbd55a0cc` (`data/rev-ak126-akr/report.md`). I fetched `refs/pull/126/head` at the start, and `git ls-remote` confirmed it at the end. Both reads returned `ea0f5253`, so the head did not move. Everything below was run fresh on 2026-10-08 UTC, with Bun 1.4.2 and Node v25.6.1 on darwin. Nothing was pushed, commented on or merged.

## Bottom line

Both blockers from the first round are fixed, and I proved each fix with a revert control.

- **B2 (failure erasure).** A failed receipt with a schema-only defect now stays recorded after a passing receipt is re-recorded under its id. This holds through the checkout CLI and through both built gates run in isolation under plain node.
  - Restoring the old `storedFailure` conjunct brings the erasure back: `check --evidence` exits 0 again.
  - The same revert fails all 28 new regression tests plus the bundle test.
- **B1 (no test on the shipped gate).** A gate whose emitted validator accepts everything now fails tests under both node and bun.
- **The other first-round fixes.** S1, S2, S4, S5, N1, N7 and N9 are fixed, and S3 is partial. All of them were checked with negative controls.
- **The PR's own claims.** Every acceptance claim I re-ran reproduced exactly. That covers the 2,926 comparisons, the 249 affected tests, the negative control, the 228,606-byte gate with sha256 `3e386443…`, build, the version gate, and the six-line live smoke.

The panel still returns **changes-requested**, for one finding this change introduced:

- **N3 (P2, still open).** The two ajv license texts this PR ships into every bundle live under `provenance/`, which the denylist scanner skips. That breaks the written invariant in `AUTHORING.md:861`: "nothing packaged into `dist/` is ever exempt".
  - I reproduced it independently. With a denylisted term planted in `provenance/licenses/ajv-validator_ajv.LICENSE`, `ak validate` reported `0 errors`, and the term landed in both `dist/` hosts.
  - The same term in `NOTICE` gave `1 error`.
  - Round 1 filed N3 as a P3 nit. The standards seat now rates it P2 because it breaks a stated, enforced invariant. Both ratings are recorded, and the synthesis did not change either one.

The remaining findings are either pre-existing at base or P3. The most important is ADV-1 (P2, pre-existing): a run-id alias such as `feature+<hex>` (where `feature-<hex>` is the run's real id) erases a recorded failure. I reproduced it on head and on base. It is not a regression, but it is a second erasure path past the guarantee this PR now documents.

**Decision lever:** if Firstmate defers N3 by decision, as N2 was, no P0–P2 finding introduced by this change remains, and this review would read PASS.

## How the review was run

- **Authority.** I ran the installed bundle's gate (0.1.22): `node ~/.claude/plugins/cache/agent-kit/ak/0.1.22/bin/ak-gate.mjs bypass check --grant /Users/eduardopicazo/.firstmate-grants/rev-ak126-akr2.json --task rev-ak126-akr2 --phase super-review:full`.
  - It **exited 0**: grant `bypass-rev-ak126-akr2-d0c72434e0cc`, sha256 `a810f4b6…3ca4e0`, `checked_at` 2026-10-08T00:01:13.418Z, run `Pibomeister-fm-rev-ak126-akr2`.
  - The first attempt on the detached head exited 2 with "detached head … pass --run <id>". I then moved this worktree's own local branch `Pibomeister/fm-rev-ak126-akr2` to the exact PR head (`git checkout -B`; not pushed) and re-ran the check.
  - Inbox message `001.msg` (the grant path) was acknowledged by moving it to `handled/`.
- **Snapshot.** A `git archive` of the head was frozen read-only at `.work/review/snapshot/`.
  - Tree digest: `sha256:1f2b08ab…4e06b1`.
  - Base→head diff: `sha256:728153f1…d75a2b`, 1,802 lines, 27 files, +931/−404.
  - Fix diff since the prior head (3281afe9→ea0f5253): `sha256:434b55bc…bfca70`, 676 lines, 12 files, +346/−83.
- **Seat packets.** Every seat received the same set of inputs:
  - the snapshot and both diffs;
  - the requirements R1–R9 restated from the change's intent (`requirements.md`, sha256 `e2ca46c6…dcff51`);
  - the durable prior-finding packet as its delta checklist (`prior-findings.md`, sha256 `3e4bdba8…bb685b`);
  - one shared rules preamble (`seat-preamble.md`, sha256 `f67a311e…55e45c`).

  Seats were forbidden to read the PR body and comments, commit messages, my evidence logs, or each other's output. Each seat probed in its own copy under `.work/review/probes/<seat>/` and could not edit the snapshot. No seat authored or approved the change.
- **Review artifact.** `.work/review/review.json`, sha256 `5f2dd6d468a63127ad0f9e4fddae10af5985a9b53aa9b35150693dd3f85e3ed2`, names every seat output by hash. The worktree is discarded at teardown, and this report carries the content.

### Panel and lane states

Seat lane verdicts are derived by one rule: an open P0–P2 finding introduced by this change means request-changes.

| Seat | Why selected | Lane | Output sha256 |
|---|---|---|---|
| correctness | always on | covered: complete, 0 new findings; approve | `a2b0f850…2c97` |
| project-standards | AGENTS.md and AUTHORING.md declare standards | covered: complete; N3 open at P2; **request-changes** | `3cc71cf3…06d2fe` |
| testing | the change alters behavior | covered: complete, 1 new (P3); approve | `37416c46…664b` |
| maintainability | new modules and a build path | covered: complete, 3 new (P3); approve | `ef028f4a…cf24` |
| security | worker-supplied receipts reach the ship gate; third-party code bundled into a shipped executable | covered: complete, 1 new (P3); approve | `56203147…c50` |
| adversarial | same trust boundary | covered: complete, 5 new (1 P2 pre-existing, 4 P3); approve | `921a1053…880e` |
| reliability | the build failure path, error handling and the subprocess | covered: complete, 2 new (P3); approve | `458de93b…12a7` |
| api-contract | refusal text read by super-ship and supervisors; host contracts | covered: complete, 1 new (P3); approve | `03e70701…48f3` |
| agent-native | no new command or action surface | skipped | — |
| learnings | no knowledgebase registered and no lesson corpus | skipped | — |
| data-migration | `schemas/` unchanged (E8) | skipped | — |
| performance | no stated budget; N2 deferred by decision | skipped | — |
| previous-comments | the PR has 0 comments and 0 reviews | skipped | — |
| frontend-races, swift-ios | no such stack | skipped | — |

**Review verdict: changes-requested.**

- Review rounds: 2. Fix cycles in this run: 0.
- The `review-full` gate is **not recorded**, because super-review records it only on `approved`.
- Nothing inside the review needed approval, so no needs-decision was raised.

## Delta table (prior round's findings at `ea0f5253`)

| Id | Status | Evidence (head line, and the control that proves it) |
|---|---|---|
| B1 | **FIXED** | `tests/lifecycle/check.test.ts:1502` `for (const runtime of ["node", process.execPath]) {` drives the planned gate of both hosts over the 2,926-case sweep plus the 12 prototype names. With the emitted validator replaced by `() => () => true`, 2 check.test bundle tests and 1 build-gate test fail. A bun-only accept-all fails with `claude-code under …/.bun/bin/bun`, so bun really runs. The `project.repo: null` record/check row is at `check.test.ts:1600` (node only) (testing seat). |
| B2 | **FIXED** | `src/lifecycle/gate.ts:294` `return receipt !== undefined && receipt.status === "failed" && boundTo(receipt, snapshot);`. Its only caller is `gate.ts:546`. Fresh E12 runs on the head source, the claude-code gate under node and the codex gate under node all give **exit 1** after the passing re-record, for `project.repo: null`, an absolute `command.cwd`, `created_at` with no offset, and a root `constructor`. **Revert control (E12r):** with the conjunct restored, the same four cases give **exit 0 `ok`** on both source and rebuilt bundle, and 29 tests fail (all 28 `…stays sticky after replacement: *` plus the bundle test). Confirmed independently by the correctness, adversarial and testing seats. |
| S1 | **FIXED** | `gate.ts:725-726` `for (const key of Object.keys(receipt))` / `if (Object.hasOwn(Object.prototype, key)) reasons.push(…)`. E10: all 12 root names, including raw `__proto__`, are refused on source and both bundles. Nested names are refused at every closed object: 4,260 cases (security), 624 (adversarial), 28 paths × 12 names (correctness). The only acceptances sit under `probe.parameters`, which the schema declares open. Removing the guard fails the predicate test (testing). |
| S2 | **FIXED** for planning errors | `src/packaging/build.ts:68` returns before the only `rmSync` (`:71`) when any plan has an error. Breaking gate.ts, or making the schema uncompilable, gives `validate` 1, `build` 1 with "refusing to write dist/" and `--check` 1, and dist stays byte-identical (sha manifest diff, reliability). Gaps: ADV-4 (an I/O failure mid-write) and F-V2 (other plan errors invisible to validate). |
| S3 | **PARTIAL** (testing now rates the remainder P3) | `tests/lifecycle/build-gate.test.ts:68` `expect(a).toBe(b);` plus the path loop at `:69-72` catch `Date.now()` and outfile injected at the builder layer. Embedding the root, time and temp dir in the `plan.ts:242` header fails **0** tests, and `check.test.ts:1554`'s cross-host identity still compares one `gateScripts` cache entry against itself. Today's artifact is clean: separate processes and roots produce the same sha `3e386443…` with no paths (reliability, security, E7). |
| S4 | **FIXED** | `tests/packaging.test.ts:2007`, `:2020`, `:2036`. Silencing the error fails 2 tests; restoring the destructive writer fails 2; dropping `links.ts:127` fails 1 (testing, reliability). The CLI-layer assertions in `:2029-2033` are vacuous (T1). |
| S5 | **FIXED** | `build-gate.test.ts:14` stubs the real `verificationValidator` accessor; `:39` asserts `malformed: false`, and `:47` asserts `accepted: false` for `exit_status: 1e400`. |
| S6 | out of scope (pre-existing `bin/ak` notices) | — |
| N1 | **FIXED** in the gate | `src/lifecycle/verification-schema.ts:10-11` `strictTypes: false,` / `keywords: ["x-validator-rule"],`. Infinity is refused in `exit_status`, `command.duration_ms` and `api_response.status` on source and both bundles (E10, security, correctness). Restoring `strict: false` fails 2 tests. The sibling compilers still use `strict: false` (F-SEC-1). |
| N2 | out of scope (deferred by decision) | — |
| N3 | **NOT FIXED** (P2 this round, P3 last round) | `plan.ts:196-197` ship `provenance/licenses/ajv-validator_ajv{,-formats}.LICENSE`; `src/validation/content.ts:42` exempts `"provenance/"`; `plan.ts:18` still says provenance is "never installed". E14 reproduces the bypass. |
| N4 | **PARTIAL** | `tests/packaging.test.ts:237-239` now credits the contracts with the directory only. But `:240` "the filenames and the placement are taken from the contract" and `plan.ts:187-189` still overclaim, and grep finds 0 ajv file names in either CONTRACT.md. |
| N5 | **NOT FIXED** | `gate.ts:722`. A passed `exit_status: 1` gives `/exit_status must be equal to constant; receipt must match "then" schema`. A not-run receipt with execution evidence gives `receipt must NOT be valid; …`, which names no member. |
| N6 | **NOT FIXED** | `gate.ts:713` and `:727` are byte-identical to 3281afe9. A receipt with neither member gets ajv's "must have required property 'no_criteria'" next to `supports is invalid`, so it points the worker at the one remedy the gate refuses. |
| N7 | **FIXED** | `verification-schema.ts:24` `/** Compiled on first use. The standalone builder replaces this module with its generated accessor. */`. This is accurate (reliability probe). |
| N8 | **NOT FIXED** | `plan.ts:239` `{ cwd: root, encoding: "utf8" },` has no timeout, and `:241` drops `built.error`/`signal`. Hang probe: `ak validate` blocked until a 45 s alarm killed it, the child bundler was orphaned, and `.work/ak-gate-*` was left behind. `tools/hooks/pre-push:81` runs `ak build` with no bound. A spawn of a missing binary reports only "gate build failed". |
| N9 | **FIXED** | Same comment as N7; the build-gate test proves the module is replaced. |
| N10 | **NOT FIXED** | `plan.ts:216` `gateScript(root, source, …)` uses `source` only as a cache key; `build-gate.ts:9` `dirname(dirname(dirname(source)))`. |
| N11 | **NOT FIXED, now divergent** | See F-SEC-1. |
| N12 | **NOT FIXED** | No test passes a non-object root; changing `gate.ts:724` to `return []` keeps 11/11 passing. `verification-predicate.test.ts:128-132` pins ajv order; changing NOTICE to `ajv 8.19.0` passes. |
| N13 | **NOT FIXED** | Neither contract tree lists `bin/`. Profiles without the gate (product, learning, maintainer, autonomy) still ship both ajv licenses, with a NOTICE naming `bin/ak-gate.mjs`. |
| N14 | **NOT FIXED** (disclosed in the PR's known limitations next to N2) | A 161 KB receipt produces 1.94 MB of stderr plus a 1.94 MB decision file, written again on every check. An 801 KB receipt produces 9.78 MB of each in 12.8 s. Base: 155 B (adversarial). |
| N15 | **NOT FIXED** | `plan.ts:193-197` is still a fixed list. Adding `uniqueItems: true` pulls `fast-deep-equal` (MIT) into the gate, and `ak build` exits 0 with no notice (security metafile probe). |

Carried residual risks: a checkout gate still needs `node_modules`; leap-second `created_at` values pass the schema (no gate code reads `created_at`); the minimum Node version is untested.

## Findings (ranked)

Severity is the seat's own. Findings that share a fingerprint are merged and keep every seat's evidence. No seat emitted `safe_auto`.

### Blockers (P0–P1)

None.

### Should fix (P2)

**N3: the ajv license texts this PR ships into every bundle are exempt from the denylist** (standards, P2, confidence 100, gated_auto, defect; introduced by this change).

- **Rule broken.** `AUTHORING.md:861`: "The invariant that decides the exempt list: nothing packaged into `dist/` is ever exempt".
- **Where.** `src/packaging/plan.ts:196-197` `"provenance/licenses/ajv-validator_ajv.LICENSE",` / `"provenance/licenses/ajv-validator_ajv-formats.LICENSE",`, together with `src/validation/content.ts:42` `"provenance/",`.
- **My reproduction (E14).** I appended a denylist probe term to the shipped LICENSE. `ak validate` reported `0 errors`, `ak build` exited 0, and the term was present in `dist/claude-code/…` and `dist/codex/…`. The control, the same term in `NOTICE`, gave `ERROR content.denylist NOTICE:67` and `1 error`.
- **Exposure today.** None: the shipped texts are byte-identical to `node_modules` and carry no hit. The invariant is what is broken.
- **Fix.** Move both texts to repo-root files (for example `LICENSE.ajv`, `LICENSE.ajv-formats`) listed in `LICENCE_FILES` and `content.ts` `SCAN_FILES`. Update the NOTICE paths and both contract trees, which also closes N4 and part of N13. Adding the directory to `SCAN_DIRS` is not enough, because `TEXT_FILE` skips `.LICENSE` files.

**ADV-1: a run-id alias overwrites the verify record and erases a recorded failure** (adversarial, P2, confidence 100, manual, defect; **pre-existing at base**).

- **Where.** `gate.ts:522-523` `const path = join(a.dir, safeRunId(a.run), a.gate, name);` / `const previous = readObject(path)…`, with no check that `previous.run_id === a.run`.
- **My reproduction (E15).** I recorded a well-formed failure (`check` gave exit 1 `evidence failed`). Then I ran `record --gate verify --run feature+<hex>`, which `safeRunId` maps onto `feature-<hex>`, and recorded a passing receipt under the same id. `check --evidence` then gave **exit 0 `ok`**. That happened on the head source, the head claude-code gate under node, and base source. On macOS an upper-case alias works too (seat probe).
- **Why it matters here.** The fail-open route is narrow: it needs a deliberate alias. But it defeats the sentence this PR adds to `references/verification-evidence/REFERENCE.md:94-96`, and it is reachable through the CLI.
- **Fix (verified by the seat).** Refuse in `recordGate` when `previous !== undefined && previous.run_id !== a.run`. With the guard in a copy, standalone check tests pass 82/82 and bypass tests 67/67.

### Nits and smaller defects (P3)

| Id | Seats | Finding | Where (quoted at head) | Fix |
|---|---|---|---|---|
| T1 | testing (100) | The validate test's exit-status and "not 0 errors" assertions are vacuous: the fixture already has 57 unrelated validate errors. Downgrading `packaging.gate-build-failed` to a warning in `run.ts` still passes. | `tests/packaging.test.ts:2031` `).toBe(1);`, `:2033` `…startsWith("ak validate: 0 errors")…toBe(false)` | assert a line matching `/^ERROR\s+packaging\.gate-build-failed\s/` |
| F-SEC-1 = MAINT-1 | security (100), maintainability (100) | The N1 strictNumbers fix lives only in the gate's compile. `ak validate` (`schemas.ts:61`) and KB publish (`src/kb/artifacts.ts:67`) still use `strict: false`, so they accept `duration_ms: 1e400` and `exit_status: 1e400` receipts that the gate refuses. The parity oracle in `verification-predicate.test.ts:11` shares the blind spot, and also accepts Object.prototype root names. This is N11 turned into a divergence. | `src/validation/schemas.ts:61` `new Ajv2020({ strict: false, allErrors: true, validateFormats: true })` | one exported options object (`strictTypes: false, keywords: ["x-validator-rule", "x-digest-domain"]`; all 33 schemas compile with it) used by all three; add a 1e400 case to the parity loop |
| F-V1 = REL-1, MAINT-3, ADV-5 | reliability, maintainability, adversarial (100) | `ak validate` reports one gate-build failure once per host: one broken gate.ts gives `2 errors`, two identical rows. `build --check` collapses it. | `src/validation/links.ts:127` `issues.push(...plan.issues.filter((issue) => issue.rule === "packaging.gate-build-failed"));` inside the host loop | `collapseDuplicates` (export it from build.ts) |
| F-V2 = MAINT-3, ADV-5 | maintainability, adversarial (100) | Sibling plan-only errors never reach `ak validate`: `maintenance-build-failed`, `gate-source-missing`, `licence-file-missing`. Validate exits 0 with "0 errors" while build exits 1. The writeBundles guard still protects dist. | same line | push every plan-only rule once after the loop |
| ADV-4 + REL-2 | adversarial (defect), reliability (smell) | An I/O error mid-write still tears a host. With `chmod 555` on `dist/codex/skills`, `ak build` exits 1 with `dist/codex` left holding only `skills/` and `bin/ak-gate.mjs` gone. The loop is pre-existing; the new comment claims "every installed bundle intact". | `build.ts:67` `// A failure in any host must leave every installed bundle intact.` | narrow the comment to planning errors (REL-2); stage-and-rename per host (ADV-4) |
| API-1 | api-contract (75) | A retained malformed failure is reported only as `evidence malformed`. Re-recording a corrected passing receipt under its id prints `recorded verify …` (exit 0) and changes nothing. Base reported `evidence unstable`, which signals a failure on record. | `gate.ts:875-877`; `:546`; success line `:1929` | a `note:` from `recordGate` when the incoming id is held by a retained failure |
| ADV-3 | adversarial (100), pre-existing | A failure whose `status` is `"FAILED"`, `["failed"]`, or `passed` with `exit_status: 1` is not sticky and can be erased, the same as base. | `gate.ts:294` | treat a bound receipt with a non-zero `exit_status` as a failure too |
| ADV-2 | adversarial (100), api-contract (residual), pre-existing | Running `open` again at an unchanged head starts a clean run that escapes a recorded failure, the same as base. | `gate.ts:388` | `openRun` refuses while the current run holds a bound failure at this snapshot |
| MAINT-2 | maintainability (75, smell) | The Object.prototype loop sits under a doc comment saying the schema "cannot express" these checks. The loop is actually an ajv workaround that covers the root only. A test guards it. | `gate.ts:713`, `:725-726` | one comment naming the ajv behaviour and why only the root needs it |

Open carried P3s, from the delta table: S3 remainder, N4, N5, N6, N8, N10, N12, N13, N14, N15.

## Evidence matrix (fresh at `ea0f5253`)

Logs are in `.work/evidence/` in this worktree; the digest is the sha256 of the log file. `smoke.ts` (`.work/smoke/smoke.ts`, final sha256 `1b8cdbda…edab93`) re-implements the prior round's E10/E12 scripts, which no longer exist on disk.

- It drives `open` / `record` / `check --evidence` in throwaway git repos.
- It builds receipts with the head tree's own `takeSnapshot`.
- The `SMOKE_NOTES`, `SMOKE_ALIAS` and `SMOKE_ONLY` switches were appended after the E10/E12 runs and leave the default case list unchanged.

Isolated gates and scratch repos ran from the session scratchpad (`/private/tmp/claude-501/…/scratchpad`), which has no `node_modules` or `package.json` on any ancestor (checked).

| # | Claim | Command | Exit | Key output | Log digest |
|---|---|---|---|---|---|
| E0 | The PR head is the reviewed sha | `git fetch origin pull/126/head`; `git ls-remote origin refs/pull/126/head` at start and end | 0 | `ea0f5253c9937f4f37f74e94e06c54a9ebae9369` each time | — |
| E1 | Full suite | `AK_REQUIRE_DONORS=1 bun test` (worktree at head, donors cloned by `tools/donors/clone.sh` at their pins) | 1 | `3673 pass, 1 fail, Ran 3674 tests across 117 files [730.77s]`; only failure `setup wire: Kimi > a config this runtime cannot read as TOML…`; 0 skips | `807560ae…d153c8` |
| E1b | The Kimi failure predates the PR | base `af962747` extract: `bun test tests/learn/setup-wire-hosts.test.ts` | 1 | `26 pass, 1 fail`, same test | `9d0fc678…16f948` |
| E2 | Bundles build and are current | clean `git archive ea0f5253` extract plus an empty `git init` commit, `.donors/` **copied**, `node_modules` symlinked: `bun run ak build`; `bun run ak build --check` | 0 / 0 | `0 errors, 0 warnings, 1 note, 0 skill-style warnings, 0 checks skipped, 0 checks unavailable; install: no ak.install.yaml: default …` | `dd773fe3…794042` |
| E2b | The published-version gate passes | `tools/publish/version-gate.sh .work/extract/dist` | 0 | built plugin.json `0.1.23`; `origin/published` (`978ad906`) `0.1.22`; `package.json` and `catalog.yaml` both `0.1.23` | `19eaf438…50f061` |
| E3 | Catalog validates | `research/probes/validate-figure.sh ea0f5253` | 0 | `ak validate: 0 errors, 34 warnings, 161 notes, 134 skill-style warnings, 0 checks skipped, 0 checks unavailable`; `.donors: copied`; deps symlinked | `8250ce7a…71ea3f` |
| E4 | The PR's negative control | extract: `bun test` predicate + build-gate; base `gate.ts` swapped in; head restored (`cmp` identical) | 0 / 1 / 0 | `11 pass` → `4 pass 7 fail` → `11 pass`. The 7 failures are all in `verification-predicate.test.ts` (8 tests), and the 3 build-gate tests pass both ways, so the PR's "1 pass, 7 fail → 8 pass" reproduces on its population | `b48282e8…cd56bf` |
| E4b | The PR's "2,926 comparisons" | parity lines in E1 | — | 455 + 458 + 472 + 321 + 1220 = **2926** | (E1) |
| E5 | Lint, ratchet growth, format | `bun run lint`; `bun run lint:growth`; `bun run fmt:check` | 0 / 0 / 0 | `no new violations; 2660 recorded`; `records nothing beyond af962747`; `All matched files use the correct format.` | `bf96b1ba…f99dc9`, `fab7decb…62a0ae`, `f1fcc0af…71c914` |
| E6 | The PR's "249 affected tests" | extract: `bun test` verification-predicate, build-gate, check, packaging | 0 | `249 pass, 0 fail, Ran 249 tests across 4 files` | `11034fef…2b50a4` |
| E7 | R5: one self-contained gate per host | `wc -c`, `shasum -a 256`, `cmp`, specifier scan of `dist/*/bin/ak-gate.mjs` | 0 | both **228,606 bytes**, sha256 `3e386443dc7eb0938490ed6dd69958e47a9a85da272d21e26f7ed1b0e59db53c`, identical; static imports are `node:` built-ins only; the single `require("ajv/dist/runtime/ucs2length")` text is the literal `ucs2length.code` string | (E2) |
| E8 | R2/R7: schemas and deps unchanged | `git diff --stat af962747 ea0f5253 -- schemas/ bun.lock`; `git diff … -- package.json` | 0 | empty for `schemas/` and `bun.lock`; package.json changes only `"version"` 0.1.22 → 0.1.23 | — |
| E10/E12 | **Live smoke**, head source CLI | `bun .work/smoke/smoke.ts head-source <scratch> '["bun","<W>/src/cli.ts","lifecycle"]'` | per row | 31 rows: valid → exit 0 `ok`; 30 malformed or erase rows → exit 1. Root names: all 12, e.g. `receipt must NOT have unevaluated properties (__proto__)`. Nested: `command.constructor`, `environment.toString`, `project.__proto__`, `artifacts[0].valueOf`, `created_by.hasOwnProperty`, `ticket.constructor` → `/<path> must NOT have additional properties (<name>)`. `exit_status: 1e400` → `/exit_status must be integer`; `duration_ms: 1e400` → `/command/duration_ms must be integer`. Erase: repo-null, absolute cwd, offset-less `created_at` and root `constructor` all give exit 1 after the passing re-record; the well-formed control gives `failed` → `unstable` | `dc4c402c…5f1a85` |
| E10/E12b | **Live smoke**, both built gates copied alone into the scratchpad, plain `node` | same script with `'["node","<scratch>/iso-claude/ak-gate.mjs"]'` and `iso-codex` | per row | 1 exit 0 and 30 exit 1 each. Normalized output is **identical** to the source run and between hosts (`diff` clean) | `e691c7a2…5d1e8c`, `03ab32c9…5741a4` |
| E10/E12c | Negative control: base | same script against base `src/cli.ts` | per row | 9 exit 0: valid, the 6 nested prototype names, `duration_ms: 1e400`, and erasure of a failure with a root `constructor` (`check` exit 0 after re-record). Root names were refused as `unknown member X`. Head is stricter in every row | `04b5016e…d31fd8` |
| E12r | **Revert control for B2** | `.work/revert-b2`: head with `&& verificationShapeReasons(receipt).length === 0` restored in `storedFailure` (patch in `B2-revert.patch`), rebuilt (`ak build` exit 0, gate sha `9f9d9604…c21372`), erase rows on reverted source and reverted bundle under node; then `bun test tests/lifecycle/check.test.ts -t "stays sticky\|the gate a bundle carries\|ships"` | per row / 1 | all four malformed failures **exit 0 `ok`** after the passing re-record on both; the control stays `unstable`. Tests: **29 fail, 3 pass** (28 sticky rows plus the bundle test). The same tests pass at head (E1) | `b01e617f…43b026`, `e0a648a5…e49a35` |
| E13 | The PR's "valid receipt with 2 MiB of notes still passes" | `SMOKE_NOTES=1 smoke.ts` on head source and the claude-code gate under node | 0 | `valid receipt with 2 MiB notes | exit 0 | ok: …` on both | `36b65e49…86fa4c` |
| E14 | Independent reproduction of N3 | `.work/n3probe` (head archive): a denylist probe term (`model-name-1-jev`) appended to `provenance/licenses/ajv-validator_ajv.LICENSE`; `ak validate`; `ak build`; `grep` in dist; control: the same term in `NOTICE` | 0 / 0 / — / 1 | `ak validate: 0 errors`; `ak build: 0 errors … wrote dist/`; the term is present in both `dist/*/provenance/licenses/ajv-validator_ajv.LICENSE`; control `ERROR content.denylist NOTICE:67`, `1 error` | `bd71c01e…901bc9` |
| E15 | Independent reproduction of ADV-1 | `SMOKE_ONLY=1 SMOKE_ALIAS=1 smoke.ts` on head source, the head claude-code gate under node, and base | per row | failed → `check` exit 1 `evidence failed`; `record --gate verify --run feature+<hex>` exit 0; pass under the same id; then **`check` exit 0 `ok`** on all three | `5e27a6ca…bbd794` |
| E16 | CI at head | `gh-axi pr checks 126` | 0 | `1 passed, 0 failed, 1 total` | — |

Not re-run:

- **The PR's "645 comparisons, 0 disagreements" repro.** It uses a script that is not in the tree. The PR's 2,926-case sweep (E4b) and the seats' 4,260-, 624- and 336-case prototype sweeps cover the same ground.
- **The PR's "accept-everything gate: 2 failures; nondeterministic builder: 1 failure; destructive writer: 3 failures" controls.** I did not run these myself. The testing seat ran its own equivalents and got 2 + 1, 1 for builder-layer paths and time (0 for the plan-header layer, see S3), and 2 + 1. Those counts sit in that seat's output, not in my logs.

## Coverage limits

- **Knowledgebase.** None is registered, and the project has no agent-kit project record, so the learnings seat was skipped and no lesson was published. Lessons marked in the panel output:
  - a validity rule must be defined once for every validator that judges the same document (F-SEC-1);
  - a shipped file must never sit under a denylist-exempt prefix (N3);
  - a CLI-level assertion is vacuous when its fixture already fails for unrelated reasons (T1).
- **Grant bundle version.** The bypass check used the installed bundle 0.1.22, the version this PR replaces. The check wrote its use record into the default evidence store under the shared git common dir, the same as round 1.
- **Branch move.** This worktree's local branch was moved to the PR head so the grant could name a run. It was not pushed.
- **Runtimes.** Only Node v25.6.1 and Bun 1.4.2 were used. The PR says CI uses Bun 1.3.14. The minimum Node version for the bundle is still unmeasured. My E10/E12 bundle runs were under node only. Bun runs of the bundle were covered by the testing seat's sweep and its bun-only accept-all control, not by record/check rows (the test at `check.test.ts:1548` runs those rows under node only).
- **Writes outside the worktree.** The isolated gate copies and throwaway smoke repos lived in the session scratchpad under `/private/tmp`, outside the worktree, so that no `node_modules` ancestor could satisfy an import. Seats' test runs also used the OS temp dir, as the project's own tests do. Nothing else was written outside the worktree except this report and the status file.
- **Seat isolation.** Isolation is by packet and probe directory and is not attested by the host.
- **Receipts.** No super-verify receipts were produced: the evidence is plain commands with exit codes, as for round 1. No `review-readiness` lane was run, because only `full` was requested.
- **Pre-existing failure.** The Kimi TOML test failure (E1, E1b) predates the PR and was not investigated.

## Recommendation

Send the change back to the ship lane (`ak-predicate-fix`) for one small patch:

1. **N3 (P2).** Move the two ajv license texts to scanned root files (`LICENCE_FILES` + `SCAN_FILES`), fix the NOTICE paths and both contract trees (this also closes N4 and the license half of N13), and correct the `plan.ts:18` comment.
2. **Same patch, each a few lines:**
   - T1: assert `ERROR packaging.gate-build-failed`.
   - F-SEC-1: one shared ajv options object for the gate, `ak validate` and KB publish, plus a 1e400 parity row (this closes N11).
   - F-V1: `collapseDuplicates` in `checkBundleLinks`.
   - REL-2: narrow the `build.ts:67` comment.
3. **ADV-1 (P2, pre-existing).** The adversarial seat verified the one-line `previous.run_id !== a.run` refusal against 149 existing tests (82 standalone check, 67 bypass); I did not re-run that. It belongs either in this patch, because it protects the exact guarantee this PR documents, or in a follow-up issue. It is not a regression, so it does not gate this PR on its own.
4. **Follow-ups.** The other P3s (S3 remainder, N5, N6, N8, N10, N12, N13 bin row, N14, N15, F-V2, ADV-2, ADV-3, ADV-4, API-1, MAINT-2) can be follow-up issues.

The core fix is right. Both blockers are closed and proven by revert controls, and the gate is now far stricter than base: every one of the 30 malformed or erase rows is refused on head, while base accepted 8 of them. If Firstmate decides to defer N3 the way N2 was deferred, nothing introduced by this change remains above P3, and this review would pass.

VERDICT: FAIL

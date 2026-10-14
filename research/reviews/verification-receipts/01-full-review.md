# rev-ak126-akr — super-review (full) and fresh evidence for https://github.com/Pibomeister/agent-kit/pull/126

Reviewed head `3281afe979f6eb2d9eba4370a4ff9b2dbd55a0cc` (tree `48cefca6`), comparison base `af962747c2a1f15d1b0b1998f194f37f41de0c11` (origin/main and the merge base). The PR head was checked against `refs/pull/126/head` at the start and again before writing this report, and it had not moved. Everything below was run fresh in this worktree on 2026-10-07 with Bun 1.4.2 and Node v25.6.1 on darwin. Nothing was pushed, commented on or merged.

## Bottom line

The change does what it says for the cases it names. Fresh at this head, the full suite passed apart from one failure that also happens at base. `ak build`, `ak build --check`, the version gate, validate, lint and format all exited 0. The live smoke ran the checkout CLI and both host gates, isolated from every `node_modules` and schema file, under node and bun. In all 24 runs (6 from the checkout CLI, 18 from the bundles) they accepted a valid receipt and refused the five malformed ones; base and the published 0.1.22 gate accepted four of those five.

The panel still returns **changes-requested**:

- **A recorded failure can be erased (fail-open regression).** If a failed receipt carries a defect that only the schema catches, re-recording a passing receipt under the same id makes `check --evidence` exit 0. Base refuses the same sequence as `evidence unstable`. I reproduced it through the head CLI and the isolated bundle (E12).
- **A new hole in the PR's own claim.** The PR says unknown receipt members are now refused, but a receipt can still carry an extra top-level member named after an `Object.prototype` key, such as `constructor`, `toString` or `__proto__`. Base refused those, and the head now passes them. I reproduced it through the real gate.
- **The headline claim has no test.** No test checks that the shipped Node gate refuses a schema-invalid receipt. A bundle whose validator accepts everything passes the whole suite.
- **A gate-build failure can quietly break a local install.** `ak build` deletes `dist/` and rewrites it without `bin/ak-gate.mjs`, while `ak validate` reports 0 errors.

The first item turns a real failure into a pass at the ship gate. The other three let no check pass without evidence. Every fix is specified, and the adversarial seat applied the first one in a copy, where the existing re-record tests still passed. Details are in the findings.

## How the review was run

- **Authority.** I ran the bypass check with the bundle's `ak-gate.mjs` (installed bundle 0.1.22): `bypass check --grant /Users/eduardopicazo/.firstmate-grants/rev-ak126-akr.json --task rev-ak126-akr --phase super-review:full`. It **exited 0**, granting `bypass-rev-ak126-akr-3a951cd56a68` (sha256 `407fe51e…1f73f0`), checked at 2026-10-07T21:28:53Z.
  - The first attempt on a detached head was refused because a grant starts phases only in a branch's current run.
  - So I moved this worktree's own branch `Pibomeister/fm-rev-ak126-akr` to the exact PR head. The run id is `Pibomeister-fm-rev-ak126-akr`.
  - The check writes its use record into the default evidence store under the shared git common dir. The CLI refuses `--dir` with a bypass grant, so that write could not be avoided.
- **Snapshot.** I froze a `git archive` of the head read-only at `.work/review/snapshot/`, together with the base→head diff.
  - Snapshot tree digest: `sha256:96a8b236…42ffe7`.
  - Diff digest: `sha256:23f02055…a32d0a`, 1,384 lines, 22 files, +647/−383.
  - Manifest: `.work/review/snapshot.json`, sha256 `88de109b…b8cae9`.
- **Seat packets.** Every seat got the snapshot, the diff, a requirements file restating the PR's intent as R1–R9 (`.work/review/requirements.md`, sha256 `76d3111c…ffceec0`) and read-only base access.
  - Seats were told not to read the PR body, its comments, commit messages or each other's output, so no seat saw the author's narrative or self-assessment.
  - Each seat ran in its own context and probe directory, and none could edit the snapshot.
- **Seat dispatch failures.** Four seats failed at dispatch (one fast-mode credit error, three rate limits) and were re-seated fresh in new probe directories. The failed first attempts are recorded in `.work/review/seats/dispatch-failures.txt`.
- **Artifacts.** Seat outputs are stored as they returned in `.work/review/seats/*.md`.

### Panel and lane states

| Seat | Why selected | Lane |
|---|---|---|
| correctness | always on | covered: complete, 1 finding |
| project-standards | AGENTS.md and AUTHORING.md declare standards | covered: complete, 3 findings (1 pre-existing) |
| testing | the change alters behavior | covered: complete, 7 findings |
| maintainability | removes the checker, adds two modules and a build path | covered: complete, 5 findings |
| security | receipts are worker-supplied input to the ship gate (a trust boundary); third-party code bundled into a shipped executable | covered: complete, 3 findings |
| adversarial | same trust-boundary evidence | covered: complete, 4 findings |
| reliability | error-handling change (gate-build failure becomes an issue, lazy compile) and raised timeouts | covered: complete, 3 findings |
| api-contract | refusal text from the CLI and the shipped gate is read by super-ship and supervisors | covered: complete, 3 findings |
| agent-native | skipped: no new command or action surface | skipped |
| learnings | skipped: no knowledgebase is registered and there is no lesson corpus to search | skipped |
| data-migration | skipped: `schemas/` unchanged (verified, E9) | skipped |
| performance | skipped: no stated budget and no measured problem at selection time (security later measured S3) | skipped |
| previous-comments | skipped: the PR has 0 comments and 0 reviews | skipped |
| frontend-races, swift-ios | skipped: no such stack | skipped |

**Review verdict: changes-requested.** Fix cycles: 0. Review rounds: 1. The `review-full` gate is **not recorded**, because super-review records it only on `approved`. Nothing inside the review needed approval, so no needs-decision was raised.

Review artifact: `/Users/eduardopicazo/orca/workspaces/agent-kit/fm-rev-ak126-akr/.work/review/review.json`, sha256 `15df551cbb9bad45ece9518a0426008d070ad09092e5221fa2cb34be31baf0ec`. It names every seat output by hash. These worktree files are discarded at teardown, and this report carries their content.

## Findings

Ranking follows each seat's own severity: P0–P1 are blockers, P2 should be fixed, P3 are nits. Findings that share a fingerprint are merged and keep every seat's evidence and severity; I raised or lowered no severity to reconcile seats. Every finding quotes the head line it is about. No seat emitted `safe_auto`.

### Blocker

**B1 — No test checks that the shipped Node gate refuses schema-invalid receipts, so a bundle whose validator accepts everything passes every test.** testing F1, P1, confidence 100, gated_auto, defect.

- **Where:** `tests/lifecycle/check.test.ts:1448`, `test("both byte-identical packaged gates enforce the strengthened evidence cases", () => {`, also `tests/lifecycle/bypass.test.ts:1423/1440` and `tests/lifecycle/build-gate.test.ts:36`. Every receipt these tests feed the bundled gate is schema-valid.
- **Negative control (seat):** the emitted validator was replaced with `() => true`. Then `build-gate.test` passed 2/2, the check.test bundle tests 3/3 and the bypass bundle test 1/1.
- **Today's behavior is correct.** My live smoke (E7b) and the seats' parity probes (testing 3,625 receipts, correctness 6,164 receipts, 0 differences under node and bun) show the shipped gate behaves right now. What is missing is the lock on it, for the property this PR exists to deliver: R1 for the bundles.
- **Fix:** in `check.test.ts`, import the planned `GATE_FILE` and assert its `verificationShapeReasons` equals the source predicate's over the sweep population, under node and bun. Add one `record`/`check` row with `project.repo: null` expecting `evidence malformed`.

**B2 — A failed receipt with a schema-only defect can be erased by re-recording a passing receipt under the same id, so the ship gate passes over a real failure.** adversarial F1, P1, confidence 100, gated_auto, defect.

- **Where:**
  - `src/lifecycle/gate.ts:298` (`storedFailure`): `    boundTo(receipt, snapshot) &&` / `    verificationShapeReasons(receipt).length === 0`
  - read at `gate.ts:551` (`recordGate`): `      return !recorded.has(ref.id) || storedFailure(a.dir, a.run, ref, snapshot);`
- **Cause.** The stricter shape check now also decides which stored failures are sticky. A failed receipt that is schema-invalid is no longer kept, so a passing receipt recorded under the same id replaces it. Being strict about passing evidence fails closed; being strict about failing evidence fails open.
  - Defects the seat used: an absolute `command.cwd`, `created_at` without an offset, and `project.repo: null` (R1's own example).
  - The new refusal for the failure (`malformed … / uncovered`) points the agent at exactly the re-record that erases it.
  - The erasure is written into the verify record, so a later audit cannot see it.
- **My independent reproduction (E12):** record a FAILED receipt with `project.repo: null`, check, re-record a PASSED receipt under the same id with no code change, check again.

  | Gate | Second check |
  |---|---|
  | head source CLI | **exit 0**, `ok: run … has current evidence …` |
  | isolated claude-code bundle (node) | **exit 0**, `ok: run … has current evidence …` |
  | base | exit 1, `refused: evidence unstable: AC-1 has both failed and passed evidence at this head` |

- **Test gap.** The existing test "a failed receipt stays refused after a passing receipt is re-recorded under its id" uses only well-formed failures.
- **Conflicting evidence, kept as conflicting.**
  - The correctness seat saw the same mechanism and filed it only as a residual risk, judging that it follows the existing rule that malformed failures are not trusted.
  - The api-contract seat raised it as a residual risk for other seats.
  - Only the adversarial seat filed it as a finding. It reproduced the base→head outcome change, and so did I.
- **Fix:** drop the `verificationShapeReasons(receipt).length === 0` conjunct from `storedFailure`, so any failed receipt bound to the snapshot stays sticky and keeps refusing as malformed until the code changes. The seat applied this in `probes/adversarial/fixed/`: the defective failure stays refused, and the three existing re-record tests pass (3 pass, 0 fail). Add a regression test for each schema-only defect class.

### Should fix

**S1 — Twelve unknown top-level member names named after `Object.prototype` keys are accepted again.** security S1 (P2, confidence 100) and correctness COR-1 (P3, confidence 100). Shared fingerprint; both severities kept. gated_auto, defect.

- **Where:** `src/lifecycle/gate.ts:721`, `const reasons = validateVerification(value)`, which relies on `schemas/verification.schema.json:230`, `"unevaluatedProperties": false,`.
- **Cause:** ajv's generated check (`if(!props0||!props0[key])`) looks keys up in a plain object, so `constructor`, `__proto__`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString` and the four `__define/lookup{G,S}etter__` names read as already evaluated.
- **Effect:** base refused each one with `unknown member X`, so this contradicts R8. It is reproduced independently in E10:
  - `check --evidence` exits **0** on a receipt carrying `"constructor": 1` or `"toString": "x"`, from both the head source CLI and the isolated claude-code bundle under node.
  - Base refuses both with `unknown member constructor` / `unknown member toString`.
  - The accepted member carries no evidence weight. No current reader uses these names.
- **Fix:** after `if (receipt === undefined) return reasons;`, push `receipt must NOT have unevaluated properties (${key})` for each own key `in Object.prototype`, and add a test that sweeps `Object.getOwnPropertyNames(Object.prototype)`. The correctness seat probed this fix: no verdict changed across 6,164 candidates. Setting ajv's `ownProperties: true` does not fix it (security probe).

**S2 — If the gate fails to build, `ak validate` reports 0 errors and `ak build` deletes `dist/` and rewrites it without `bin/ak-gate.mjs`.** reliability REL-1 (P2, confidence 100, manual) and adversarial F4 (P3, confidence 75, gated_auto). Shared fingerprint; both severities kept. Defect.

- **Where:**
  - `src/packaging/plan.ts:802`: `error("packaging.gate-build-failed", GATE_SOURCE, cause instanceof Error ? cause.message : String(cause)),`
  - `src/packaging/build.ts:71`: `rmSync(outRoot, { recursive: true, force: true });`
  - `src/validation/links.ts:126` drops plan issues.
- **Seat probe:** with a gate.ts broken so the bundle step fails, `validate` exited 0 and `build` exited 1. But `dist/*/bin` held only `ak`, while super-bound, super-build and verify still run `../../bin/ak-gate.mjs`. CI and the pre-push hook refuse on exit 1, so publishing is protected; a local plugin install that points at `dist/` loses its gate.
- **I checked that the PR introduces this for the gate.** `build.ts` and `links.ts` are unchanged. At base, `gateScript(text, …)` ran in-process inside `planAll` without a try, so a failure aborted the build before `writeBundles` reached `rmSync`. The new catch turns the failure into an issue, and the loop then writes. The `bin/ak` maintenance-build path already had this shape.
- **Fix:** in `writeBundles`, plan every host first and return without `rmSync` or any write when any plan issue is an error.

**S3 — The R5 claims (no builder-machine paths, deterministic build) are untested, and the byte-identity assertion passes only because of the in-process cache.** testing F2, P2, confidence 100, gated_auto, defect.

- **Where:** `tests/lifecycle/check.test.ts:1454`, `expect(contents[0]).toBe(contents[1]);`, with `src/packaging/plan.ts:224-225`, `const cached = gateScripts.get(key); if (cached !== undefined) return cached;`.
- **Negative control (seat):** a temp dir, the root and `Date.now()` were embedded in the generated gate, and every bundle and packaging test still passed (3/3 and 132/132).
- **The property holds today.** E8 found 0 path hits in both built gates. The correctness and reliability seats each built the gate twice and the outputs were byte-identical.
- **Fix:** assert the gate contains neither the repo path nor `tmpdir()`, and compare two builds made in separate processes.

**S4 — `packaging.gate-build-failed` (R6) has no test.** testing F3, P2, confidence 100, gated_auto, defect. Standards, reliability and api-contract all reported the same gap.

- **Where:** `src/packaging/plan.ts:802`.
- **Negative control (seat):** the issue was replaced by a silent swallow, and packaging + build-gate tests still passed 134/134.
- **Fix:** add a packaging test on a tree with an unparsable verification schema, expecting the issue and no `GATE_FILE`. Together with S2, assert that `dist/` is left untouched.

**S5 — `build-gate.test.ts` claims schema-derived validation, but asserts only that one valid receipt is accepted, through an export the real gate does not use.** testing F4, P2, confidence 100, gated_auto, defect.

- **Where:** `tests/lifecycle/build-gate.test.ts:29`, `import validate from "./verification-schema.ts";`, and `:36`, `…toEqual({ adapters: ["test-host"], accepted: true });`.
- **Fix:** import `{ verificationValidator }` and also assert that a `repo: null` receipt is rejected.

**S6 (pre-existing, P2) — `bin/ak`, shipped in every bundle, inlines yaml (ISC), fast-uri (BSD-3-Clause), fast-deep-equal and json-schema-traverse (MIT) without their notices.** standards PS-3, confidence 75, manual.

- **Where:** `src/packaging/plan.ts:770`, unchanged. The rule it breaks is in the `LICENCE_FILES` doc comment, `plan.ts:179-184`, which this diff edited: "a build that quietly omits them reports success over a distribution that may not lawfully be distributed".
- **Not introduced by this PR.** This diff covers only the ajv pair for `bin/ak-gate.mjs`, and that part is accurate: the security seat and E8 found that the gate inlines only ajv's `ucs2length` and ajv-formats' `formats`. It is listed because the PR touched the obligation's own text.
- **Fix:** ship the four license texts and extend the NOTICE section to cover `bin/ak`.

### Nits (P3)

| Id | Seat | Finding | Where (quoted at head) | Fix |
|---|---|---|---|---|
| N1 | security S2 (100) | `strict: false` also turns off `strictNumbers`, so `integer` accepts ±Infinity. A failed receipt with `exit_status: 1e400` is no longer malformed; base refused it with `failed command has no integer exit_status`. Reproduced in E10. A passing receipt cannot use this. | `src/lifecycle/verification-schema.ts:9` `new Ajv2020({ strict: false, allErrors: true, … })` | `strictTypes: false, keywords: ["x-validator-rule"]` instead of `strict: false` (the seat compiled this in standalone mode) |
| N2 | security S3 (75) | Validation time grows quadratically in bad array entries (`allErrors`). Reproduced in E11 on the isolated bundle: 25k entries 0.39s, 50k 1.79s, 100k 7.18s (2.5 MB). Base took about 0 ms. It fails closed, but a few-MB receipt can stall a check for minutes. | `verification-schema.ts:9`; receipt reads at `gate.ts:274` and `:861` | refuse receipts above an absolute size (for example 1 MiB) before they reach ajv |
| N3 | standards PS-1 (75) | Two `provenance/` files now ship into `dist/`, but `provenance/` is still denylist-exempt and is still described as never installed. Denylist terms run over both files: 0 hits today. | `plan.ts:193-198`; `src/validation/content.ts:41-42`; rule AUTHORING.md §7 line 861 | scan shipped license files; update the three "never ships" sentences |
| N4 | standards PS-2 (75) | Comments claim the host contracts name the ajv license files; the contracts name only the directory. | `tests/packaging.test.ts:216-220`; `plan.ts:187-189`; rule AUTHORING.md §8 | name both files in both CONTRACT.md trees |
| N5 | api-contract F1 (75) | Conditional-rule refusals became generic ajv text that R8 does not list. For example, `passing command exit_status is not 0` became `/exit_status must be equal to constant` plus `receipt must match "then" schema`, and the not-run case now yields `receipt must NOT be valid`. Nothing parses these strings, but super-ship forwards them to people. | `gate.ts:725` | drop `if` wrapper errors; add `params.allowedValue` to `const` errors |
| N6 | api-contract F2 + maintainability M5 (75) | The `no_criteria` policy refusal reads `supports is invalid`, so an agent that follows the schema's alternative gets a refusal that does not name `no_criteria`. The doc comment says the schema "cannot express" a rule it in fact admits the other way round, which invites deleting the line as redundant. | `gate.ts:718`, `gate.ts:729` `if (receipt.supports === undefined) reasons.push("supports is invalid");` | comment the line as gate policy; append `(no_criteria is not accepted)` when present |
| N7 | reliability REL-2 + testing F6 | The safety claim in this comment is false: a broken schema still crashes every `ak` command (base too), and inside `record`/`check` a compile failure is a stack trace, not a refusal. | `verification-schema.ts:18` `/** Compiled on first use, so a broken schema fails the receipt check rather than every \`ak\` command. */` | reduce to "Compiled on first use." |
| N8 | reliability REL-3 (75) | The gate-bundler subprocess has no timeout, and a failed spawn loses its cause. | `plan.ts:239-241` `{ cwd: root, encoding: "utf8" }` / `throw new Error(built.stderr \|\| "gate build failed")` | `timeout: 120_000`; include `built.error` and the signal |
| N9 | maintainability M1 (75) | The bundled gate replaces `verification-schema.ts` wholesale, and nothing in the file says so; a body change reaches `ak lifecycle` but not the bundle. | `build-gate.ts:26-27`; `verification-schema.ts:18-22` | say so in the doc comment, and keep the export a bare accessor |
| N10 | maintainability M2, M3 (75) | `gateScript`'s `source` argument is only a cache key; the build reads gate.ts from disk. `build-gate.ts` finds the repo root by counting directory levels. | `plan.ts:216-219`; `build-gate.ts:9` `const root = dirname(dirname(dirname(source)));` | drop the parameter and key on the file; `process.cwd()` |
| N11 | maintainability M4 (75) | The ajv options that decide receipt validity are written twice (gate and `ak validate`). | `verification-schema.ts:9`; `src/validation/schemas.ts:61` | one shared options object |
| N12 | testing F5, F7 | Non-object receipts are untested. The predicate test pins ajv error order. NOTICE pins ajv versions that no test checks against the installed packages (they match today: 8.20.0 / 3.0.1). | `gate.ts:729`; `verification-predicate.test.ts:160-163`; `NOTICE:48,51` | as described in each seat output |
| N13 | api-contract F3 (75) | The contract trees mention `bin/ak-gate.mjs` but never list `bin/`; the license files ship even in bundles without the gate. Pre-existing omission. | `adapters/claude-code/CONTRACT.md:27`, `adapters/codex/CONTRACT.md:74` | add `bin/ak-gate.mjs` to both trees |
| N14 | adversarial F2 (100) | A pathological receipt amplifies refusal output: a 301 KB receipt with 100,000 `{}` artifacts produced 10.8 MB of stderr and a 10.8 MB `decisions/*-ship.json` on every check, against 67 chars and 1.7 KB at base. It fails closed. | `gate.ts:726`; joined at `gate.ts:879` `detail: \`receipt ${ref.id}: ${shape.join("; ")}\`` | cap the reasons (first 20 plus "… and N more") |
| N15 | adversarial F3 (75) | The license list is hard-coded, but what gets bundled depends on the schema: adding one `uniqueItems` keyword pulls fast-deep-equal (MIT) into the gate with no notice and no failure. | `plan.ts:193-198`; `build-gate.ts:23` `build.onResolve({ filter: /^ajv(?:-formats)?\// }, …` | record the bundled packages in the build plugin and fail on any outside {ajv, ajv-formats} |

Seat residual risks are not findings, but are worth carrying:

- A checkout gate run as `node src/lifecycle/gate.ts …` now needs `node_modules`, because of the static ajv import. One example is `evals/super-build/_fixtures/scaffold-lib.sh:68-69`.
- The leap-second and `+05` `created_at` values pass the schema, but `Date.parse` returns NaN for them, and base refused them.
- A schema-invalid failed receipt recorded under 0.1.22 is no longer sticky. This is B2 seen from an in-flight run; the seats that filed it as a residual risk read it as consistent with R1.
- The minimum Node version the bundle needs is untested.

## Evidence matrix (fresh at `3281afe9`)

Logs are in `.work/evidence/` in this worktree. The digest is the sha256 of the log file.

| # | Claim | Command | Exit | Key output | Log digest |
|---|---|---|---|---|---|
| E0 | The PR head is the reviewed sha | `git fetch origin pull/126/head`; `git ls-remote origin refs/pull/126/head` (start and end) | 0 | `3281afe979f6eb2d9eba4370a4ff9b2dbd55a0cc` both times | — |
| E1 | Full suite | `AK_REQUIRE_DONORS=1 bun test` (worktree at head, donors cloned by `tools/donors/clone.sh`, 1500s cap not hit) | 1 | `3638 pass, 1 fail, Ran 3639 tests across 117 files [690.60s]`; the only failure is `setup wire: Kimi > a config this runtime cannot read as TOML…`; 0 skips | `8448ebaac85f10e484fdaf6bf2eb642e4a0f3abb2a49d47a3ed73f64a229bee4` |
| E1b | The Kimi failure predates the PR | base `af962747` extract: `bun test tests/learn/setup-wire-hosts.test.ts` | 1 | `26 pass, 1 fail`, the same test | `228d202df051154ef06e5d433252eeacfa063cac001dce72ca667308bb58938e` |
| E2 | Bundles build and are current | clean `git archive` extract (plus an empty `git init` commit) with `.donors/` **copied**: `bun run ak build`; `bun run ak build --check` | 0 / 0 | `0 errors, 0 warnings, 1 note … 0 checks skipped`; install clause: `no ak.install.yaml: default` | `679c5f401aef2bf0847adc4dc4daf518d9bbe7bda95efe4b8025d048a7388f4c` |
| E2b | The version bump clears the published-version gate | from repo root: `tools/publish/version-gate.sh .work/extract/dist` | 0 | built claude-code `0.1.23` vs `origin/published` (`978ad906`) `0.1.22` | `0a704890dcc827065d196f657ae9a1f459047e06afd58fa7ed950b22c65f138c` |
| E3 | Catalog validates | `research/probes/validate-figure.sh 3281afe9` | 0 | `ak validate: 0 errors, 34 warnings, 161 notes, 134 skill-style warnings, 0 checks skipped`; `.donors: copied`; deps symlinked | `aadf7a139e15e207fb0fcc8f9a3b37e8734c01fd8d12ce01f44d3bc2c950fcd4` |
| E4 | The PR's negative control | extract: predicate + build-gate tests; then base `gate.ts` swapped in; then restored | 0 / 1 / 0 | `8 pass 0 fail` → `1 pass 5 fail` → `6 pass 0 fail` (matches the PR) | `b694fb86d235a67af660eb59d0aa0c138b8319083ff7d6de1fc9caa3698e318f` |
| E4b | The PR's "2,926 comparisons" | `bun test tests/lifecycle/verification-predicate.test.ts` parity lines | 0 | 455+458+472+321+1220 = **2926** compared; 6 pass | `68b1f7d8a09fe941e18e20612525ea942096578001eb153d14681151e3a87590` |
| E5 | Lint, ratchet growth, format | `bun run lint`; `bun run lint:growth`; `bun run fmt:check` | 0 / 0 / 0 | `no new violations; 2661 recorded`; `records nothing beyond af962747`; `All matched files use the correct format` | `37557bcd58e2b9e2b52cd0121abcb8c9424924670a31dd59365111c9e8a6ad73`, `fab7decb174c1040ca3da03972a9125869f14aa972cd57e710d3eb3ca762a0ae`, `8ff71fdf28703a169c621739ed1e66d52a3f1118c4fd12708ffaf75faef83868` |
| E6 | Negative control: base and published gates accept the malformed receipts | `.work/smoke/smoke.sh` against base source CLI and installed 0.1.22 `bin/ak-gate.mjs` | — | both: valid→0; repo-null, duration-string, image-number, nested-unknown → **check exit 0 (accepted)**; root-unknown → exit 1 | `22b6803bb231656b1c416de65914c6a25ea0bc61c9b971756d0b90bc035f729e`, `30c186a333e74eb498761a7a33b520d926f717f52e141ec853f29152c0f4b900` |
| E7a | **Live smoke**: head source CLI | `smoke.sh head-source bun src/cli.ts lifecycle` | — | valid → `ok: … current evidence …` exit 0; the 5 malformed cases → exit 1: `/project/repo must be string`, `/command/duration_ms must be integer`, `/environment/image_digest must be string`, `receipt must NOT have unevaluated properties (bogus)`, `/command must NOT have additional properties (extra)` | `cf710b493489e54677744f7f923fc8b094ccad33cf5735ba6d001e2f2ae48f49` |
| E7b | **Live smoke**: both built host gates in isolation | the claude-code and codex `bin/ak-gate.mjs` copied alone into a scratch dir with no `node_modules` in it or any ancestor; claude under node and bun, codex under node | — | 18/18 runs as expected: valid → exit 0, each malformed → exit 1 with the same reasons as E7a | `1612e9b69863d6b25e7cf55879a18e995c7c245f63b83e030cd7b6b8ceb2ba89` |
| E8 | R5: self-contained, identical, no builder paths, licenses | `wc`, `shasum`, `cmp`, `grep -c` over the built gates and license files | 0 | both gates 228,415 bytes, sha256 `9f7f28c8…14e20e73`, identical; 0 hits for the worktree path, `/Users/`, `$HOME`, `/private/`, `/var/folders`, `.work/`; only `node:` imports (the one `require("ajv/…")` string is a literal `.code` property, not a call); both ajv license texts byte-identical to `node_modules`; NOTICE names ajv 8.20.0 / ajv-formats 3.0.1 = installed | `b65c780bbb5f8dc9cda04931d089e7936fc6b07b7263ef46b3b721c14d3fa294` |
| E9 | R2/R7: schema and deps unchanged; versions | `git diff --stat af962747 3281afe9 -- schemas/ bun.lock`; `package.json` diff; catalog | 0 | empty diff for `schemas/` and `bun.lock`; only `"version"` changed in package.json; `package.json` 0.1.23, `catalog.yaml` 0.1.23 | `c93f783d6caaff9567af9f6e630b45c23887a724b0918117f6c75aea14c4c587` |
| E10 | Independent reproduction of S1 and N1 | `.work/smoke/smoke2.sh` (root `constructor`, root `toString`, failed `exit_status: 1e400`) against head source, isolated bundle (node) and base source | — | head (both): constructor → **exit 0**, toString → **exit 0**, Infinity → no `malformed` line; base: `unknown member constructor`, `unknown member toString`, `failed command has no integer exit_status` | `dcf6596153b1a074f22bf067db1a3374ded6429dfcc4129541a6beb1da858db0` |
| E11 | Independent reproduction of N2 | `node time-inputs.mjs <isolated bundle> templates/verification.example.json` (60s cap) | 0 | inputs 12.5k: 53 ms; 25k: 394 ms; 50k: 1,794 ms; 100k: 7,181 ms | `17123c2afe5a8db6174d310b88f0f6c82f70ab4e254bc5426ce223dba3d120b0` |
| E12 | Independent reproduction of B2 (failure erasure) | `.work/smoke/erase.sh` against head source, isolated bundle (node) and base source | — | head (both): failed receipt (`project.repo: null`) → `malformed / uncovered` exit 1; re-record passing, same id → **exit 0 `ok`**. Base: `failed` exit 1 → `unstable` exit 1 | `08b9d664bf3836f2eb1072995a110623be3b3d63d1d3cf7466c53733a4d4c0ca` |

Not re-run: the PR's "original repro: 645 comparisons" uses a script that is not in the tree. Two seats ran stronger independent equivalents instead:

- **correctness:** base predicate vs head over 12,504 receipts. Only 5 were newly accepted (all leap-second `created_at`, schema-valid), and all 3,991 newly refused receipts are schema-invalid. That run did not include the S1 keys; the seat found those separately.
- **testing:** 5,816 receipts, 0 lost base rules on its population.

CI at head was not re-run; I relied on the PR's linked check, which `gh` reports as `1 passed, 0 failed`.

## Coverage limits

- No knowledgebase is registered and the project has no agent-kit project record, so the learnings seat was skipped and no lesson was published. Lessons marked in the panel output: B2, that a validity check reused to decide which failures stay sticky makes failing evidence fail open; S1, that ajv `unevaluatedProperties` treats `Object.prototype` names as evaluated, and B1, that a parity test against the same schema cannot detect a looser validator.
- The installed bundle used for the bypass check and as the published negative control is 0.1.22, the version this PR replaces.
- I did not measure the minimum Node version for the bundle; only Node v25.6.1 was used.
- Super-verify receipts were not produced. The evidence above is plain commands with exit codes, as the brief allows for a scout task. No `review-readiness` lane was run, because only `full` was requested.
- All smoke repositories were throwaway git repos under `.work/smoke/runs/`, and no live production state was touched. The evidence store under the shared git common dir holds only the bypass use record that `bypass check` itself writes.

## Recommendation

Do not merge at `3281afe9`. Send the change back to the ship lane (`ak-predicate-fix`) to fix:

- B2, keep every failed receipt bound to the snapshot sticky, with a regression test per schema-only defect;
- B1, a bundled-gate parity test plus one malformed row;
- S1, the `Object.prototype` key guard plus its sweep;
- S2, plan every host before deleting `dist/`;
- S3–S5, the missing tests.

N1 and N2 are small hardening changes that belong in the same patch. S6 predates this PR and can be its own follow-up. Everything the PR claims that I re-ran fresh reproduced. The core fix is right and far stricter than base, and the remaining work is bounded and fully specified.

VERDICT: FAIL

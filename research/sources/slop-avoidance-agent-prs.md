# Slop Avoidance for Agent-Authored PRs: Detection, Prevention, and a Minimal Reference Setup

For a small delivery team running Claude Code and Codex across client repositories, the best return comes from four cheap measures: deterministic diff-scoped structural gates (cognitive complexity on new or worsened functions, duplication, dead code, import boundaries), a hard size cap enforced by stacked PRs, a spec readiness check with an approved plan-and-assumptions step before coding, and mutation testing scoped to the diff as the check on agent-written tests. LLM reviewers and learned defect-risk models are useful, but the evidence supports running them as advisory signals and escalation triggers, not as merge gates.

## TL;DR

- **Detection:** Enforce structural metrics on the diff, not the repo. The research does not support treating any cognitive complexity threshold as a validated line. LLM code review has low precision in the strongest public benchmark (best F1 19.38% on SWR-Bench) and gives different findings from run to run, so it should raise risk or leave comments and never block by itself. Change size, measured as lines added, is the best cheap defect predictor and should drive the merge-time tier score.
- **Prevention:** Spec completeness has large measured effects. On SWE-Bench Pro, removing the requirements and interface sections cut GPT-5 from 25.9% to 8.4%. Agents are poor at noticing when a task is underspecified, but they gain a lot when made to ask. Require a spec score, a plan, and a list of assumptions a human approves, and cap PR size with stacks so reviews stay effective.
- **Verification:** When an agent writes both the code and the tests, the tests tend to encode what the code does, not what the spec says (Konstantinou et al.). Mutation testing on changed lines (Stryker incremental, mutmut) is the practical check on test strength. For Green/Low-Yellow work, test cases come from the spec's acceptance criteria and must fail before the change and pass after it.

## Key Findings

- Agent code is measurably different from human code in ways CI does not catch. In a difference-in-differences study of 806 Cursor-adopting repositories, adoption produced a transient velocity increase and a persistent 30.3% increase in static analysis warnings and a 41.6% increase in code complexity.\[1\]\[2\] The warnings and complexity in turn predicted later velocity slowdown (He et al., MSR 2026).\[3\] A study of 567 Claude Code PRs across 157 open-source projects found 83.8% were merged versus 91.0% for human PRs, and only 54.9% of merged agent PRs went in without modification (Watanabe et al., TOSEM).\[4\]\[5\]
- Cognitive Complexity has modest empirical support. Muñoz Barón, Wyrich, and Wagner (ESEM 2020) pooled about 24,000 understandability evaluations of 427 snippets (the authors' own figure) and found it correlated with comprehension time and subjective ratings, with mixed results for correctness; they describe CoCo as "the first validated and solely code-based metric which is able to reflect at least some aspects of code understandability." A later replication (Lavazza et al., JSS 2023) found it predicts understandability about as well as older metrics and is not a significant improvement.\[6\] The common default of 15 is a vendor convention (SonarSource), not an empirically derived threshold.\[7\]\[8\]
- Diff-level risk scoring works at Meta's scale. Meta's Diff Risk Score is a fine-tuned Llama model trained on incident history. In RADAR, flagging 10% of diffs catches 60% of incident-causing changes, and RADAR has reviewed 535K+ diffs and landed 331K+.\[9\]\[10\] These are industrial self-reports with selection effects, and a small team cannot reproduce the training data.
- In just-in-time defect prediction, a logistic regression on lines added outperformed the deep models DeepJIT and CC2Vec and trained 81,000 times faster (Zeng et al., ISSTA 2021).\[11\]\[12\] McIntosh and Kamei (TSE 2018) found size properties are the primary predictors and that models decay over time.\[13\] For a small team, size and churn are the defect-propensity model.
- LLM reviewers are inconsistent. On SWR-Bench (1,000 verified PRs), five runs of the same model agreed on only 27 of the defects they detected, and four of the evaluated tools had precision below 10%. Aggregating five runs improved F1 and was cheaper than a single run of a larger model.\[14\]
- Agents rarely detect underspecification on their own. Ambig-SWE (ICLR 2026) found models "struggle to distinguish between well-specified and underspecified instructions", but interaction improved performance by up to 74%.\[15\] An uncertainty-aware multi-agent setup recovered 69.40% on an underspecified SWE-bench Verified variant, versus 70.80% with the fully specified issue.\[16\]
- LLM-generated test assertions tend to capture the implementation's actual behavior rather than its intended behavior.\[17\] Mutation-guided generation at Meta (ACH) produced tests engineers accepted 73% of the time, and Google runs mutation testing only on changed code during review for more than 24,000 developers.\[18\]\[19\]\[20\]

## Details: Detection

### 1. Maximum cognitive complexity and related structural metrics

**What the evidence says.** Cognitive Complexity (CoCo) was designed by SonarSource to measure understandability. It penalizes nesting and breaks in linear flow, not just branch count.\[21\] The main validation (Muñoz Barón, Wyrich, Wagner 2020, peer-reviewed) is a meta-analysis of existing understandability datasets.\[22\] It supports CoCo as a reasonable proxy for time to understand and perceived difficulty, but not for whether readers understand the code correctly. Lavazza et al. (JSS 2023, peer-reviewed) reanalyzed similar data and concluded CoCo "does not appear to fulfill the promise of being a significant improvement over previously proposed measures" for predicting understandability.\[23\] Scalabrino et al.'s work on automatically assessing code understandability (TSE) found that individual code, documentation, and developer metrics correlate only weakly with measured understandability. The consistent reading across this work is that complexity metrics identify code that is likely to be hard, but no threshold separates good code from bad.

The business case for structural health comes mainly from industrial research. Tornhill and Borg's "Code Red" study (TechDebt 2022, 39 proprietary codebases, 30,737 files) found low-quality files had 15 times more defects, took 124% more development time to resolve issues, and had 9 times longer maximum cycle times.\[24\]\[25\] The first author founded CodeScene and the metric is CodeScene's Code Health, so treat this as an industrial report with vendor interest.

**Thresholds in practice.** SonarJS/eslint-plugin-sonarjs `cognitive-complexity` defaults to 15, and the source contains `const DEFAULT_THRESHOLD = 15;`.\[8\] Biome's `noExcessiveCognitiveComplexity` also defaults to 15 and is off by default. complexipy (Python) defaults to 15 ("Functions exceeding this value will be highlighted").\[26\] Ruff has no cognitive complexity rule. It implements McCabe `C901` (default `max-complexity` 10, not enabled by default), and the request to add flake8-cognitive-complexity (issue #2418) is still open.\[27\]\[28\] Ruff's Pylint-derived limits are useful companions: `max-branches` 12 (PLR0912), `max-args` 5 (PLR0913), `max-statements` 50 (PLR0915), `max-nested-blocks` 5 (PLR1702), `max-returns` 6.\[29\]\[30\]\[31\]\[32\]\[33\]\[34\] For TypeScript, oxlint has cyclomatic complexity only, so cognitive complexity comes from Biome, eslint-plugin-sonarjs, or the third-party oxlint-plugin-complexity via jsPlugins.

**Diff enforcement versus whole-repo thresholds.** Legacy client codebases will fail any whole-repo threshold on day one, and agents instructed to "fix lint" will produce unrequested refactors, which are themselves slop. complexipy already has the right semantics built in. `complexipy . --diff main` exits non-zero only when "A new function [is] introduced above the threshold" or "A modified function whose complexity increased and ends above the threshold (including already-over functions that get worse)". Functions that regress but stay under the threshold do not fail.\[26\] complexipy also has a snapshot mode (`--snapshot-create`) that records existing over-threshold functions, blocks new regressions, and drops entries once they are fixed.\[35\] The proposed approach for TypeScript is to reproduce those semantics: run Biome or sonarjs with JSON output on base and head, match functions by file plus qualified name, and fail on (a) new functions over 15 or (b) any function whose score increased and ends above 15. Report, but do not fail on, increases below the threshold. This per-function delta is the complexity/history input to the merge-time rubric.

**Duplication and dead code.** Agents duplicate rather than reuse. Huang et al. ("More Code, Less Reuse", arXiv 2026) found that "LLM Agents frequently disregard code reuse opportunities, resulting in higher levels of redundancy compared to human developers", and an AIDev-based comparison of five agents (arXiv 2607.21832) found "agentic code is retained less frequently than human generated code and is more susceptible to subsequent code churn"; a related study found this varies by vendor, with Codex PRs reverted 6.1% of the time versus 11.5% for human PRs and 14.5% for Devin. jscpd defaults to `--min-tokens 50` and `--min-lines 5`, and `--threshold` fails the run when duplication reaches a set percentage. jscpd v5 supports a committed baseline so builds fail only on clones added since.\[36\]\[37\] Run it on changed files against the whole repo so copies of existing code are caught. knip finds unused files, exports, and dependencies in TypeScript ("unused files = project files - (entry files + resolved files)").\[38\] Unused exports in a diff are a strong signal of speculative scope or abandoned approaches. vulture does the same for Python with confidence scores from 60% to 100%.\[39\] Use `--min-confidence 80` or higher in CI and keep a whitelist file.\[40\]

**Tool choice.** SonarQube/SonarCloud and CodeScene provide these metrics, PR decoration, and new-code-only gates. They pay off when the team wants dashboards across many client repositories. Everything above can also run on free CLI tools in under a minute.

### 2. Semantic linters

**Non-LLM semantic analysis.** This is the deterministic layer and it can block merges. Type-aware ESLint rules (`@typescript-eslint/no-floating-promises`, `no-misused-promises`, `strict-boolean-expressions`, `switch-exhaustiveness-check`) catch agent defects that tests often miss, especially dropped promises in NestJS and Next.js server code. Architecture rules catch "inconsistent patterns" mechanically:

- dependency-cruiser has `forbidden`/`allowed`/`required` rules, `circular` detection, `orphan` and `reachable` conditions, and a known-violations baseline for legacy code.\[41\]
- eslint-plugin-boundaries (v7) uses `boundaries/dependencies` as its canonical rule. `element-types` is a deprecated alias.\[42\]
- import-linter (Python) has `layers`, `forbidden`, and `independence` contracts, each with `ignore_imports`.\[43\]

Semgrep custom rules are the cheapest way to encode client-specific prohibitions, for example "no raw SQL outside the repository layer" or "no `fetch` outside the API client". CodeQL adds taint tracking for injection classes. It is worth running on repositories with PII or payments, where it also feeds the sensitivity override.

**LLM linters with natural-language rules.** These include lentil (SARIF output), Continue checks, CodeRabbit/Greptile/Copilot custom instructions, Claude Code review, and Semgrep Assistant. They are the only practical way to check rules like "don't add configuration options the ticket didn't ask for" or "use the existing `Result` helper instead of throwing". The evidence on their reliability is sobering:

- SWR-Bench (FSE 2026, peer-reviewed) evaluated LLM review on 1,000 manually verified real PRs with full repository context. The best configuration reached F1 19.38%, four tools had precision under 10%, and some produced more than 7 false positives per PR. Recall fell from 38.35% on PRs with one real issue to 8.88% on PRs with five or more. Across five runs of the same model, only 27 detected issues overlapped. The authors classified 48% of sampled false positives as lack of context from the surrounding code. Tools were better at functional defects than at style or maintainability suggestions.\[14\]
- A zero-temperature study (Measuring Determinism in LLMs for Software Code Review, 2025) found models still produce different reviews for identical input.\[44\]
- In industrial settings, Cihan et al. (Beko) found developers marked 73.8% of automated comments "Resolved", but they complained about redundant comments on every re-review.\[45\]\[46\] Goldman et al., as cited in a 2026 study of developer responses to agent-generated review comments, found that "approximately 60–70% of LLM-generated comments remain unresolved."
- Hybrid designs help. In a Tencent study, combining static analysis with LLM triage eliminated 94–98% of static-analyzer false positives.\[47\] G-Research reports (an industrial blog post) that a second LLM pass to confirm findings, and validating every finding against an explicit rule index, made their standards checker usable in CI.\[48\]

**Using nondeterministic checks safely (proposals, grounded in the above).**

1. Advisory by default. LLM findings are posted as SARIF annotations or review comments, not failing checks.
2. Raise-only. An LLM finding can move a PR up a tier (Green to Yellow) or require human review. It can never clear a deterministic failure or move a PR down a tier.
3. Aggregation for anything that affects tiering. SWR-Bench found that aggregating n=5 runs was the best cost/benefit point: Gemini-2.5-Flash with five-run self-aggregation beat single-pass Gemini-2.5-Pro at lower cost.\[14\] Accept a finding into scoring only if it appears in a majority of runs, or survives a separate verification pass that must cite the rule and line.
4. Narrow rules. Every natural-language rule should name what it checks, include examples of violations and non-violations, and be scoped by path. Track acceptance rate per rule, and retire or rewrite any rule with acceptance below about 50% after 30 findings.
5. Keep the LLM reviewer's model family different from the authoring agent where practical, and never let it see the author agent's own justification as the ground truth.

### 3. Risk detection

**What exists.** Meta's Diff Risk Score (DRS) is described on Meta's engineering blog (industrial report) as a fine-tuned Llama that predicts the likelihood of a diff causing a production incident. It lets lower-risk diffs land during code freezes: "we landed 10,000+ code changes (that previously could not have landed during a freeze) with minimal production impact".\[49\] The RADAR paper (arXiv 2026, Meta authors) describes a funnel that classifies diffs by authorship and source, then applies eligibility gates, static heuristics, DRS, an LLM review agent, and deterministic validation before auto-landing:\[10\]\[50\]

- DRS is "optimized for high recall at a given percentage of diffs flagged: for example, flagging 10% of diffs while catching 60% of PI-causing changes".\[9\]
- The default auto-accept threshold is P5, meaning only the lowest-risk 5% of diffs qualify. The LLM reviewer must report confidence of at least 8/10 with every change classified into a safe category, and any risk signal disqualifies the diff.\[51\]\[52\]
- Relaxing the threshold from P25 to P50 raised the approve rate to 60.31%. RADAR-reviewed diffs have one-third the revert rate and one-fiftieth the incident rate of non-RADAR diffs.\[10\]\[50\]
- Those rate comparisons are between diffs selected as low-risk and all other diffs, so they show the funnel is not letting risky changes through. They do not show that automated review is safer than human review.
- Meta reports that agentic AI accounts for over 80% of its recent growth in diff volume.\[10\] That is why the pipeline treats AI-generated diffs as their own source type and scrutinizes each one ("Conditional AutoAccept").\[9\]\[10\]

The open-source equivalent, DRS-OSS (arXiv 2025), fine-tunes Llama 3.1 8B on the ApacheJIT benchmark. It reports that gating the riskiest 30% of diffs would catch 86.4% of defect-inducing changes. It has not been evaluated on whether gating reduces post-merge defects in a live project.\[53\]\[54\]

**What a small team should build instead (proposal).** Write a risk manifest per client repository. It is a YAML file mapping path globs and content patterns to sensitivity classes, and it reuses CODEOWNERS for ownership. Examples:

- `**/auth/**`, `**/payments/**`, `migrations/**`, and files importing `crypto`, `stripe`, `jsonwebtoken`, or `bcrypt` are hard-override classes.
- Content patterns include new `DROP`/`ALTER ... DROP`/`TRUNCATE` in SQL, `dangerouslySetInnerHTML`, raw query builders, new environment variables, and changes to CI or IaC files.
- Add CodeQL or Semgrep taint findings on PII sources.

A GitHub Action evaluates the manifest on the actual diff, writes a check run with the computed sensitivity class, and requests CODEOWNERS review when an override fires. Branch protection requires that check. An LLM diff classifier ("does this diff touch authentication, authorization, money movement, or data deletion semantics even if paths don't match?") adds recall for semantic matches the path rules miss. Under the raise-only rule it may add a class but never remove one. This is the sensitivity and blast-radius input to the rubric, and it is deterministic enough to block merges.

### 4. Defect propensity scoring

**Research baseline.** Kamei et al. (TSE 2013) established just-in-time (JIT) defect prediction using change-level features: size, diffusion, history, and author experience. McIntosh and Kamei (TSE 2018) showed that the properties of fix-inducing changes shift over a project's life, so models decay. Size properties were the primary contributors, and models should be trained on past commits and evaluated on later ones.\[13\]\[55\] Deep models followed (DeepJIT, CC2Vec, JITLine, JIT-Fine, and LLM-based classifiers such as DRS-OSS). Zeng et al. (ISSTA 2021) re-evaluated DeepJIT and CC2Vec on 310K commits and found a logistic regression on lines added (LApredict) outperformed both, was 81,000/120,000 times faster to train and test, and did not lose accuracy across projects.\[56\]\[57\] Later work (e.g. JIT-Fine, DRS-OSS) reports gains over LApredict on specific benchmarks, but the margin over size-only baselines is modest compared with the cost.

**Label noise.** All of these models are trained on SZZ-derived labels, which trace fix commits back to the commits that introduced the bug. SZZ has documented precision and recall problems: refactorings, cosmetic changes, and fixes that only add code produce false links or no links.\[14\] Da Costa et al. (TSE 2017) and Rosa et al.'s developer-informed evaluation of SZZ variants (JSS 2023) quantify this.\[14\]\[58\] For client repositories with sparse issue linking, labels will be worse than in the research datasets.

**What is practical.** A small team with at most a few hundred labeled incidents per client cannot train a useful learned model per repository, and cross-project models transfer only partly. The practical defect-propensity score (proposal) is a transparent formula:

- change size in non-test, non-generated lines added,
- diffusion (files and directories touched),
- hotspot overlap: the fraction of changed lines in files that are in the repository's top decile of churn × complexity over the last 6–12 months, computed from `git log --numstat` plus a complexity tool, or taken from CodeScene where licensed,
- prior fix density of the touched files: commits whose messages match fix/bug/revert, as a crude SZZ-free proxy,
- the per-function complexity delta from section 1.

Weight these by hand, calibrate them quarterly against reverts and escaped defects, and use the result only to move items between Green and Yellow.

**Transfer to agent-authored code.** No published study validates defect models trained on human commits against agent-authored commits. There are three reasons to expect partial transfer only. First, author-experience features are meaningless for agents. Second, agents produce more redundant code and larger diffs, which shifts the size distribution. Third, agent failures skew toward misread requirements, which no code-change feature captures: in SWE-Bench Pro trajectories, "wrong solution" was the largest failure bucket for Claude Opus 4.1.\[59\] Meta's response was to add authorship and source type as explicit routing features rather than trust one model across both populations.\[10\]\[50\] Recommendation: record `author_kind` (human, Claude Code, Codex) on every PR from day one, so that after 6–12 months you can check whether your score's calibration differs by author kind.

## Details: Prevention

### 5. Spec scoring

**Evidence that spec quality drives agent success.** SWE-Bench Pro (Scale AI, arXiv 2025) augments each task with a problem statement, a requirements list, and an interface section that names the expected classes, functions, and file paths.\[60\] In the ablation, GPT-5 (high) fell from 25.9% to 8.4% and Claude Opus 4.1 from 22.7% to 8.2% when given only the problem statement. The authors attribute part of this to verification: without the named interface, a correct solution can fail tests that expect particular names.\[59\] Both effects matter for client work. A ticket that does not name the interface produces code that is plausible but does not match what the reviewer and the tests expect. The same authors note that heavy augmentation "may inadvertently make problems too prescriptive".\[60\] Specs should state behavior and interfaces without prescribing implementation.

**Requirements quality research.** ISO/IEC/IEEE 29148 lists quality attributes for individual requirements: necessary, appropriate, unambiguous, complete, singular, feasible, verifiable, correct, conforming. Smell detectors operationalize some of these. Femmer et al.'s Smella (JSS 2017) detected requirements smells (weak words, vague pronouns, comparatives, loopholes) with 59% precision and 82% recall in industrial cases.\[61\]\[62\] Paska (Veizaga et al., TSE 2024) detected smells in 2,725 requirements from 13 financial systems with 89% precision and recall.\[63\]\[64\] Both are rule- and NLP-based and cheap. LLMs can do the same job with less setup but with the same nondeterminism caveats as LLM review.

**A ticket readiness score (proposal).** Score each item from 0 to 2 on six criteria. A total of 9 or more out of 12, with no zeros on the first three, is required for Green.

| Criterion | 0 | 1 | 2 |
|---|---|---|---|
| Acceptance criteria | None | Present but untestable ("fast", "clean") | Each criterion checkable by a test |
| Interfaces named | None | Area named | Files, functions/routes, types, or schema named |
| Examples | None | Happy path only | Happy path plus at least one edge or error case |
| Non-goals / out of scope | None | Implicit | Explicit list |
| Existing pattern referenced | None | "Follow conventions" | Link to the file or module to imitate |
| Verification path | None | "Add tests" | Named test level (unit, contract, e2e) and fixture/data source |

Compute the score with a deterministic smell pass (a word list for "fast", "user-friendly", "etc.", "and/or", "as needed", "should support", plus checks for missing sections) and one LLM pass that proposes scores and missing items. A human confirms the score. The spec clarity factor in the rubric is this score. Spec-driven tools such as GitHub Spec Kit and Kiro produce specification, plan, and task artifacts that fit this template. Adopt them if the team prefers their workflow. The criteria above are what matters, not the tool.

### 6. Ambiguity avoidance

**Research.** The research consistently finds that agents can ask useful questions but do not reliably decide when to ask:

- Ambig-SWE (Vijayvargiya et al., ICLR 2026) found models struggle to tell well-specified from underspecified SWE-bench tasks, but that interaction improved performance by up to 74% over non-interactive runs.\[15\]
- ClarEval (2026) found agents readily detect missing information but "struggle to recognize when existing terms are vague or underspecified (e.g., 'fast', 'clean up', 'user-friendly')". On its HumanEval-derived tasks, GPT-4o dropped from 89.02% to 8.94% under ambiguity.\[65\]
- Richter and Papadakis (arXiv 2607.01953, July 2026) found models often exhibit "detrimental semantic collapse". Given the same ambiguous task repeatedly, they converge on one wrong interpretation instead of producing varied answers, so sampling multiple runs does not reveal the ambiguity. This affected over 10% of MBPP tasks, 3% of HumanEval, and 32% of LiveCodeBench, and deliberately injecting underspecification raised the rate more than fivefold.
- "Ask or Assume?" (2026) found an uncertainty-aware multi-agent scaffold on Claude Sonnet 4.5 recovered 69.40% on underspecified tasks, versus 70.80% fully specified, and asked more often on harder tasks.\[16\]\[66\]
- ASPI (2026) found that the clarification state increases prompt-injection vulnerability.\[67\] Any automated answering of an agent's questions from repository or ticket content is an attack surface.

**Practice (proposal).** Do not rely on the agent deciding to ask. Make the question step mandatory and structural:

1. Before editing, the agent writes `PLAN.md` in the PR or ticket. It lists the files to change, the interfaces it will add or change, the tests it will write mapped to acceptance criteria, an explicit **Assumptions** list, **Open questions**, and **Out of scope**.
2. A human approves the plan. Any assumption that changes behavior visible to users or API consumers must be converted into an acceptance criterion or a non-goal before coding starts. Claude Code's plan mode and Codex's ask/approval modes support this directly.
3. The approved plan is committed with the PR. The merge-time LLM check compares the diff against it ("files touched outside plan", "new public interfaces not in plan") to detect unrequested scope. This comparison is deterministic enough to be a raise-only signal.
4. The definition of ready requires the spec score threshold above plus an approved plan. Items that fail go back to the ticket author, not to an agent that will fill the gaps with guesses.

### 7. Stacked PRs

**Evidence on size.** Rigby and Bird's cross-project work found review effectiveness declines as patch size grows.\[68\] Small changes are one of the convergent practices of modern code review.\[69\] At Google, Sadowski et al. (ICSE-SEIP 2018) report median time to first feedback under an hour for small changes and about 5 hours for very large ones, with overall median review latency under 4 hours.\[70\] The agent-specific evidence points the same way. On SWR-Bench, LLM reviewer recall fell from 38.35% to 8.88% as the number of issues per PR rose.\[14\] SWE-Bench Pro resolve rates fall sharply as the number of files touched increases.\[59\] Lines added is the strongest single JIT defect predictor.\[71\] Small PRs are therefore easier to review for both humans and LLMs, less likely to contain defects, and more likely to be solved by the agent.

**Tooling.** Stacked diffs are standard at Meta (Phabricator, now Sapling) and Google ("chained" CLs in Critique).\[72\]\[73\] On GitHub the options are Graphite, ghstack, git-town, git-branchless, and Jujutsu. GitHub released a Stacked PRs preview in April 2026.\[74\] For agents, the simplest reliable mechanism (proposal) is to have the agent produce the plan as an ordered list of PRs, each with its own acceptance criteria and test, and implement each on a branch based on the previous one using `gt create` or `jj new`. Each PR must pass CI on its own.

**Sizing and ordering rules (proposal, starting defaults):**

- At most about 400 changed non-test, non-generated lines and at most about 10 non-test files per PR. Lockfiles, snapshots, and generated clients are excluded. Above that, the size factor pushes the item to Yellow.
- Order the stack: (1) pure refactor or extraction with no behavior change, verified by existing tests passing unchanged; (2) schema **expand** (additive migration, nullable columns, new tables), deployable alone; (3) backend behavior behind a flag; (4) frontend or API consumer; (5) backfill; (6) schema **contract** (drop old columns) as a separate, later, human-reviewed PR, because irreversible migrations are a hard override.
- Each PR description states which acceptance criteria it satisfies, so partial merges leave the system in a defined state.

**Failure modes.** Rebase churn when a lower PR changes under review: use tools that restack automatically (Graphite, jj) and let the agent do the restack, then re-run CI on the whole stack. Partial merges that strand dead code: knip/vulture and the "files outside plan" check catch this. Reviewers approving each piece without seeing the whole: link the plan in every PR and require one reviewer to approve the stack top-to-bottom. Stacks deeper than about 5 PRs increase coordination cost. That usually means the ticket should have been split into separate tickets.

### 8. Unit and e2e tests as a means to achieve confidence

**The core problem.** When the same agent writes code and tests, the tests are checked against the implementation, not against the spec. Konstantinou et al. (2024) found that LLMs "are prone to generate test oracles that capture the actual program implementation rather than the expected one", with a measurable drop in accuracy when the implementation is buggy.\[17\]\[75\] SeGa (2026) derived tests from product requirement documents instead of code and exposed 29 of 60 real business-logic bugs, versus 4–7 for code-centric LLM test generators.\[76\] Tautological tests, snapshot-everything tests, and mocks of the unit under test all follow from this. Coverage cannot detect any of them.

**Mutation testing as the check.** Mutation testing injects small faults and checks whether any test fails. It measures whether the assertions actually constrain behavior.

- Google's system mutates only changed lines during code review, suppresses mutants in "arid" (uninteresting) code, limits mutants per line, and surfaces surviving mutants as review comments rather than as a score. It is used by more than 24,000 developers on over 1,000 projects (Petrović et al., TSE 2021, peer-reviewed industrial).\[20\]\[77\]\[78\]\[79\]\[80\]
- Meta's ACH (FSE 2025 industry track) uses an LLM to generate a small number of relevant mutants for a specific concern, then generates tests that kill them. It was applied to 10,795 Android Kotlin classes, generating 9,095 mutants and 571 tests. Engineers accepted 73% of the tests, and 36% were judged privacy-relevant. Its LLM equivalent-mutant detector reached 0.95 precision and 0.96 recall after simple preprocessing.\[18\]\[81\]

For this stack, StrykerJS supports `--incremental` (since 6.2). It stores results in `reports/stryker-incremental.json` and does "a git-like diff of your code and test files" to reuse prior results. It does not detect changes in dependencies, environment variables, or `.snap` files, and Jest gives it the most precise per-test reuse.\[82\] Thresholds default to `{ high: 80, low: 60, break: null }`, so builds never fail until you set `break`.\[83\] For Python, mutmut and cosmic-ray can be scoped to changed files.

**Diff coverage versus mutation score.** Diff coverage (for example `diff-cover` at 80% of changed lines) is cheap and catches missing tests. It cannot catch assertion-free or tautological tests. Mutation score on changed lines catches both. Proposal: require diff coverage at least 80% as a blocking check everywhere. Require diff mutation score as blocking only for Green items where the agent wrote the tests, starting advisory at 60% and moving to a 70% block once the team has a month of baseline. Post surviving mutants as review comments in Google's style, because a specific surviving mutant ("changing `>=` to `>` on line 42 breaks no test") is actionable and a score is not.

**Other test practices.**

- **Fail-before/pass-after.** CI checks out the base commit plus only the new test files and requires that the new tests fail, then pass on head. This is the same fail-to-pass check SWE-Bench uses to validate tasks.\[60\] It rejects tests that pass regardless of the change and costs one extra test run on the changed test files.
- **Property-based tests.** fast-check (TypeScript) and Hypothesis (Python) are worth requiring for parsers, money arithmetic, date handling, and serialization, where agents most often pass example tests while missing edge cases.
- **Contract tests.** Pact, or OpenAPI schema checks via Schemathesis for FastAPI, belong on any PR that changes an API consumed by another service or client.
- **Playwright e2e on critical paths only.** Login, checkout, and the two or three flows each client considers critical. These are human-owned and not rewritten by agents, which may add new e2e tests but not modify existing ones without human approval.
- **Flaky tests.** Quarantine automatically on a pass-on-retry pattern and track them in a list. Do not let agents "fix" a flaky test by loosening assertions. That should be caught by a diff check that flags removed or weakened `expect`/`assert` lines.
- **Separation of test author and code author.** Strongest option: the human writes the acceptance tests from the spec before implementation. Practical option: a separate agent session that sees only the spec, `PLAN.md`, and interface signatures (no implementation) writes the acceptance tests first. They are committed as the first PR of the stack and must fail. The implementing agent may add unit tests but may not modify the acceptance tests without an explicit, reviewed change. This follows the requirement-derived oracle approach that performed best in the studies above, and Meta's catching-test work reports that automated true/false-positive assessors reduced human review load for generated tests by 70%.\[84\]

## Recommendations: Reference Setup

**Where each check runs (proposals; thresholds are starting defaults to calibrate).**

| Stage | Check | Threshold / behavior | Rubric factor | Latency / cost |
|---|---|---|---|---|
| Ticket time | Spec readiness score (smell pass + LLM proposal + human confirm) | ≥9/12, no zero on AC/interfaces/examples for Green | Spec clarity | Seconds; cents |
| Ticket time | Approved `PLAN.md` with assumptions, open questions, stack plan | Required for Green/Low Yellow | Spec clarity, size | Human minutes |
| Agent loop / pre-commit | oxlint/Biome, type-aware ESLint subset, Ruff, `tsc --noEmit`, mypy/pyright on changed files | Must pass | — | <30 s |
| Agent loop | Diff cognitive complexity (Biome/sonarjs delta script; complexipy `--diff`) | New fn >15 or worsened-and-over-15 fails | Complexity/history | <30 s |
| CI blocking | Risk manifest + CODEOWNERS + Semgrep/CodeQL taint on sensitive repos | Hard override → human owner review | Sensitivity, blast radius | 1–5 min |
| CI blocking | dependency-cruiser / eslint-plugin-boundaries / import-linter | No new violations (baseline known) | Consistency | <1 min |
| CI blocking | jscpd on changed files vs repo; knip; vulture ≥80 | No new clones ≥50 tokens; no new unused exports/files | Complexity (duplication, scope) | <1 min |
| CI blocking | Diff coverage ≥80%; fail-before/pass-after on new tests; no weakened assertions | Must pass | Verification strength | 1 extra test run |
| CI blocking | PR size cap | >400 LOC or >10 files → Yellow | Size/diffusion | Free |
| CI advisory → blocking | Stryker incremental / mutmut on changed lines | Advisory 60%, later block 70% for agent-tested Green | Verification strength | 2–15 min |
| CI advisory | LLM review with narrow NL rules, 3–5-run aggregation or verification pass | Raise-only; comments via SARIF | All (raise-only) | ~1 min; SWR-Bench measured well under $0.01 per PR for a Flash-class model with 5-run aggregation |
| CI advisory | LLM plan-conformance check (files/interfaces outside `PLAN.md`) | Raise-only | Scope | <1 min |
| Merge time | Tier re-score on actual diff: size, hotspot overlap, complexity delta, sensitivity class, mutation result, LLM raises | Green auto-eligible for single-reviewer merge; Yellow needs owner | All | Seconds |
| Nightly | Playwright critical-path e2e, full mutation run on hotspots, flaky quarantine | Failures open tickets | Verification strength | Off the PR path |

**Worth it for a small team now:** the diff complexity gate, the size cap with stacks, knip/jscpd/vulture, boundary rules, the risk manifest, diff coverage plus fail-before/pass-after, the spec score and plan approval, and incremental mutation testing on changed code. All are free or nearly free, deterministic, and fast.

**Worth it with caveats:** LLM review with custom rules, as long as it is advisory and raise-only and rules are pruned on acceptance rate. CodeQL on repositories with PII or payments. CodeScene or SonarQube if you need cross-client dashboards.

**Only pays off at scale:** learned JIT or DRS-style models (you need thousands of labeled changes per repo and ongoing retraining because of model decay), auto-landing funnels like RADAR, and LLM-generated mutants à la ACH beyond a specific high-value concern such as authorization or PII handling.

**Measuring whether the setup reduces slop.** Record `author_kind`, tier at ticket time, tier at merge, and which checks fired on every PR. Track monthly, per client and per author kind:

- rework rate: follow-up commits touching the same lines within 30 days,
- revert rate,
- escaped defects linked to PRs,
- human review comments per 100 changed lines and time to first review,
- percentage of PRs over the size cap,
- median diff mutation score,
- the repo-level trend of functions over the complexity threshold and duplicated-line percentage, which should fall or stay flat, unlike the 41.6% complexity increase in the Cursor study,
- LLM finding acceptance rate per rule,
- the fraction of tickets bounced at readiness.

Before-after comparisons within one client are confounded by project phase. Where possible, roll the setup out to clients in a staggered order and compare against clients not yet onboarded, which is the same design the Cursor study used.

## Caveats

- Much of the strongest evidence is industrial self-report (Meta DRS/RADAR/ACH, Google mutation testing, CodeScene's Code Red) or recent arXiv preprints from 2025–2026 not yet peer-reviewed (RADAR, DRS-OSS, Ambig-SWE variants, ClarEval, ASPI). The peer-reviewed core is Muñoz Barón et al., Lavazza et al., Kamei et al., McIntosh and Kamei, Zeng et al., Petrović et al., Sadowski et al., Paska, Smella, SWR-Bench (FSE 2026), the Cursor study (MSR 2026), and Watanabe et al. (TOSEM).
- RADAR's revert and incident comparisons are between risk-selected and non-selected diffs. They show the funnel selects safely, not that automated review beats human review.
- The SWE-Bench Pro ablation mixes two effects, harder task understanding and test false negatives from mismatched names. The size of the effect on real client work is unknown, but its direction is consistent with the ambiguity research.
- Several agent benchmarks (ClarEval, Ambig-SWE) use synthetic underspecification of existing tasks. Real ticket ambiguity may be subtler.
- No study yet validates human-trained defect predictors on agent-authored changes. The recommendation to log `author_kind` is so you can answer that question with your own data.
- All numeric thresholds in the reference setup (15, 400 lines, 80% diff coverage, 60–70% mutation score, 9/12 spec score) are starting proposals from tool defaults and judgment, not empirically optimal values. Calibrate them against your own revert and rework data after one or two quarters.
- Model versions change quickly. Benchmark numbers cited here refer to the models evaluated in each paper, and LLM-reviewer precision should be re-measured on your own PRs whenever you switch models.

## Sources

1. [Speed at the Cost of Quality: How Cursor AI Increases Short-Term Velocity and Long-Term Complexity in Open-Source Projects | alphaXiv](https://www.alphaxiv.org/abs/2511.04427)
2. [Speed at the Cost of Quality | Proceedings of the 23rd International Conference on Mining Software Repositories](https://doi.org/10.1145/3793302.3793349)
3. [\[2511.04427\] Speed at the Cost of Quality: How Cursor AI Increases Short-Term Velocity and Long-Term Complexity in Open-Source Projects](https://arxiv.org/abs/2511.04427)
4. [\[Quick Review\] On the Use of Agentic Coding: An Empirical Study of Pull Requests on\\n GitHub](https://liner.com/review/on-use-agentic-coding-empirical-study-pull-requests-on-github)
5. [\[2509.14745\] On the Use of Agentic Coding: An Empirical Study of Pull Requests on GitHub](https://arxiv.org/abs/2509.14745)
6. [An Empirical Validation of Cognitive Complexity as a Measure of Source Code Understandability | Request PDF](https://www.researchgate.net/publication/347506632_An_Empirical_Validation_of_Cognitive_Complexity_as_a_Measure_of_Source_Code_Understandability)
7. [eslint-plugin-sonarjs/docs/rules/cognitive-complexity.md at master · SonarSource/eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs/blob/master/docs/rules/cognitive-complexity.md)
8. [eslint-plugin-sonarjs/src/rules/cognitive-complexity.ts at master · SonarSource/eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs/blob/master/src/rules/cognitive-complexity.ts)
9. [Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency](https://arxiv.org/html/2605.30208v1)
10. [Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency](https://arxiv.org/abs/2605.30208)
11. [Deep Just-in-Time Defect Prediction: How Far Are We? | NSF Public Access Repository](https://par.nsf.gov/biblio/10273272-deep-just-time-defect-prediction-how-far-we)
12. [GitHub - ZZR0/ISSTA21-JIT-DP: This repo illustrates how to evaluate the artifacts in the paper Deep Just-in-Time Defect Prediction: How Far Are We? published in ISSTA'21.](https://github.com/ZZR0/ISSTA21-JIT-DP)
13. [(PDF) Are Fix-Inducing Changes a Moving Target? A Longitudinal Case Study of Just-In-Time Defect Prediction](https://www.researchgate.net/publication/316079420_Are_Fix-Inducing_Changes_a_Moving_Target_A_Longitudinal_Case_Study_of_Just-In-Time_Defect_Prediction)
14. <https://arxiv.org/pdf/2509.01494>
15. [Ambig-SWE: Interactive Agents to Overcome Underspecificity in Software Engineering](https://arxiv.org/pdf/2502.13069)
16. [Paper page - Ask or Assume? Uncertainty-Aware Clarification-Seeking in Coding Agents](https://huggingface.co/papers/2603.26233)
17. [Do LLMs generate test oracles that capture the actual or the expected program behaviour?](https://arxiv.org/pdf/2410.21136)
18. [Mutation-Guided LLM-based Test Generation at Meta Christopher Foster](https://arxiv.org/pdf/2501.12862)
19. [Practical Mutation Testing at Scale: A view from Google](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/)
20. [arxiv.org](https://arxiv.org/pdf/2102.11378v1)
21. [SonarComplexity – Open VSX Registry](https://open-vsx.org/extension/kevinjshah2207/sonar-complexity)
22. [\[2007.12520\] An Empirical Validation of Cognitive Complexity as a Measure of Source Code Understandability](https://arxiv.org/abs/2007.12520)
23. [An empirical evaluation of the “Cognitive Complexity” measure as a predictor of code understandability | Journal of Systems and Software](https://dl.acm.org/doi/10.1016/j.jss.2022.111561)
24. [\[2203.04374\] Code Red: The Business Impact of Code Quality -- A Quantitative Study of 39 Proprietary Production Codebases](https://arxiv.org/abs/2203.04374)
25. [Code red: the business impact of code quality](https://dl.acm.org/doi/10.1145/3524843.3528091)
26. [Usage Guide - complexipy](https://rohaquinlop.github.io/complexipy/usage-guide/)
27. [Implement \`flake8-cognitive-complexity\` · Issue #2418 · astral-sh/ruff](https://github.com/astral-sh/ruff/issues/2418)
28. [Add a hard per-function complexity gate (ruff C901) · Issue #1135 · PaloAltoNetworks/shifter](https://github.com/PaloAltoNetworks/shifter/issues/1135)
29. [too-many-branches (PLR0912) | Ruff - Astral Docs](https://docs.astral.sh/ruff/rules/too-many-branches/)
30. [too-many-statements (PLR0915) | Ruff - Astral Docs](https://docs.astral.sh/ruff/rules/too-many-statements/)
31. [too-many-arguments (PLR0913) | Ruff - Astral Docs](https://docs.astral.sh/ruff/rules/too-many-arguments/)
32. [too-many-return-statements (PLR0911) | Ruff - Astral Docs](https://docs.astral.sh/ruff/rules/too-many-return-statements/)
33. [too-many-nested-blocks (PLR1702) | Ruff](https://docs.astral.sh/ruff/rules/too-many-nested-blocks/)
34. [Settings | Ruff](https://docs.astral.sh/ruff/settings/)
35. [complexipy/docs/index.md at main · rohaquinlop/complexipy](https://github.com/rohaquinlop/complexipy/blob/main/docs/index.md)
36. [jscpd configuration in MegaLinter - MegaLinter by OX Security](https://megalinter.io/8/descriptors/copypaste_jscpd/)
37. [jscpd - Copy/Paste Detector for Source Code](https://jscpd.dev/)
38. [Resolve reported issues | Knip](https://knip.dev/guides/handling-issues)
39. [GitHub - jendrikseipp/vulture: Find dead Python code · GitHub](https://github.com/jendrikseipp/vulture)
40. [claude-plugins/python-plugin/skills/vulture-dead-code/REFERENCE.md at main · laurigates/claude-plugins](https://github.com/laurigates/claude-plugins/blob/main/python-plugin/skills/vulture-dead-code/REFERENCE.md)
41. [dependency-cruiser/doc/rules-reference.md at main · sverweij/dependency-cruiser](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)
42. [Rules Overview | JS Boundaries](https://www.jsboundaries.dev/docs/rules/)
43. [Contract types — Import Linter 1.5.0 documentation](https://import-linter.readthedocs.io/en/v1.5.0/contract_types.html)
44. [Measuring Determinism in Large Language Modelsfor Software Code Review](https://arxiv.org/html/2502.20747)
45. [Automated Code Review In Practice | alphaXiv](https://www.alphaxiv.org/abs/2412.18531)
46. [Automated Code Review In Practice](https://arxiv.org/pdf/2412.18531)
47. [arxiv.org](https://arxiv.org/pdf/2601.18844)
48. [Building a code review tool: The LLM patterns that actually work | G-Research](https://www.gresearch.com/news/building-a-code-review-tool-the-llm-patterns-that-actually-work/)
49. [Diff Risk Score: AI-driven risk-aware software development - Engineering at Meta](https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/)
50. [(PDF) Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency](https://www.researchgate.net/publication/405428281_Automating_Low-Risk_Code_Review_at_Meta_RADAR_Risk_Calibration_and_Review_Efficiency/download)
51. [Automating Low-Risk Code Review at Meta: RADAR, Risk](https://arxiv.org/pdf/2605.30208)
52. [Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency — The Commonplace](https://commonplace.workforcefutures.net/paper/arxiv:2605.30208)
53. [DRS-OSS: LLM-Driven Diff Risk Scoring Tool for PR Risk Prediction](https://arxiv.org/html/2511.21964v1)
54. [DRS-OSS: A Diff-Risk Scoring Tool for Continuous Integration Workflows · Pith Review](https://pith.science/paper/2511.21964)
55. [ApacheJIT: A Large Dataset for Just-In-Time Defect Prediction](https://arxiv.org/pdf/2203.00101)
56. [Deep Just-in-Time Defect Prediction: How Far Are We? Zhengran Zeng](https://lingming.cs.illinois.edu/publications/issta2021a.pdf)
57. [Deep Just-in-Time Defect Prediction: How Far Are We? (ISSTA 2021 - Technical Papers) - ISSTA 2021](https://conf.researchr.org/details/issta-2021/issta-2021-technical-papers/33/Deep-Just-in-Time-Defect-Prediction-How-Far-Are-We-)
58. [Evaluating the impact of falsely detected performance bug-inducing changes in JIT models | Empirical Software Engineering | Springer Nature Link](https://link.springer.com/article/10.1007/s10664-021-10004-6)
59. <https://arxiv.org/pdf/2509.16941>
60. [SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?](https://arxiv.org/html/2509.16941v1)
61. [Rapid Quality Assurance with Requirements Smells](https://wwwbroy.in.tum.de/~femmer/works/2016-requirements_smells-jss.pdf)
62. [Towards auto-completion on software requirements statements](https://arxiv.org/pdf/2106.13908)
63. [1 Automated Smell Detection and Recommendation in Natural Language Requirements](https://orbilu.uni.lu/bitstream/10993/57739/1/paper.pdf)
64. [Automated Smell Detection and Recommendation in Natural Language Requirements (FSE 2024 - Journal First) - FSE 2024](https://2024.esec-fse.org/details/fse-2024-journal-first/5/Automated-Smell-Detection-and-Recommendation-in-Natural-Language-Requirements)
65. [ClarEval: A Benchmark for Evaluating Clarification Skills of Code Agents under Ambiguous Instructions](https://arxiv.org/html/2603.00187v1)
66. [Ask or Assume? Uncertainty-Aware Clarification-Seeking in Coding Agents](https://arxiv.org/html/2603.26233v1)
67. [ASPI: Seeking Ambiguity Clarification Amplifies Prompt Injection Vulnerability in LLM Agents](https://arxiv.org/html/2605.17324v1)
68. [(PDF) Modern code review: a case study at google](https://www.researchgate.net/publication/325730783_Modern_code_review_a_case_study_at_google)
69. [Modern Code Review: A Case Study at Google Presented by Youssef Souati 10/8/25](https://plg.uwaterloo.ca/~migod/846/current/summaries/10-Youssef-GoogleCodeReview-slides.pdf)
70. [How Google does code review - Graphite](https://graphite.com/blog/how-google-does-code-review)
71. [Deep just-in-time defect prediction: How far are we? - Illinois Experts](https://experts.illinois.edu/en/publications/deep-just-in-time-defect-prediction-how-far-are-we)
72. [Stacked diffs - Graphite](https://graphite.com/guides/stacked-diffs)
73. [Stacked Diffs (and why you should know about them)](https://newsletter.pragmaticengineer.com/p/stacked-diffs)
74. [GitHub recalls Phabricator with preview of Stacked PRs](https://www.theregister.com/2026/04/14/github_stacked_prs/)
75. [Do LLMs generate test oracles that capture the actual or the expected program behaviour? — Lacuna](https://lacuna.tiptreesystems.com/work/do-llms-generate-test-oracles-that-capture-the-actual-or-the-expected-program/wrk_ac592681a1fc34eee5a068aa033cc3de)
76. [Uncovering Business Logic Bugs via Semantics-Driven Unit Test Generation · Pith Review](https://pith.science/paper/2604.23509)
77. [1 Practical Mutation Testing at Scale A view from Google](https://arxiv.org/pdf/2102.11378)
78. [Mutation testing: mutate only the lines a PR changes and surface survivors in review · Issue #355 · adewale/agentic-mermaid](https://github.com/adewale/agentic-mermaid/issues/355)
79. [State of Mutation Testing at Google](https://research.google/pubs/state-of-mutation-testing-at-google/)
80. [Practical Mutation Testing at Scale: A view from Google](https://homes.cs.washington.edu/~rjust/publ/PetrovicIFJ2021c-abstract.html)
81. [Mutation-Guided LLM-based Test Generation at Meta (FSE 2025 - Industry Papers) - FSE 2025](https://conf.researchr.org/details/fse-2025/fse-2025-industry-papers/16/Mutation-Guided-LLM-based-Test-Generation-at-Meta)
82. <https://stryker-mutator.io/docs/stryker-js/incremental/>
83. <https://stryker-mutator.io/docs/stryker-js/configuration/>
84. [Just-in-Time Catching Test Generation at Meta](https://arxiv.org/pdf/2601.22832)

# Scoring Work Items Red, Yellow, or Green for AI Coding Agents: A Rubric for Ticket Triage and Merge Readiness

Delegate a work item to an agent based on what the change touches, how reversible it is, and how well its correctness can be checked by machines. Diff size and apparent complexity come after those. Any change to authentication, authorization, session or token handling, money movement, cryptography, secrets, customer-data handling, destructive migrations, or production permissions should be forced to High Yellow or Red, whatever its size.

## TL;DR

- Score each item on sensitivity class (a hard override), then on reversibility and blast radius, size and diffusion, complexity and code history, spec clarity, and verification strength. Green and Low Yellow go to agents. High Yellow is agent-drafted but reviewed by a domain owner. Red is human-authored or human-driven. Meta's RADAR system does this at scale and is the strongest published precedent. It has reviewed 535K+ diffs and landed 331K+, with a revert rate one third that of other diffs. That comparison is selection-biased, because RADAR only sees low-risk diffs.
- What agents do reliably is narrow. Documentation, CI/build, test, and dependency-housekeeping PRs merge most often. Bug fixes and performance work merge least often. Rejected agent PRs are larger, touch more files, and fail CI more often. A March 2026 METR research note found that "roughly half of test-passing SWE-bench Verified PRs" from mid-2024 to mid/late-2025 agents would not be merged by repo maintainers. Veracode's 2025 GenAI Code Security Report found that LLMs introduced security vulnerabilities in 45% of 80 security-relevant tasks, and Pearce et al. found about 40% for Copilot in 2022.
- Score twice: at ticket triage (predicted) and at merge time (actual diff). The merge-time score may raise the tier automatically. Lowering it needs a human. Calibrate thresholds against revert, incident, and rework rates per tier, and re-check them at least quarterly, because change-risk models lose accuracy within a year.

## Key Findings

- **Sensitive-surface overrides beat size-based scoring.** In the just-in-time (JIT) defect literature, size and diffusion predict defects.\[1\] Those models predict defect likelihood, not consequence. A 12-line change to JWT validation is small and catastrophic if wrong. Compliance regimes (PCI DSS 6.5.1, SOC 2 CC8.1, NIST SSDF PW.7) are organized around documented approval and review of changes.\[2\]\[3\]\[4\] Consequence classes therefore have to be hard rules, not weighted inputs.
- **Size matters for review quality more than for merge speed.** The SmartBear/Cisco study (2,500 reviews, 3.2 million LOC) found defect detection falls off above 200–400 lines under review.\[5\]\[6\] This was a vendor-run case study. Kudrjavets et al. (845,316 PRs) found only a weak correlation between PR size and time-to-merge (Spearman rs = 0.26).\[7\] Keep PRs small so review works, not in the expectation that they will merge faster.
- **Agent capability depends on task length and reliability threshold.** Kwa et al. (METR, arXiv 2503.14499) found that the frontier time horizon at 50% reliability "has been doubling approximately every seven months since 2019, though the trend may have accelerated in 2024." They also found a large gap between 50% and 80% reliability. On SWE-Bench Pro, resolve rates drop sharply as the number of files involved rises. On its proprietary commercial subset, the best models scored under 20% in the original evaluation.\[8\]\[9\]
- **Risk-stratified automation works when it is layered and conservative.** Meta's RADAR combines authorship and source-type classification, eligibility gates, static heuristics, an ML Diff Risk Score, LLM review, and deterministic validation.\[10\] It sets stricter thresholds for AI-generated diffs than for allowlisted automation runbooks, and it excludes SOX-scoped code and sensitive code patterns.\[11\]\[12\]
- **Heavyweight external approval does not lower failure rates.** DORA's 2019 report found no evidence that formal change-approval boards lower change failure rates. Respondents with such processes were 2.6 times more likely to be low performers.\[13\] Put human review effort on high-risk items, next to the code, and do not route everything through a board.

## Details

### 1. Risk profile by code area

#### Sensitivity classes

Classify every file, directory, and code pattern into one of four sensitivity classes. The class sets a minimum tier. Other factors can raise the tier above that minimum but can never lower it below.

| Class | Surfaces | Minimum tier |
|---|---|---|
| S3 (critical) | Authentication and authorization logic; session, token, and cookie handling; password and MFA flows; cryptographic primitives and key management; secrets and credential storage; payment authorization, capture, refunds, payouts, ledger and balance logic, webhook signature verification; permission/role models and IAM policies; destructive or irreversible data migrations; production network/security-group IaC; audit logging of security events | High Yellow (Red for the rule set below) |
| S2 (sensitive) | Read/write paths for PII or customer records; data export and reporting that includes customer data; non-destructive schema migrations; non-production IaC; CI/CD pipeline definitions and deployment config; security-relevant dependency upgrades (auth, crypto, payment SDKs, ORM); rate limiting; multi-tenant isolation filters | Low Yellow |
| S1 (standard) | User-facing product logic without S2/S3 data; UI components; business logic behind a feature flag | Green allowed |
| S0 (low) | Documentation, comments, tests-only changes, internal tooling, lint/format, non-security dependency bumps with lockfile only | Green allowed |

An item is Red, whatever its other scores, if it does any of the following: introduces or changes an authentication flow or token-validation logic; changes how money is calculated, moved, or reconciled; drops, truncates, or rewrites data irreversibly; selects or changes a cryptographic algorithm, mode, or key-handling scheme; changes the permission model (who can do what); or modifies secret storage or rotation. Other S3 touches, such as calling an existing auth middleware from a new route or adding a field to a payment receipt, are High Yellow.

#### Compliance expectations that shape the tiers

**PCI DSS v4.0 (payments).** Requirement 6.5.1 says changes to system components in production must follow procedures that include the reason for and description of the change, documentation of security impact, documented change approval by authorized parties, and testing to verify the change does not adversely affect security.\[14\] Requirement 6.5.4 separates roles and functions between production and pre-production "to provide accountability such that only reviewed and approved changes are deployed."\[2\]\[14\]\[15\] Requirement 6.5.5 prohibits live PANs in pre-production.\[16\]\[17\] Agent sandboxes and test fixtures must therefore never contain real card numbers. Requirement 6.2.3 requires bespoke software to be reviewed before release to find coding vulnerabilities. Requirement 6.2.3.1 adds that manual reviews must be performed by someone other than the author who knows secure coding, and approved by management before release. For repositories in scope for the cardholder data environment, "Green, no human review" is not available. The lowest tier there is one human approval with a recorded rationale.

**SOC 2 CC8.1 (change management).** The criterion requires that the entity "authorizes, designs, develops or acquires, configures, documents, tests, approves, and implements changes to infrastructure, data, software, and procedures."\[18\] Auditors sample production changes from the audit period and check for authorization, testing, and approval by someone other than the author.\[3\]\[19\] Some compliance practitioners argue that a documented policy authorizing automated approval for a defined low-risk class can satisfy CC8.1, provided it is scoped and evidenced.\[20\] That is an interpretation from compliance vendors, not AICPA guidance. Confirm it with your auditor before relying on it. For agent-authored PRs, treat the human who dispatched the agent as the author for separation-of-duties purposes. That person should not be the sole approver.

**NIST SSDF (SP 800-218).** PW.7.1 asks the organization to decide when code review (a person looks at the code) and when code analysis (tools look at the code) is required.\[4\] PW.7.2 asks that review or analysis follow the organization's secure coding standards, with issues recorded and triaged. PO.3 asks for toolchains that automate security practices and generate artifacts showing those practices were followed.\[21\] The tier model in this article is a PW.7.1 policy. The agent evidence bundle in Section 7 is a PO.3.3 artifact.

**OWASP.** The OWASP Application Security Verification Standard (ASVS) and the Top 10 are useful checklists for S3 review, covering authentication, session management, access control, cryptography, and injection. They describe what a reviewer should verify. They do not set who must review.

**Customer data: GDPR and Mexico's LFPDPPP.** GDPR Article 25 (data protection by design and by default) and Article 32 (security of processing) require technical and organizational measures proportional to risk. Article 35 requires a data protection impact assessment for high-risk processing. A change that introduces new processing of personal data, such as a new export, a new third-party transfer, or new profiling, is a product and legal decision, not only a code change. Mexico replaced its 2010 data protection law with a new Ley Federal de Protección de Datos Personales en Posesión de los Particulares, published in the Diario Oficial de la Federación on 20 March 2025 and in force the next day. The new law abolished the INAI and moved supervision to the Secretaría Anticorrupción y Buen Gobierno.\[22\]\[23\] Article 18 requires controllers to establish and maintain administrative, technical, and physical security measures. Article 19 covers security breaches, which must be reported to data subjects promptly when they significantly affect their rights.\[23\]\[24\] For client codebases serving Mexican users, changes to PII storage, access control, retention, or transfer to third parties fall under these obligations. Classify them S2 at minimum, and S3 when they change who can access the data.

#### Detecting sensitive surfaces mechanically

Use several detectors, and take the highest class any of them reports.

- **Path rules and CODEOWNERS.** Keep a per-repository sensitivity manifest (for example `.risk/sensitivity.yaml`) that maps globs to classes, such as `src/auth/**: S3`, `migrations/**: S2`, and `infra/prod/**: S3`. Pair it with CODEOWNERS entries so that GitHub or GitLab branch protection requires the domain owner's approval when those paths change. This is cheap and deterministic. Its weakness is sensitive logic placed outside tagged paths.
- **Content patterns.** Scan the diff, not only the paths, for imports and calls such as JWT libraries, `bcrypt`/`argon2`, `crypto`/`cryptography`, payment SDKs (Stripe, Adyen, Conekta, Mercado Pago), `DROP`/`ALTER`/`TRUNCATE`, IAM policy documents, `.env` and secret-manager clients, and security-group resources in Terraform. Meta's RADAR uses "content blocklists for sensitive code patterns" alongside scope exclusions for SOX-scoped code.\[12\]
- **Data-classification annotations.** Tag PII columns and fields in the schema or ORM models, for example with a `@pii` annotation or a column comment convention. Any diff that reads, writes, logs, serializes, or exports a tagged field is S2. Taint-style SAST queries in CodeQL or Semgrep can follow tagged fields into logs, responses, and third-party calls.
- **Dependency and call-graph analysis.** A change to a function called by auth middleware, or to a shared utility used by the payment module, inherits the caller's class. Compute reverse dependencies for changed symbols at the module level at least.
- **Semantic diff classification with an LLM.** A model can flag intent that the other detectors miss, for example "this change bypasses the tenant filter for admin users." Use it only to raise a classification, never to lower one. It is probabilistic and can be manipulated by content in the diff.

### 2. Blast radius and reversibility

Sensitivity describes what could go wrong. Blast radius and reversibility describe how much damage results and how cheaply it can be undone. Score them 0–3:

| Score | Condition |
|---|---|
| 0 | Behind a default-off feature flag, or internal-only; revert is a single commit with no data implications |
| 1 | User-facing but instantly reversible by revert or flag; affects one service |
| 2 | User-facing with no flag; or requires coordinated deploys; or changes a public API/contract consumed by other services or clients; or writes data in a new shape (reversible with a script) |
| 3 | Irreversible or data-destructive (drops, lossy transforms, backfills that overwrite), sends external side effects that cannot be recalled (emails, payouts, third-party API writes), or affects many dependent services |

Changes that are irreversible or destroy data score 3 and trigger the Red override. Schema changes should use the expand/contract pattern: add the new structure, dual-write, backfill, switch reads, then remove the old structure in a separate change. That turns one Red migration into several Low or High Yellow steps, each of which can be reversed. The DORA 2025 report names disciplined version control and easy rollback as a safety net for AI-assisted work.\[25\] A score of 0 here depends on flags and rollbacks actually working in each client environment, so verify that per client rather than assuming it.

### 3. PR size, scope, and complexity

#### What the review research shows

The SmartBear/Cisco MeetingPlace study ran for 10 months and covered 2,500 reviews of 3.2 million lines written by 50 developers. It recommended keeping lines under review below 200 and not exceeding 400.\[6\]\[26\] It found that reviewers going faster than about 450 lines per hour were below average at finding defects in 87% of cases.\[26\] SmartBear sells code review tools and ran the study, so the thresholds are best read as practitioner guidance from one industrial setting, not a controlled result. They are still the most widely cited numbers.

Google's code review study (Sadowski et al., ICSE-SEIP 2018) found a median change size of 24 lines.\[7\] Over 35% of changes touched a single file, about 90% touched fewer than 10 files, and the median reviewer count was 1.\[27\] Small changes got initial feedback in a median of under an hour, against about five hours for very large changes.\[28\] Google treats a single reviewer as enough because changes are small.\[29\] The two findings go together.

Kudrjavets, Nagappan, and Rastogi (MSR 2022) analyzed 845,316 GitHub PRs from 100 projects across 10 languages and 401,790 Gerrit/Phabricator reviews. They found the size–time-to-merge correlation weak (rs = 0.26 on GitHub, 0.13–0.30 on Gerrit and Phabricator projects). Their conclusion was that splitting PRs "may help with increasing the chances of acceptance or make code changes 'reviewable', but it does not decrease the overall time it takes to review or merge them." The study covers open-source projects only.\[7\]

For agents, the size limit exists to protect reviewers, not to speed merging. Agents produce code faster than humans can review it. Meta reports that lines of code per human-landed diff grew 105.9% year over year and diff volume per developer rose 51%, with agentic AI responsible for over 80% of that growth, while the share of diffs getting timely review declined.\[10\]

#### Which change attributes predict defects

Kamei et al. (IEEE TSE 2013) built change-level ("just-in-time") defect models from 14 factors in five dimensions:

- Diffusion: subsystems, directories, and files modified, and entropy.
- Size: lines added, deleted, and in the touched files.
- Purpose: whether the change is a fix.
- History: developer count, age of last change, and number of unique prior changes.
- Experience: the author's overall, recent, and subsystem experience.\[1\]

The study covered six open-source and five commercial projects with over 250,000 changes. The models predicted defect-inducing changes with 68% average accuracy and 64% average recall. An effort-aware model identified 35% of defect-inducing changes while inspecting only 20% of the modified lines.\[1\] In open-source projects, the number of files, relative churn, and whether the change was a bug fix increased risk. Time since the files' last change decreased risk: recently changed files are more dangerous. In commercial projects, number of files, relative churn, and the number of prior developers on the files increased risk, and the authors found no consistent risk-decreasing factors.\[1\]

Later work groups these properties into size, diffusion, history, author experience, reviewer experience, and review families.\[30\]\[31\] McIntosh and Kamei (IEEE TSE 2018), studying 37,524 changes in Qt and OpenStack, found that JIT models lost 11–22 and 14–34 percentage points of AUC respectively within a year. They recommended retraining on data from the last three months.\[30\] The factors that predict defects change as a codebase evolves, so any weights in your rubric will go stale too.

For the rubric, this means two things. Bug fixes are riskier than they look, because the FIX flag is risk-increasing in most open-source projects studied. That agrees with agent data showing bug-fix PRs merge least often.\[1\]\[32\]\[33\] Files with recent heavy churn deserve extra caution.

#### Complexity metrics

Cyclomatic complexity (independent paths) and cognitive complexity (SonarSource's measure of nesting and control-flow breaks) are useful as deltas, meaning the increase introduced by the diff, not as absolute file scores. Combine them with:

- files touched and modules/subsystems crossed (the diffusion factors);
- churn in the touched files over the last 90 days;
- count of prior bug-fix commits on those files;
- whether the change introduces concurrency, caching, retries, or distributed state, which are hard to test.

Exclude generated code, lockfiles, snapshots, and vendored files from line counts.

#### Spec ambiguity

Ambiguity belongs in scope because agents cannot recover missing intent. The authors of SWE-Bench Pro added human-written requirements and interface specifications to each task.\[34\] According to a secondary summary of the paper, removing those requirements dropped GPT-5's resolve rate from 25.9% to 8.4%.\[35\] In the MSR 2026 study of failed agent PRs, "unwanted feature implementations" and "agent misalignment" appear among the rejection reasons.\[33\] Score spec clarity 0–3:

| Score | Condition |
|---|---|
| 0 | Reproducible bug with failing test or exact reproduction steps; or mechanical change with a precise pattern (rename, upgrade, lint fix) |
| 1 | Clear acceptance criteria and a named location in code; test oracle derivable |
| 2 | Acceptance criteria present but behavior at edges unstated; requires choosing between plausible designs |
| 3 | Goal stated as an outcome ("make checkout faster", "clean up permissions"); requires product or architectural judgment |

### 4. What AI coding agents do well and poorly

#### Benchmarks

METR's time-horizon study (Kwa et al., 2025) found that the length of tasks frontier agents complete at 50% reliability, measured by how long the tasks take human professionals, doubled approximately every seven months from 2019 to early 2025. It put Claude 3.7 Sonnet's 50% horizon at around 50 minutes. The 80% horizon doubled at a similar rate but is much shorter in absolute terms. METR's January 2026 update (Time Horizon 1.1) estimated a faster post-2023 doubling time of 131 days. The long-run 7-month hybrid trend stayed the same.\[36\] Use the 80% horizon, not the 50% horizon, when deciding what to delegate. A task at the 50% horizon fails half the time.

SWE-bench Verified is close to saturated, with frontier agents above 70%.\[37\]\[38\] METR had four active maintainers of scikit-learn, Sphinx, and pytest review 296 agent PRs that passed the automated grader. About half would not have been merged, even after adjusting for noise in maintainer decisions. METR reports that maintainer merge decisions averaged about 24 percentage points below the automated grader's scores, with results normalized against a 68% maintainer merge rate for the original human-written patches. Passing tests is not the same as being ready to merge. Scale AI's SWE-Bench Pro has 1,865 tasks across 41 repositories, split into public, held-out, and commercial sets, with reference solutions averaging 107.4 lines across 4.1 files. It initially found frontier models below 25%, with GPT-5 highest at 23.3%. A later revision reported Claude Sonnet 4.5 at 43.6% on the public set, and the best models stayed under 20% on the proprietary commercial set. Resolve rates were stable for single-file problems and fell sharply as file count rose.\[8\]\[9\]

METR's randomized controlled trial of 16 experienced open-source developers on 246 tasks in their own mature repositories found that AI tools increased completion time by 19%. The same developers had predicted a 24% speedup and afterwards estimated they had been sped up by 20%.\[39\]\[40\] The trial used early-2025 tools (mainly Cursor with Claude 3.5/3.7) and a small sample.\[41\]\[42\] It shows that self-reported productivity gains are unreliable, which is why calibration in Section 8 should use measured outcomes.

#### Field data on agent-authored PRs

The AIDev dataset has 33,596 agent-authored PRs from 2,807 GitHub repositories with at least 100 stars, covering OpenAI Codex, GitHub Copilot, Devin, Cursor, and Claude Code.\[43\] Ehsani et al. (MSR 2026) found an overall merge rate of 71.48%, ranging from 82.59% for Codex to 43.04% for Copilot.\[32\] Documentation, CI, and build-update tasks had the highest merge success. Performance and bug-fix tasks had the lowest. Not-merged PRs involved larger code changes, touched more files, and more often failed CI.\[33\] A task-stratified analysis of 7,156 of these PRs found task type to be a dominant factor in acceptance.\[44\]\[45\] A comparison of agents without accounting for task mix is therefore misleading.

A separate study of agentic PRs on GitHub (ACM) found 83.8% accepted, with 54.9% of merged PRs integrated without further modification. The remaining 45.1% needed human revision, especially bug fixes, documentation, and adherence to project standards.\[46\] Studies claiming agent PRs have defect rates equal to or lower than human PRs compare merged agent PRs, a filtered subset, against merged human PRs, which are nearly all human PRs. A published referee critique flags this selection bias, so treat such claims cautiously.\[47\]

#### Security of generated code

Pearce et al. (IEEE S&P 2022) prompted GitHub Copilot with 89 scenarios based on MITRE's CWE Top 25 and found about 40% of 1,689 generated programs vulnerable.\[48\]\[49\]\[50\] Veracode's 2025 GenAI Code Security Report tested more than 100 LLMs on 80 tasks designed around known CWEs. In 45% of cases the models introduced an OWASP Top 10 vulnerability.\[51\] Java was worst, with a 72% failure rate, and newer or larger models were not measurably more secure.\[52\]\[53\] Veracode is a SAST vendor and the tasks were chosen to invite vulnerabilities, so the 45% figure measures behavior on security-relevant prompts, not a vulnerability rate for all AI-written code. Both studies point the same way: agents reproduce common insecure patterns unless constrained. That supports hard overrides for S3 code and mandatory SAST on every agent PR.

#### Tasks agents complete reliably and tasks that need human judgment

The evidence supports delegating the following to agents: documentation; test additions for existing behavior; CI and build config in non-production pipelines; dependency bumps with passing tests; mechanical refactors with a precise pattern; lint and type fixes; small, well-specified bug fixes with a reproducing test; and UI changes behind flags. Keep humans in charge of the following:

- ambiguous feature work;
- performance work, which needs measurement and design judgment;
- multi-module changes;
- security-sensitive logic;
- data migrations on production data;
- anything where "correct" depends on business rules not written in the ticket.

#### Autonomy frameworks

No standards body has published a levels-of-autonomy framework for coding agents. The circulating L0–L5 frameworks, such as Dash0's six levels and MindStudio's five levels, are practitioner and vendor proposals modeled on SAE J3016 for vehicles.\[54\]\[55\]\[56\] They are useful as vocabulary. Dash0 frames the human role as moving from writing code (L1) to approving diffs (L2), approving intent and proof (L3), and setting scope and handling escalations (L4).\[54\]\[57\] They are not empirically validated. An academic proposal for graduated human oversight in regulated domains (arXiv 2606.22484) takes a similar approach.\[58\] Meta's RADAR is the only large-scale deployment with published outcome data. Its design is closer to this rubric than any levels framework: autonomy is set per change source and per risk percentile, not per agent.

### 5. Existing change-risk practice in industry

**ITIL change types.** ITIL has three change types. Standard changes are pre-authorized, low-risk, repeatable changes that follow a documented procedure. Normal changes need assessment and authorization.\[59\]\[60\] Emergency changes take an expedited path with retrospective review. Green maps to a standard change: the category is pre-authorized, not each instance.\[60\] ITIL also requires that when a standard-change procedure is created or modified, it gets a full risk assessment.\[61\] That is the equivalent of promoting a task category to Green in Section 8.

**DORA.** The 2019 Accelerate State of DevOps report found that formal external approval, meaning a CAB or senior manager signing off significant changes, "negatively impact[s] speed and stability." Respondents with such processes were 2.6 times more likely to be low performers. The report states: "we investigated whether a more formal approval process was associated with lower change fail rates and we found no evidence to support this hypothesis." It recommended moving to peer-review-based approval during development, and found respondents with a clear change process were 1.8 times more likely to be elite performers.\[13\] The lesson for this rubric is to make the tier process clear and automatic and to put review next to the code. Adding approvers for every agent PR would repeat the CAB failure.

The 2025 DORA report (State of AI-assisted Software Development, nearly 5,000 respondents) found 90% use AI at work and 30% have little or no trust in AI-generated code. AI adoption now correlates positively with throughput but continues to correlate with higher delivery instability.\[62\] DORA added rework rate as a stability measure alongside change failure rate.\[63\]

**Meta's Diff Risk Score and RADAR.** Diff Risk Score (DRS) is a fine-tuned Llama model that predicts the probability a diff causes a production incident. It is tuned for high recall at a fixed flag rate, for example flagging 10% of diffs while catching 60% of incident-causing changes. It powers about 20 risk-aware features, including code-freeze exceptions and reviewer recommendations.\[11\]\[64\] RADAR (Risk Aware Diff Auto Review, arXiv 2605.30208) is the review-automation funnel built on top of it. It sets different eligibility thresholds by source:

- deterministic codemods bypass per-diff AI review;
- allowlisted RACER runbooks must fall in the lowest-risk 50% (P50);
- other AI and bot diffs must fall in the lowest-risk 20% (P20);
- human-authored diffs must fall in the lowest-risk 5% (P5), with author-experience checks, SOX-scope exclusions, and sensitive-pattern blocklists.\[11\]\[12\]

Raising the DRS threshold from P25 to P50 raised the approve rate to 60.31%. RADAR-reviewed diffs had one third the revert rate and 1/50 the production-incident rate of non-RADAR diffs. Median time to close fell by over 330%, and median review wall time fell by 35%.\[10\] The comparison is observational and RADAR selects low-risk diffs by design, so the incident ratio shows the gate selects well. It does not show that automated review is safer than human review.

**Open tooling.** DRS-OSS, a Llama 3.1 8B classifier trained on ApacheJIT, reports F1 = 0.64 and ROC-AUC = 0.89. In simulation, gating the riskiest 30% of commits would have blocked up to 86.4% of defect-inducing changes.\[65\] These are benchmark and simulation results, not production outcomes. Commercial PR-risk tools make similar claims with less published evidence.

**What has worked and what has failed.** The pattern that works combines deterministic exclusions, a probabilistic score, and conservative thresholds that loosen gradually as outcome data comes in (Meta). Two things have failed. Uniform heavyweight approval slows delivery without improving stability (DORA). Model-only scoring without retraining decays within a year (McIntosh and Kamei), and LLM-based scores are hard to explain to engineers, which Meta's own follow-up work on DRS explanations identifies as a barrier to adoption.\[30\]\[66\]

### 6. The scoring rubric

#### Factors and measurement

| Factor | Range | How to measure (ticket time) | How to measure (merge time) |
|---|---|---|---|
| Sensitivity class | S0–S3 (sets minimum tier) | Components/labels on the ticket; predicted paths from similar past tickets; engineer judgment | Path manifest, CODEOWNERS hits, content patterns, PII-annotation hits, call-graph inheritance, LLM classifier (raise-only) |
| Reversibility and blast radius (R) | 0–3 | Is there a flag? Is it user-facing? Does it write/destroy data or call external systems? Number of consuming services | Flag presence in diff; migration type (additive vs destructive); API/contract changes; external side-effect calls |
| Size and diffusion (Z) | 0–3 | Estimate | 0: ≤50 changed lines, 1 module; 1: ≤200 lines, ≤5 files; 2: ≤400 lines or 2–3 modules; 3: >400 lines or >3 modules (excluding generated files) |
| Complexity and history (C) | 0–3 | Known hotspot? Concurrency, caching, or distributed state involved? Is it a bug fix? | Cognitive/cyclomatic delta; 90-day churn and prior-fix count on touched files; new async/concurrency constructs; FIX flag |
| Spec clarity (A) | 0–3 | Section 3 table | Unchanged unless the PR reveals new decisions (then raise) |
| Verification strength (V) | 0–3, subtracted | Do tests exist for the affected behavior? Is there a test oracle? | Changed-line coverage; new tests fail without the change; type checker coverage; integration/e2e coverage of the path |

**Base score** = R + Z + C + A + (3 − V), for a range of 0–15.

| Base score | Tier (before overrides) |
|---|---|
| 0–3 | Green |
| 4–6 | Low Yellow |
| 7–9 | High Yellow |
| 10–15 | Red |

These cut-points and equal weights are starting defaults, not empirically derived values. Section 8 describes how to adjust them from outcomes.

**Hard overrides, applied after the base score:**

1. Tier = max(base tier, sensitivity minimum): S2 raises the tier to at least Low Yellow, and S3 to at least High Yellow.
2. Red if any Section 1 Red trigger applies (new or changed auth flow or token validation, money-movement logic, irreversible data change, crypto choice, permission model, secret storage).
3. Red if R = 3.
4. At least High Yellow if the repository is in PCI or SOX scope and the diff touches in-scope components.
5. At least Low Yellow if CI cannot run the affected code path, for example when a service has no test harness.
6. Tier +1 if the ticket and the diff disagree about which S2/S3 areas are touched (scope drift).

#### Tier definitions and human involvement

| Tier | Who authors | Human involvement | Pre-work requirement |
|---|---|---|---|
| Green | Agent | No blocking human review, unless compliance requires it (PCI/SOC 2 scope: one lightweight approval). Automated gates must pass. Sampled post-merge audit, e.g. 10% of Green merges reviewed weekly | None beyond ticket |
| Low Yellow | Agent | One standard human review by an engineer familiar with the codebase who is not the person who dispatched the agent | Ticket must have acceptance criteria (A ≤ 1) |
| High Yellow | Agent drafts; human owns | Plan approval before implementation. Review by the CODEOWNERS domain owner (auth, payments, data) or a senior engineer. Reviewer runs or inspects the verification | Written plan from agent approved by owner; rollback plan |
| Red | Human (agent may assist with sub-tasks, tests, or research) | Human author plus a second reviewer from the domain owner or security. Staged rollout with monitoring. Change record with security-impact note | Design note; for migrations, expand/contract plan and dry run on a production-sized copy |

"Lower-end yellow" in the delegation policy means Low Yellow. Agents run end to end on Green and Low Yellow. High Yellow is agent-assisted but the human is accountable, and it should not be counted as automated work.

#### Worked examples

**1. Fix copy in the onboarding email and update the snapshot test.**
- Factors: S0; R = 1 (user-facing, instantly revertible); Z = 0; C = 0; A = 0; V = 3 (snapshot test).
- Base = 1 + 0 + 0 + 0 + 0 = 1. **Green.** The agent merges once gates pass.

**2. Add pagination to an internal admin endpoint that lists customer records.**
- Factors: S2 (reads PII); R = 1; Z = 1 (about 150 lines, 4 files); C = 1; A = 1; V = 2.
- Base = 1 + 1 + 1 + 1 + 1 = 5. **Low Yellow**, which also meets the S2 minimum.
- Agent-authored with standard review. The reviewer checks that pagination does not bypass the tenant filter and that the response does not serialize newly exposed fields.

**3. Upgrade the payment provider SDK one major version.**
- S3 (payments). If only call signatures change, and webhook signature verification and amount handling do not, then R = 2, Z = 2, C = 1, A = 0, V = 2.
- Base = 6. The S3 minimum raises it to **High Yellow**. The agent drafts, and the payments owner reviews against the provider's migration guide with sandbox transaction evidence.
- If the upgrade changes how webhooks are verified or how amounts and currencies are represented, the money-movement trigger makes it **Red**.

**4a. Add a nullable column to `orders` and backfill it from an existing field.**
- Factors: S2 migration; R = 2 (writes data in a new shape, reversible by script); Z = 1; C = 1; A = 1; V = 1.
- Base = 2 + 1 + 1 + 1 + 2 = 7. **High Yellow.** Requires a dry run on a production-sized copy and a batched backfill.

**4b. Drop the old column in a later change.**
- R = 3, and the irreversible trigger applies. **Red.** A human executes it after verifying that no reads remain.

**5. Change refresh-token rotation to fix a logout bug.**
- The auth trigger applies. **Red**, whatever the size. The FIX flag and S3 class confirm it. A human authors it; the agent may write regression tests.

**6. Fix a flaky test by adding a wait-for condition in the CI config.**
- Factors: S0 (non-production CI); R = 0; Z = 0; C = 1; A = 1; V = 2.
- Base = 3. **Green.**
- If the "fix" is to delete or skip the test, V drops to 0 and the base becomes 5, which is Low Yellow. A human must approve removal of verification.

**7. Open port 5432 on a production security group so a new analytics service can reach the database.**
- S3 (production network IaC, customer data access); R = 2; Z = 0; C = 0; A = 1; V = 0.
- Base = 6. The S3 minimum makes it High Yellow. Because the change alters who can reach customer data, treat it as a permission-model change: **Red**.

#### Ticket-time and merge-time scoring

Ticket-time scoring decides who does the work. It relies on predictions: component labels, an estimated size, spec clarity, and paths predicted from similar past tickets. It should err toward the higher tier when unsure, because re-tiering later wastes agent work.

Merge-time scoring decides what review the PR needs. It is computed from the actual diff by the detectors in Section 1 and the gates in Section 7. The rules between the two:

- The merge-time score may raise the tier automatically. Lowering it requires a named human to confirm and record a reason.
- If the diff touches an S2/S3 area the ticket did not predict, or exceeds the estimated size band by two steps, the PR is re-tiered and the agent's work pauses for human triage.
- If merge-time scoring lands a Green or Low Yellow ticket in High Yellow or Red, record that as a triage miss. The triage-miss rate is a calibration metric.
- Splitting an oversized PR into stacked PRs is the preferred response to a high Z score. Each part is scored separately, but the S-class override applies to every part that touches the sensitive area.

### 7. Merge-readiness gates per tier

| Gate | Green | Low Yellow | High Yellow | Red |
|---|---|---|---|---|
| CI build and full test suite | Required | Required | Required | Required |
| New or updated tests for changed behavior | Required (except S0 docs) | Required | Required, reviewer confirms they fail without the change | Required |
| Changed-line (diff) coverage | ≥80% | ≥80% | ≥90% on S2/S3 files | ≥90% plus integration/e2e on affected path |
| SAST (CodeQL/Semgrep or equivalent) | No new high/critical; medium triaged | Same | Zero new findings on S2/S3 files without written disposition | Same, plus security reviewer sign-off |
| Secret scanning with push protection | Required | Required | Required | Required |
| Dependency/SCA scan | No new known-exploitable vulnerabilities | Same | Same, plus license check | Same |
| Type check, lint, format | Required | Required | Required | Required |
| Required human reviewers | 0 (1 in PCI/SOX scope) | 1, not the dispatcher | CODEOWNERS domain owner or senior | Domain owner + second reviewer |
| Migration checks | n/a | Additive only, reversible | Dry run output on prod-sized copy; batched; lock-time estimate | Expand/contract plan, backup verified, human-executed |
| Rollout | Normal deploy | Normal deploy | Flag or canary where available | Flag or staged rollout with monitoring and named on-call |

The coverage and SAST thresholds are common practice defaults, not empirically derived values. Tune them per client codebase.

**Evidence bundle the agent must produce.** A PR is not mergeable unless its description contains the following, in a structured form a bot can parse:

1. Link to the ticket, ticket-time tier, and computed merge-time tier with factor scores.
2. List of sensitive areas touched, as reported by the detectors, and whether the ticket predicted them.
3. A plain summary of what changed and why, with any decisions the agent made that the ticket did not specify.
4. Commands run and their results: tests, type check, lint, and for migrations the dry-run output.
5. The new tests, with evidence that they fail on the base branch and pass on the PR branch.
6. Diff coverage figure and SAST/secret/SCA results.
7. Rollback method: revert, flag name, or down-migration.
8. For UI changes, screenshots or recordings. For API changes, request/response examples.
9. Known limitations and anything the agent could not verify.

This bundle is the documentation PCI DSS 6.5.1 and SOC 2 CC8.1 auditors sample for. It is also the "artifact of support" that NIST SSDF PO.3.3 describes.\[2\]\[21\]\[67\]

### 8. Calibration over time

**What to track per tier, per repository, and per task category:**

- revert rate within 14 and 30 days;
- change failure rate (merges linked to an incident or hotfix);
- rework rate (follow-up fix commits touching the same lines within 30 days, a proxy for DORA's rework measure);
- review rework (review rounds, and the share of lines changed by humans after agent submission);
- escaped defects linked back to the introducing PR by SZZ-style blame;
- triage-miss rate (ticket tier lower than merge tier);
- override rate (human downgrades and upgrades, with reasons);
- time to merge.

Compare every agent tier with the human-authored baseline for the same tier and repository, not with a global average.

**Adjusting thresholds.** Loosen thresholds in steps, as Meta did when moving from P25 to P50. Each step needs a defined observation window and a pre-registered stop condition, for example: "if Green revert rate exceeds the human baseline for Green-equivalent changes, revert the threshold." Re-fit the weights or cut-points at least quarterly. McIntosh and Kamei's result, that change-risk models lose substantial accuracy within a year and should be retrained on recent data, applies to a hand-weighted rubric as much as to an ML model.\[30\]

**Expanding agent autonomy.** Promote by task category and repository, not by agent or globally. Meta's RADAR uses per-runbook risk history, daily volume caps, and source-specific thresholds.\[68\] A reasonable promotion rule (an opinion, not a published standard) is as follows. A task category, such as "dependency patch bumps in client X's API repo," moves from Low Yellow to Green after at least 30–50 merged agent PRs in that category, with a revert and incident rate at or below the human baseline and no S2/S3 triage misses. Demote the category immediately after any incident attributed to it. Cap daily Green merges per repository so that one bad pattern cannot spread widely before the sampled audit catches it. Never promote S3 categories to Green. The regulatory requirements in Section 1 and the security data in Section 4 do not support it.

## Recommendations

1. Build the sensitivity manifest and CODEOWNERS mappings for each client repository before scoring anything. Detection is the part of the rubric most likely to fail silently, and it is cheap to do first.
2. Implement the merge-time scorer as a CI job that writes the tier as a PR label and enforces the required-reviewer and gate rules through branch protection. Tiers that are only advisory will be ignored.
3. Start conservatively. Only S0/S1 items with base score ≤3 are Green, and all PCI/SOX-scoped repositories need one human approval. Loosen from outcome data, not from benchmark news.
4. Require the evidence bundle on every agent PR from day one. It serves as review aid, audit evidence, and calibration dataset at once.
5. Put the saved review time into S3 review and domain-owner capacity. The DORA 2019 findings argue against adding approval layers to everything.
6. Treat bug fixes as one step riskier than their size suggests until your own data says otherwise. Both the JIT literature and agent PR data point this way.

## Caveats

- The proposed weights, cut-points, coverage thresholds, and promotion counts are this article's proposals. They are not validated by published research. Treat them as defaults to calibrate.
- The strongest industrial evidence (Meta RADAR/DRS) comes from a single company with unusual tooling and reviewer culture, and its outcome comparisons are observational and selection-biased.
- The SmartBear/Cisco and Veracode figures come from vendors with commercial interests in their conclusions. The agent PR studies use open-source GitHub data from 2025, which may not represent private client codebases or current model versions.
- Agent capability is changing quickly, with METR measuring doubling times of months. Benchmark-based statements here describe models evaluated in 2025–2026 and will date.
- The compliance summaries are engineering interpretations, not legal advice. Whether automated approval satisfies SOC 2 CC8.1, and how the new LFPDPPP's secondary regulations apply to a given client, should be confirmed with the client's auditor or counsel.

## Sources

1. <https://posl.ait.kyushu-u.ac.jp/~kamei/publications/Kamei_TSE2013.pdf>
2. [PCI DSS v4.0 — Software Delivery Requirements (Requirement 6 Deep Dive) - Regulated DevSecOps](https://regulated-devsecops.com/ci-cd-governance/pci-dss-v4-0-software-delivery-requirements-requirement-6-deep-dive/)
3. [Secure Development Life Cycle in SOC 2: 2026 Guide](https://www.konfirmity.com/blog/soc-2-secure-sdlc)
4. [NIST SP 800-218 (SSDF)](https://www.securebydesignhandbook.com/docs/standards/us/nist-sp-800-218-ssdf-overview)
5. [This article contains information on results of a](https://support.smartbear.com/support/media/resources/cc/Episode_4_TheLargestCaseStudyOfCodeReviewEver.pdf)
6. [What Changes in Code Review When AI Writes the First Draft - MentorCruise](https://mentorcruise.com/blog/what-changes-in-code-review-when-ai-writes-the-first-draft/)
7. <https://arxiv.org/pdf/2203.05045>
8. [SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?](https://www.alphaxiv.org/overview/2509.16941)
9. [arXiv:2509.16941v2 \[cs.SE\] 14 Nov 2025 SWE-Bench Pro: Can AI Agents Solve](https://arxiv.org/pdf/2509.16941)
10. [Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency](https://arxiv.org/abs/2605.30208)
11. [Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency](https://arxiv.org/pdf/2605.30208)
12. [Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency](https://www.aimodels.fyi/papers/arxiv/automating-low-risk-code-review-meta-radar)
13. <https://dora.dev/research/2019/dora-report/2019-dora-accelerate-state-of-devops-report.pdf>
14. [PCI DSS Requirement 6: Develop and Maintain Secure Systems](https://blog.basistheory.com/pci-dss-requirement-6)
15. [Summary of Changes From PCI DSS Version 3.2.1 to 4.0](https://listings.pcisecuritystandards.org/documents/PCI-DSS-v3-2-1-to-v4-0-Summary-of-Changes-r1.pdf)
16. [PCI DSS Requirement 6 - Changes from v3.2.1](https://vistainfosec.com/blog/pci-dss-requirement-6-changes-from-v3-2-1-to-v4-0-explained/)
17. [How Should Change Control Management be for PCI DSS? - PCI DSS GUIDE](https://pcidssguide.com/change-control-management-for-pci-dss/)
18. [CC8.1.1 - SOC 2 - risk3sixty](https://risk3sixty.com/knowledge-base/cc8-1-1-soc-2)
19. [A Practical Guide to SOC 2 Change Management Controls](https://soc2auditors.org/insights/soc-2-change-management-controls/)
20. [SOC 2 never said a human has to approve your pull requests · heygrc](https://heygrc.com/blog/soc-2-never-said-a-human-approves-your-prs)
21. [NIST 800-218 (SSDF): What You Need to Know in 2026](https://checkmarx.com/blog/what-you-need-to-know-about-nist-800-218-the-secure-software-development-framework/)
22. [LFPDPPP: Guía de la Ley de Protección de Datos en México](https://www.piranirisk.com/es/hub-regulatorio/lfpdppp-ley-proteccion-datos-mexico)
23. [LFPDPPP: guía de la nueva ley de protección de datos de México](https://goadopt.io/es/blog/lfpdppp-mexico-guia-proteccion-datos/)
24. [Nueva Ley de Protección de Datos Personales 2025: Lo que toda empresa en México debe saber (y cómo prepararse)](https://www.uplaw.com.mx/post/nueva-ley-de-proteccion-de-datos-personales-2025-lo-que-toda-empresa-en-mexico-debe-saber)
25. [State of DevOps 2025: Review of the DORA Report on AI Assisted Software Development](https://www.splunk.com/en_us/blog/learn/state-of-devops.html)
26. [Smart Bear, Cisco, and the Largest Study on Code Review Ever](https://mikeconley.ca/blog/2009/09/14/smart-bear-cisco-and-the-largest-study-on-code-review-ever/)
27. [Notes on Paper "Modern Code Review: A Case Study at Google" - Binghuan's Blog](https://estepona.github.io/2019/01/30/note-google-code-review-paper/)
28. [Modern Code Review: A Case Study at Google (2018) \[pdf\]](https://news.ycombinator.com/item?id=26649784)
29. [Modern Code Review: A Case Study at Google Presented by Youssef Souati 10/8/25](https://plg.uwaterloo.ca/~migod/846/current/summaries/10-Youssef-GoogleCodeReview-slides.pdf)
30. <https://posl.ait.kyushu-u.ac.jp/~kamei/publications/McIntosh_TSE2017.pdf>
31. [Watch out for Extrinsic Bugs! A Case Study of their Impact in Just-In-Time Bug Prediction Models on the OpenStack project](https://arxiv.org/pdf/2103.15180)
32. [Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests in GitHub](https://www.alphaxiv.org/abs/2601.15195)
33. [Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests in GitHub](https://arxiv.org/abs/2601.15195)
34. [DeepSWE: Measuring Frontier Coding Agents on Original, Long-Horizon Engineering Tasks](https://arxiv.org/html/2607.07946v1)
35. [SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks? — Lacuna](https://lacuna.tiptreesystems.com/work/swe-bench-pro-can-ai-agents-solve-long-horizon-software-engineering-tasks/wrk_1db4a0ca49a477d596da0bfa97337f2a)
36. [Time Horizon 1.1 - METR](https://metr.org/blog/2026-1-29-time-horizon-1-1/)
37. [SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?](<https://static.scale.com/uploads/654197dc94d34f66c0f5184e/SWEAP_Eval_Scale%20(9).pdf>)
38. [SWE-Bench ProMax: Benchmarking Agents on Large-Scale Multilingual Code Refactoring](https://arxiv.org/html/2608.09802v1)
39. [Quantifying the Expectation-Realisation Gap for Agentic AI Systems](https://arxiv.org/pdf/2602.20292)
40. [Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity - METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
41. [A METR Study Reveals that AI Slows Down Experienced Developers — ActuIA](https://www.actuia.com/en/news/a-metr-study-reveals-that-ai-slows-down-experienced-developers/)
42. [AI Augmented Developers: Faster Feel, Slower Stopwatch](https://www.you-source.com/blogs/ai-augmented-developers)
43. [Security in the Age of AI Teammates: An Empirical Study of Agentic Pull Requests on GitHub](https://arxiv.org/html/2601.00477v2)
44. [Comparing AI Coding Agents: A Task-Stratified Analysis of Pull Request Acceptance](https://arxiv.org/html/2602.08915v2)
45. [www.arxiv.org](https://www.arxiv.org/pdf/2602.08915)
46. [On the Use of Agentic Coding: An Empirical Study of Pull Requests on GitHub](https://dl.acm.org/doi/10.1145/3798166)
47. [How Do AI Coding Agents Contribute to Software Development? an Empirical Study of Agentic Pull Requests · Pith](https://pith.science/paper/2607.21832)
48. [\[2108.09293\] Asleep at the Keyboard? Assessing the Security of GitHub Copilot's Code Contributions](https://arxiv.org/abs/2108.09293)
49. [Asleep at The Keyboard Assessing The Security of GitHub Copilot's Code Contributions](https://www.scribd.com/document/1041528643/Asleep-at-the-Keyboard-Assessing-the-Security-of-GitHub-Copilot-s-Code-Contributions)
50. [Asleep at the Keyboard? Assessing the Security of GitHub Copilot’s Code Contributions](https://bibbase.org/network/publication/pearce-ahmad-tan-dolangavitt-karri-asleepatthekeyboardassessingthesecurityofgithubcopilotscodecontributions-2022)
51. [AI-Generated Code Poses Major Security Risks in Nearly Half of All Development Tasks, Veracode Research Reveals](https://www.businesswire.com/news/home/20250730694951/en/AI-Generated-Code-Poses-Major-Security-Risks-in-Nearly-Half-of-All-Development-Tasks-Veracode-Research-Reveals)
52. [Veracode October 2025 Update: GenAI Code Security Report |](https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report/)
53. [Insights from 2025 GenAI Code Security Report](https://www.veracode.com/blog/genai-code-security-report/)
54. [The Six Levels of Agentic Software Engineering · Dash0](https://www.dash0.com/knowledge/the-six-levels-of-agentic-software-engineering)
55. [The 5 Levels of AI Coding Autonomy: From Spicy Autocomplete to the Dark Factory](https://www.mindstudio.ai/blog/5-levels-ai-coding-autonomy-dark-factory)
56. [Data Agents: Levels, State of the Art, and Open Problems](https://arxiv.org/pdf/2602.04261)
57. [From Assisted to Autonomous: How Far Can the Engineering Loop Close?](https://www.augmentcode.com/guides/autonomous-engineering-loop)
58. [Governed AI-Assisted Engineering: Graduated Human Oversight for Agentic Code Generation in Regulated Domains](https://arxiv.org/pdf/2606.22484)
59. [Change Enablement in ITIL 4: Definition, Practice & Best Approaches](https://itsm.tools/change-enablement/)
60. [ITIL Change Categories: Standard, Normal, and Emergency (+ Examples)](https://blog.invgate.com/what-are-the-itil-change-categories)
61. [Exam ITILFND V4 topic 1 question 45 discussion - ExamTopics](https://www.examtopics.com/discussions/itil/view/85938-exam-itilfnd-v4-topic-1-question-45-discussion/)
62. [Announcing the 2025 DORA Report](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
63. [DORA 2025: Measuring Software Delivery After AI](https://redmonk.com/rstephens/2025/12/18/dora2025/)
64. [Diff Risk Score: AI-driven risk-aware software development - Engineering at Meta](https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/)
65. [DRS-OSS: Practical Diff Risk Scoring with LLMs](https://arxiv.org/html/2511.21964v2)
66. [A Preliminary Study on Explaining Risk of Code Changes using LLM-Based Prediction Models](https://arxiv.org/pdf/2607.02782)
67. [What is CC8.1 in SOC 2 and how do you prove change management?](https://screenata.com/resources/answers/what-is-cc8-1-in-soc-2-and-how-do-you-prove-change-management)
68. [Automating Low-Risk Code Review at Meta: RADAR, Risk Calibration, and Review Efficiency](https://arxiv.org/html/2605.30208v1)

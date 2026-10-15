# Survey guide

Loaded on demand by `improve-architecture` at workflow steps 3 and 4. The design vocabulary itself
is in `references/codebase-design-vocabulary/`; this file holds only the survey questions and the
card shape.

## Find the behavior before reading its implementation

Record the revision and the named behavior or subsystem. Start with scoped path discovery
(`rg --files`) and symbol, caller and test searches (`rg -n`), then read the relevant hits rather
than concatenating a repository. Follow an entrypoint through the owning module to its caller or
interface test. Exclude generated, vendored and unrelated paths unless the behavior reaches them.
An available graph or index supplies leads only: check its revision/freshness and read source back.
State coverage limits when history, an index or a relevant area is unavailable.

Use only the supporting guide the current concern needs. Fewer files or line breaks do not prove
fewer tokens: claim a reduction only after the same correctly answered task is compared with its
instrument, source revision and loaded bytes or actual input counts recorded. Separate cached and
fresh counts where the host provides them; otherwise name that gap.

## Exploration questions

Explore organically and note where you experience friction. These are prompts, not a checklist:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow**, with an interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, while the real bugs hide in how
  they are called (no **locality**)?
- Where do tightly coupled modules leak across their seams?
- Which parts are untested, or hard to test through their current interface?
- Does changing one feature scatter domain knowledge across generic utilities, types and services?
  Show the actual call/change/test relationships before proposing a feature owner. Keep genuinely
  shared contracts with their owner; preserve a framework's established structure when it works.
- Does nesting locate a domain responsibility, or add pass-through navigation? A small cohesive
  repository may stay flat; a large cohesive module may need no surgery. A small leaking interface
  can still merit a candidate. No folder-depth, file-count or changed-line target is a finding.
- Can filenames and test suffixes follow the repository's conventions and make domain ownership
  easier to search? Preserve required route/page/index names and language conventions. A barrel or
  generic duplicate name earns its place through callers; a symbol-naming rule is not a filename rule.
- Do branch count and nesting obscure a real decision? Use an existing complexity check when
  available, recording tool/version, options, location and result. Cyclomatic complexity is not
  module depth or cognitive difficulty. A threshold belongs to the project; never extract shallow
  helpers or split a legitimate domain switch just to lower a score.
- Does a test calculate its expectation with the subject or the same helper, encode the answer in
  mocks, or assert private wiring? Name the defect it could miss and an independently specified
  observable result, error or side effect that would catch it. Preserve valuable unit/integration
  coverage and distinct invariants. Lint and coverage alone cannot establish a meaningful oracle.

Apply the **deletion test** to anything that looks shallow: would deleting it concentrate
complexity, or only move it? "Concentrates" is the signal.

Use the project's domain vocabulary for the domain and the codebase-design vocabulary for the
architecture. If the domain names an "Order", talk about "the Order intake module", not a class name
and not "the Order service".

## The candidate card

The page opens with the repository name, the date and a compact legend (a solid box is a module, a
dashed line a seam, a red arrow leakage, a thick dark box a deep module), then goes straight into
the cards with no introduction. One card per candidate:

- **Files** — the files and modules involved.
- **Evidence** — revision and `path:line` hits linking entrypoint, owner, caller/interface test and
  the observed friction. Distinguish source facts from inferences and excluded areas.
- **Problem** — why the current shape causes friction.
- **Solution** — a plain-language description of what would change. No interface proposal yet.
- **Benefits** — in terms of locality and leverage, and how tests would improve.
- **Verification and risk** — the observable outcome and existing command/probe that would prove
  it, plus compatibility or coverage limits. Consult the shared deepening guide for test strategy;
  do not invent a second TDD process or delete tests before replacement coverage exists.
- **Before and after** — a side-by-side sketch of the shallowness and the deepening, drawn inline
  so the page needs no network.
- **Strength** — one of `Strong`, `Worth exploring`, `Speculative`.
- **Decision conflict** — only where the candidate contradicts an existing `adr` and the friction is
  real enough to reopen it: name the record and say why it is worth reopening.

End with a **Top recommendation** and ask which candidate to explore. If the source shows no
worthwhile candidate, say so and stop; do not manufacture a rewrite or a tooling offer. Only after
selection can [optional linting](linting.md) be considered for that candidate's demonstrated concern.

## Where the report goes

Resolve the host's temporary directory and write a fresh file per run, named with a timestamp. Tell
the human the absolute path, and open it where the host can. The report is transient: it is never
committed, and never published to the knowledgebase.

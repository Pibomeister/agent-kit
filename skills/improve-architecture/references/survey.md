# Survey guide

Loaded on demand by `improve-architecture` at workflow steps 3 and 4. The design vocabulary itself
is in `references/codebase-design-vocabulary/`; this file holds only the survey questions and the
card shape.

## Exploration questions

Explore organically and note where you experience friction. These are prompts, not a checklist:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow**, with an interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, while the real bugs hide in how
  they are called (no **locality**)?
- Where do tightly coupled modules leak across their seams?
- Which parts are untested, or hard to test through their current interface?

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
- **Problem** — why the current shape causes friction.
- **Solution** — a plain-language description of what would change. No interface proposal yet.
- **Benefits** — in terms of locality and leverage, and how tests would improve.
- **Before and after** — a side-by-side sketch of the shallowness and the deepening, drawn inline
  so the page needs no network.
- **Strength** — one of `Strong`, `Worth exploring`, `Speculative`.
- **Decision conflict** — only where the candidate contradicts an existing `adr` and the friction is
  real enough to reopen it: name the record and say why it is worth reopening.

End the report with a **Top recommendation**: the candidate to take first, and why. Then ask the
human which one to explore.

## Where the report goes

Resolve the host's temporary directory and write a fresh file per run, named with a timestamp. Tell
the human the absolute path, and open it where the host can. The report is transient: it is never
committed, and never published to the knowledgebase.

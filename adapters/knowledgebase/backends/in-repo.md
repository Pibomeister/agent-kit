# Binding `in-repo` — a read-only knowledgebase committed in the project's own repository

A backend binding under `adapters/knowledgebase/CONTRACT.md` §7. Everything generic — the seven
operations, the two artifact classes, centrality — is the contract's; this document states only how
this one binding meets it. The code is `src/kb/in-repo.ts`.

**Carries:** `readContext`. A publish is **skipped** (§4); the other five operations refuse.

**Needs:** `git` on `PATH`. No registration, no network, no service and no credential.

---

## 1. The binding

```yaml
# ak.kb.yaml, at the project root, committed
backend: in-repo
project: example-project       # the project_ref id the result names
locator:
  knowledgebase: example-wiki  # a name for the knowledgebase, reported by check and read
  path: docs/wiki              # relative to the folder holding ak.kb.yaml; never a machine path
  base: main                   # the branch whose merge with HEAD is the revision read
  kinds:                       # kind -> directory under path; an unmapped directory is never read
    concept: concepts
    system: systems
    adr: decisions
```

`schemas/kb-backends/in-repo.schema.json` refuses a path or directory that is absolute, carries a
backslash, or has a `.` or `..` segment; a kind outside the nine; an empty `kinds`; and a base that
is not a branch name. `ak kb check` also refuses a `kinds` map in which one directory equals or
contains another, so no page is read under two kinds (`kb.binding-invalid`).

## 2. No setup

The binding is the whole setup. Nothing is registered: every checkout and every task copy of the
project reads its own committed tree, so `ak kb register` has no part here.

## 3. `readContext`

`ak kb read --kind <kind>[,<kind>…] --scope <scope>`

- **The revision read is the merge-base of `HEAD` and the base**, the base being
  `refs/remotes/origin/<base>`, else `refs/heads/<base>`. A page a branch adds or edits, and any
  status it sets, is not knowledge until it is merged, as a page drafted in a local-git checkout is
  not. Working files are never read.
- **Pages.** The regular `.md` files under each requested kind's directory, its subdirectories
  included, `index.md` excepted. Every page is filed at scope `project`, so any valid scope returns
  them (the scope and every scope above it).
- **Each page.** `id` is the file stem and must be kebab-case. `title` is front matter `title`, else
  the first `# ` heading, else the id. `body` is the text after front matter. `content_hash` is
  computed as local-git computes it, and `revision` is the last commit at the revision read that
  changed the file. The ref is `doc:project/<kind>/<id>`.
- **Status** is the first declaration among front matter `status`, an inline `**Status:** …` and
  the first line of a `## Status` section, as its first word lowercased. It is kept when it is
  `accepted`, `superseded`, `deprecated`, `rejected` or `proposed`; anything else, or nothing, reads
  as `unreviewed`. The declared word is returned as `declared_status` (null when none).
- **Coverage.** A stem that is not kebab-case, every copy of a stem repeated within one kind, and a
  page whose front matter does not parse are named in `coverage.unreadable`, by path from the
  project folder, and not returned.
- **Not carried:** narrowing by tag, revision or recency, and run-artifact links
  (`run_artifact_links: not-selected`).

## 4. A publish is skipped

`ak kb publish document …` and `ak kb publish artifact …`, with or without `--trail-attempts`, exit
3 with `status: skipped`, `capability: kb-write` and `code: kb.read-only`. Nothing is read from the
file, no attempt is marked and nothing is written anywhere. That is a coverage limit, not a
refusal: the phase names the record as not published and continues
(`references/knowledgebase-binding/REFERENCE.md`).

## 5. A missing knowledgebase

A project not in a git work tree, a base that resolves to nothing, a `HEAD` that shares no history
with it, or a path that is not a directory at the revision read: `ak kb check`, `read` and `publish`
exit 3 with `kb.in-repo-missing`, a coverage limit, and the message names the fix.

## 6. Why the application repository is allowed here

Contract §3 refuses a knowledgebase inside the application repository because a publish through it
would write project knowledge into that repository. This binding has no write path, so that cannot
happen: agent-kit still writes nothing into the application repository.

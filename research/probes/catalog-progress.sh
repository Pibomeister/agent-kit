#!/usr/bin/env bash
#
# What fraction of the catalog is authored, derived rather than remembered.
#
# This repository has paid three times for a figure written into prose and
# left there: two dossier line counts that said 2264 when the file was 2265,
# and a §5 passage that named both of them as examples of the defect after
# they had been repaired. A count that can be derived should never be
# transcribed, because the transcription has no way to notice it went stale.
#
#   ./research/probes/catalog-progress.sh           # working tree
#   ./research/probes/catalog-progress.sh 7a83f25   # any revision
#
# WHAT IT COMPARES AGAINST
#
# The baseline: the count for each section that catalog.yaml first declared at
# a185bd1 -- 33 skills, 8 packs, 7 protocols, 29 roles, 4 reference packs, 14
# schemas, 5 policies, 4 profiles and 4 adapters. It is duplicated below, which
# is the one transcription this script cannot avoid, and where the baseline
# commit is reachable the script checks the duplicate against it. The baseline
# is that commit, not the arch plan in research/sources/, whose own lists
# differ (it names 11 schema files and 6 adapters).
#
# A section is allowed to grow past the baseline only through
# research/probes/catalog-expansions.yaml, which records each added id with
# the reason and the commit or decision record that added it. The target a
# section is compared against is the baseline count plus the ids recorded
# there, so a recorded expansion reads clean and an unrecorded one still flags.
#
# Recording rather than moving the numbers below is the deliberate part: a
# permanent DISAGREEMENT row is a broken exit status that everyone learns to
# read past, and a target moved in place loses the reason it moved. The script
# once carried two such reasons in this comment (the case and rulings schemas);
# they now live in the expansions file beside every other one.
#
# A record cannot explain a difference it did not cause. The probe flags a
# recorded id missing from its catalog section, a recorded `baseline` or
# `catalog` figure that no longer matches, a recorded id the baseline catalog
# already had, and a cited commit that does not resolve or whose catalog.yaml
# change does not add the ids it is cited for. The history checks need the
# baseline and the cited commits; in a shallow clone that lacks them, they are
# reported as skipped rather than guessed. A clone that has the baseline but
# not every cited commit skips only what depends on the missing ones.
# CATALOG_BASELINE names another baseline commit, which the tests use on
# fixture repositories.
#
# Output: the table on stdout, one `EXPANDED` line per section with recorded
# expansions, one `SKIPPED` line per history check a shallow clone cannot run,
# and `DISAGREEMENT <code> <section>` lines on stderr with exit status 1.
#
# WHAT IT DOES NOT TELL YOU
#
# `status: authored` means a body exists and the entry says so. It does not
# mean the body passed review, that its evals are tagged, or that anything is
# correct. `ak validate` answers the first; `evals.uncovered-scenarios`
# answers the second and answers it over the whole corpus rather than per
# skill, which is a distinction that has already produced one checkpoint gate
# reading green on a skill that has no case at all. Progress here is progress
# through the authoring queue and nothing more.
set -euo pipefail

REV="${1:-}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
EXPANSIONS="research/probes/catalog-expansions.yaml"

if [ -n "$REV" ]; then
  if ! SHA="$(git rev-parse --verify --quiet "${REV}^{commit}")"; then
    echo "catalog-progress: '${REV}' is not a commit in this repository." >&2
    exit 1
  fi
  SRC="$(mktemp)"
  trap 'rm -f "$SRC"' EXIT
  # ${SHA}:catalog.yaml, braced: in zsh a bare $SHA:catalog.yaml is read as a
  # parameter modifier and expands to nothing, which returns an empty file for
  # every revision and looks like a catalog that lost all its entries.
  git show "${SHA}:catalog.yaml" > "$SRC"
  EXP="$(mktemp)"
  trap 'rm -f "$SRC" "$EXP"' EXIT
  # A revision from before the expansions file existed has no expansions.
  git show "${SHA}:${EXPANSIONS}" > "$EXP" 2>/dev/null || : > "$EXP"
  SUBJECT="$SHA"
else
  SRC="catalog.yaml"
  EXP="$EXPANSIONS"
  [ -f "$EXP" ] || EXP=/dev/null
  SUBJECT="working tree"
  [ -n "$(git status --porcelain -- catalog.yaml)" ] && SUBJECT="working tree (catalog.yaml modified)"
fi

SUBJECT="$SUBJECT" BASELINE_REV="${CATALOG_BASELINE:-a185bd1}" python3 - "$SRC" "$EXP" <<'PY'
import os, subprocess, sys, yaml, collections, functools

BASELINE = {
    "skills": 33, "packs": 8, "protocols": 7, "roles": 29, "references": 4,
    "schemas": 14, "policies": 5, "profiles": 4, "adapters": 4,
}

# Both loaders use the safe YAML constructors; use libyaml when available to
# avoid interpreting each historical catalog token in Python under CPU load.
SafeLoader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
catalog = yaml.load(open(sys.argv[1]), Loader=SafeLoader)
expansions = yaml.load(open(sys.argv[2]), Loader=SafeLoader) or {}
mismatches = []
expanded = []
skipped = []

def disagree(code, section, detail):
    mismatches.append(f"{code}  {section}  {detail}")

def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None

@functools.lru_cache(maxsize=None)
def catalog_at(rev):
    """Read and parse each revision's catalog once per probe run."""
    text = git("show", f"{rev}:catalog.yaml")
    if text is None:
        return None
    return yaml.load(text, Loader=SafeLoader) or {}

def ids_at(rev, section):
    """The ids in one catalog section at a revision, or None when it cannot be read."""
    doc = catalog_at(rev)
    if doc is None:
        return None
    return {e.get("id") for e in doc.get(section) or [] if isinstance(e, dict)}

@functools.lru_cache(maxsize=None)
def resolve(rev):
    out = git("rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    return out.strip() if out else None

baseline_rev = os.environ["BASELINE_REV"]
baseline_sha = resolve(baseline_rev)
shallow = (git("rev-parse", "--is-shallow-repository") or "").strip() == "true"
history = baseline_sha is not None
if not history:
    if shallow:
        skipped.append(f"history checks: baseline {baseline_rev} is not in this shallow clone")
    else:
        disagree("baseline-unresolved", "-", f"baseline {baseline_rev} does not resolve to a commit")

if history:
    for section, n in BASELINE.items():
        at = ids_at(baseline_sha, section)
        if at is not None and len(at) != n:
            disagree("baseline-count-differs", section, f"baseline {n} here, {len(at)} at {baseline_rev}")

TARGETS = dict(BASELINE)
for section, record in expansions.items():
    if section not in BASELINE:
        disagree("unknown-section", section, "expansions recorded for a section the baseline does not count")
        continue
    if record.get("baseline") != BASELINE[section]:
        disagree("baseline-figure-stale", section, f"record says baseline {record.get('baseline')}, the probe says {BASELINE[section]}")
    entries = record.get("expansions") or []
    ids = [i for e in entries for i in e.get("ids") or []]
    present = {e.get("id") for e in catalog.get(section) or [] if isinstance(e, dict)}
    for i in ids:
        if i not in present:
            disagree("id-absent", section, f"recorded expansion {i} is not in catalog.yaml")
    TARGETS[section] = BASELINE[section] + len(ids)
    if record.get("catalog") != TARGETS[section]:
        disagree("catalog-figure-stale", section, f"record says catalog {record.get('catalog')}, baseline {BASELINE[section]} plus {len(ids)} recorded is {TARGETS[section]}")
    expanded.append(f"{section}  baseline {BASELINE[section]} + {len(ids)} recorded = {TARGETS[section]}")
    if not history:
        continue
    before = ids_at(baseline_sha, section) or set()
    for i in ids:
        if i in before:
            disagree("id-in-baseline", section, f"recorded expansion {i} is already in the baseline catalog at {baseline_rev}")
    for e in entries:
        added = set()
        # An entry with a cited commit this clone cannot check may owe its ids
        # to that commit, so only its id-not-added check is skipped; the
        # commits that do resolve are still checked.
        unchecked = False
        for c in e.get("commits") or []:
            sha = resolve(str(c))
            if sha is None:
                if shallow:
                    skipped.append(f"{section}: commit {c} is not in this shallow clone")
                    unchecked = True
                else:
                    disagree("commit-unresolved", section, f"cited commit {c} does not resolve")
                continue
            parent = resolve(f"{sha}^")
            if parent is None and shallow:
                # A shallow boundary: the parent exists but was not fetched, and
                # reading it as empty would credit the commit with every id.
                skipped.append(f"{section}: the parent of commit {c} is not in this shallow clone")
                unchecked = True
                continue
            after = ids_at(sha, section) or set()
            prior = (ids_at(parent, section) or set()) if parent is not None else set()
            mine = (after - prior) & set(e.get("ids") or [])
            if not mine:
                disagree("commit-does-not-add", section, f"cited commit {c} adds none of {', '.join(e.get('ids') or [])} to catalog.yaml")
            added |= mine
        for i in e.get("ids") or []:
            if i not in added and not unchecked:
                disagree("id-not-added-by-cited-commit", section, f"no cited commit adds {i} to catalog.yaml")

print(f"catalog progress at {os.environ['SUBJECT']}")
print()
print(f"  {'section':12} {'authored':>8} {'contract':>9} {'total':>6} {'target':>7}")

grand_a = grand_t = 0
for section, target in TARGETS.items():
    entries = catalog.get(section)
    if not isinstance(entries, list):
        disagree("section-absent", section, f"absent from catalog.yaml, target {target}")
        continue
    counts = collections.Counter(
        e.get("status") for e in entries if isinstance(e, dict)
    )
    authored, contract, total = counts["authored"], counts["contract"], len(entries)
    grand_a += authored
    grand_t += total
    flag = "" if total == target else "  <-- disagrees with the baseline and its recorded expansions"
    print(f"  {section:12} {authored:>8} {contract:>9} {total:>6} {target:>7}{flag}")
    if total != target:
        disagree("count-differs", section, f"catalog has {total}, baseline {BASELINE[section]} plus recorded expansions says {target}")
    unexpected = {s: n for s, n in counts.items() if s not in ("authored", "contract")}
    if unexpected:
        print(f"  {'':12} statuses that are neither: {unexpected}")

pct = (100 * grand_a / grand_t) if grand_t else 0
print(f"  {'TOTAL':12} {grand_a:>8} {'':>9} {grand_t:>6}         {pct:.0f}% authored")

by_batch = collections.Counter()
for entry in catalog.get("skills") or []:
    by_batch[(entry.get("batch"), entry.get("status"))] += 1
batches = sorted({b for b, _ in by_batch}, key=lambda b: (b is None, b))
if batches:
    print()
    print("  skills by batch:")
    for b in batches:
        row = {s: n for (bb, s), n in by_batch.items() if bb == b}
        done = "landed" if set(row) == {"authored"} else "open"
        print(f"    batch {str(b):>4}  {row}  {done}")

if expanded or skipped:
    print()
    for e in expanded:
        print(f"  EXPANDED  {e}")
    for s in skipped:
        print(f"  SKIPPED  {s}")

if mismatches:
    print()
    for m in mismatches:
        print(f"  DISAGREEMENT  {m}", file=sys.stderr)
    sys.exit(1)
PY

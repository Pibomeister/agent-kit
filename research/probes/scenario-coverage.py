#!/usr/bin/env python3
"""Which of plan §10's release scenarios each index names, and which it does not.

Two indexes cover the same scenarios from different directions.
`policies/resolved-conflicts.yaml` names one in a ruling's `scenario:` field when a
tension had to be resolved; `provenance/conversation-map.yaml` names one in a row's
`acceptance_test` when a capability is what the scenario tests. A scenario with no
ruling usually means the sources agreed, and agreement is not a tension -- it is a
capability with a destination, which is the map's job rather than a gap in it.

WHAT A CLEAN RUN IS EVIDENCE OF
-------------------------------
That every numbered scenario is *named* somewhere. That is all. Naming is not
satisfaction: a row that cites scenario 7 asserts the capability landed, and this
probe does not read the body, run the acceptance test, or check the citation is
apt. Nor does it weigh the two indexes -- one row and one ruling both count as
one mention. Read a clean run as evidence that no scenario has been forgotten by
both indexes at once, and as evidence of nothing further.

WHY IT EXISTS: THE MANUAL VERSION GOT IT WRONG
----------------------------------------------
This was proposed after a hand cross-check concluded the map named 23 of 24 and
that scenario 19 was ruling-only, making the indexes complementary in both
directions. The map in fact names all 24 and the rulings' 16 are a strict subset.
The miss was scenario 19, which appears as `release scenarios 19 and 20` -- a
plural the singular grep did not match.

That is the whole argument for mechanising this. The map tags scenarios in **prose,
not a field**, and three spellings are already in use: `release scenario N`,
`release scenarios N and M`, and a bare plural. A field would be checkable by
schema; prose is checkable only by something that knows every spelling, and a
reader counting by hand will reach for one of them. Nothing validates that a named
number exists either, so `release scenario 25` would read as coverage.

The scenario total is read from plan §10's numbered list rather than written here,
because a count in a docstring goes stale silently while looking authoritative.

Exit 1 on a scenario named by an index that plan §10 does not have -- a dangling
reference, which is wrong rather than merely uncovered -- and on a §10 that yields
no scenarios at all, which means this probe has lost its subject and its other
numbers are not worth reading. An uncovered scenario is reported and does not
fail: on coverage this probe reports, it does not gate.
"""
import io
import re
import sys

import yaml

PLAN = "research/sources/engineering-skills-repo-plan.md"
MAP = "provenance/conversation-map.yaml"
RULINGS = "policies/resolved-conflicts.yaml"

# `## 10. Evaluation and release gates`, then `1.`-prefixed list items beneath it.
SECTION_10 = re.compile(r"^#{2,6}\s+(?:§\s*)?10[.\s)]")
NEXT_SECTION = re.compile(r"^#{2,6}\s+(?:§\s*)?\d+(?:\.\d+)*[.\s)]")
NUMBERED = re.compile(r"^\s*(\d+)\.\s+\S")
# Both spellings, singular and plural, with the number run captured whole so
# `scenarios 19 and 20` yields two scenarios rather than one.
MENTION = re.compile(r"release scenarios?\s+([0-9][0-9,\s]*(?:and\s+\d+)?)")
ROW = re.compile(r"^  - id:", re.M)


def scenarios(path):
    """The numbered release scenarios in plan §10, as {number: text}."""
    lines = io.open(path, encoding="utf8").read().split("\n")
    out, inside = {}, False
    for line in lines:
        if SECTION_10.match(line):
            inside = True
            continue
        if inside and NEXT_SECTION.match(line):
            break
        if inside and (m := NUMBERED.match(line)):
            out[int(m.group(1))] = line.strip()[len(m.group(1)) + 2 :].strip()
    return out


def ruled(path):
    """Scenario numbers named by a ruling's `scenario:` field, and how many rulings exist.

    The denominator is returned because without it `0 named by a ruling` is two
    states wearing one line: no rulings at all, and rulings none of which names a
    scenario. The second is a finding; the first is a vacuous run.
    """
    doc = yaml.safe_load(io.open(path, encoding="utf8").read())
    out, total = set(), 0
    for group in doc.values():
        if not isinstance(group, list):
            continue
        for ruling in group:
            if not isinstance(ruling, dict) or "id" not in ruling:
                continue
            total += 1
            if isinstance(ruling.get("scenario"), int):
                out.add(ruling["scenario"])
    return out, total


def mapped(path):
    """Scenario numbers named in prose by any map row, and how many rows exist.

    Same reason as `ruled`. These are prose mentions rather than a field, so a
    changed house spelling makes every row stop contributing at once -- and
    without the row count that prints as a coverage gap rather than as this
    probe having lost its grip on the file.
    """
    text = io.open(path, encoding="utf8").read()
    out = set()
    for m in MENTION.finditer(text):
        out.update(int(n) for n in re.findall(r"\d+", m.group(1)))
    return out, len(ROW.findall(text))


def main():
    plan = scenarios(PLAN)
    known = set(plan)
    (in_rulings, n_rulings), (in_map, n_rows) = ruled(RULINGS), mapped(MAP)

    # Without this, a renumbered or retitled §10 parses to nothing and every
    # reference in both indexes reads as dangling -- 24 confident accusations
    # naming the wrong defect. An instrument that cannot find its subject says so.
    if not known:
        print(f"Found no numbered scenarios under §10 of {PLAN}.")
        print("The section moved, was renumbered, or its list stopped being numbered.")
        print("Fix the probe against the plan's current shape; its output until then means nothing.")
        return 1

    dangling = sorted((in_rulings | in_map) - known)
    for n in dangling:
        where = " and ".join(w for w, s in (("a ruling", in_rulings), ("a map row", in_map)) if n in s)
        print(f"DANGLING  scenario {n} is named by {where} and is not in plan §10")

    print(f"{'scenario':10s} {'ruling':>7s} {'map':>5s}  text")
    for n in sorted(known):
        r = "yes" if n in in_rulings else ""
        m = "yes" if n in in_map else ""
        print(f"{n:<10d} {r:>7s} {m:>5s}  {plan[n][:58]}")

    covered = (in_rulings | in_map) & known
    uncovered = sorted(known - covered)
    print()
    print(
        f"{len(known)} scenarios. {len(in_rulings & known)} named by a ruling "
        f"(of {n_rulings} rulings), {len(in_map & known)} named by a map row "
        f"(of {n_rows} rows), {len(covered)} by at least one."
    )
    # A populated source contributing nothing is this probe losing its grip, not
    # a gap in the tree, and the two read identically without the denominators
    # above. Keyed on the source having members rather than on the tally being
    # zero, because a guard that keys on the wrong term reproduces the fault it
    # was added to prevent.
    silent = False
    for name, total, named in (("rulings", n_rulings, in_rulings), ("map rows", n_rows, in_map)):
        if total > 0 and not named:
            silent = True
            print(f"SILENT    all {total} {name} exist and none names a scenario; suspect this probe, not the tree.")
    if uncovered:
        print(f"Named by neither: {', '.join(str(n) for n in uncovered)}.")
    # Do not soften this into a summary line. It is load-bearing at the batch-5
    # checkpoint, where the question is whether the evals exercise scenarios 7
    # and 20 -- not whether something names them. A run that prints 24/24 and
    # stops invites exactly the reading this sentence exists to block, and the
    # reader most likely to be misled is the one who trusts the number because
    # a probe produced it. Requested kept verbatim by team-lead; if a later
    # edit needs the wording changed, the claim it makes has to survive.
    print("Named is not satisfied: this reads two indexes, not the bodies they point at.")
    # SILENT exits 1 for the same reason the unparseable-§10 guard above does, and
    # they were inconsistent until someone described this probe's exit convention
    # back to me. Both mean the instrument lost its grip on a source, and in both
    # the coverage numbers underneath are not worth reading. An uncovered scenario
    # still exits 0: that is a fact about the tree, which this probe reports and
    # does not gate. The line between them is whether the probe is reporting on
    # the tree or on itself.
    return 1 if dangling or silent else 0


if __name__ == "__main__":
    sys.exit(main())

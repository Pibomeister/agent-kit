# How to run T4 held-out eval

The code in this tree supplies the evidence schema, an empty template, and
`scripts/t4-held-out.sh evidence`. That command always prints G3 as `not-run`.
A human records G3.

Do not copy or edit `research/held-out/evidence.template.json` to mark a pass.

## 0. Curator

An evaluation curator holds 24 documents outside author and reviewer access.
12 are defects. 12 are controls. The keys never enter this repository.

Record where the corpus lives on the evidence record as `corpus.location`.
Until that field is a path the curator attests, location stays `null`.

## 1. Harness

From the repository root:

```bash
scripts/t4-held-out.sh evidence
```

The printed verdict is `not-run`. `metrics.material_recall` is `null`.
`adjudication.records` is empty. `scores` is `null`. Agents stop here.

## 2. Blind adjudication

Two adjudicators score independently. They do not see author summaries.
They do not see each other's scores until both have recorded.

The domain owner breaks ties. That person is the `tie_breaker`.

Each host needs 144 runs. That is 24 documents, 3 reps, and the remaining
factor the plan's section 10 names. Do not invent the missing factor.
Write the factor into the published scores when the curator names it.

## 3. Publish

Publish blinded scores. An author summary is not the record.

Fill `metrics.material_recall` from those scores. Plan section 10 names
further metrics. Leave any unnamed metric off this record rather than
guessing its key.

## 4. Record G3

A human sets `verdict` to `passed` or `failed` on a copy of the evidence
that already has curator location, adjudication records, and scores.
The command in this tree will not write that copy.

# How to run T7 pilot

The code in this tree supplies the evidence schema, an empty template, and
`scripts/t7-pilot.sh evidence`. That command always prints G5 as `not-run`.
A human records G5.

Do not copy or edit `research/t7-pilot/evidence.template.json` to mark a pass.
Do not invent a pilot repository in this tree.

## 0. Maintainer

The maintainer names two real repositories and a matched baseline.
Those names go on `pilot.repos` and `pilot.matched_baseline`.
Until the maintainer writes them, both stay empty.

The maintainer owns product decisions and disputed adjudication.

## 1. Harness

From the repository root:

```bash
scripts/t7-pilot.sh evidence
```

The printed verdict is `not-run`. `pilot.repos` is empty. `measures` are
`null`. Agents stop here.

## 2. Twenty real changes

Run 20 real changes across those two repositories.
Agents implement only under existing authority.
They do not choose the repos. They do not record rework.

## 3. Human measures

Humans record rework, cost and attention.
Each measure's `recorder` is `human`. The schema refuses any other recorder.

## 4. Record G5

A human sets `verdict` to `passed` or `failed` on a copy that already has
two named repos, a matched baseline, 20 changes, and human measures.
The command in this tree will not write that copy.

The passed record shape is provisional. Plan section 10 does not name
change-record keys. No gate may treat `parseT7Evidence` plus `verdict`
passed as proof until the maintainer names those keys.

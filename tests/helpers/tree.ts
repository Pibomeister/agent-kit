import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DENY_TERMS, PLACEHOLDER_TERMS } from "../../src/denylist.ts";

/** Build a throwaway repo root from a path -> contents map. */
export function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ak-tree-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

/**
 * A `SKILL.md` that satisfies AUTHORING.md §3, for trees whose subject is
 * something else.
 *
 * Scaffolding, not a fixture under test: these are the bodies in trees asserted
 * to validate clean, so every one of them has to carry the ten headings in order
 * and §3.1's table under `## Hard gates` for the tree to be clean for the reason
 * the test means.
 *
 * The headings are spelled out here rather than built from `SKILL_SECTIONS`. A
 * body generated from the constant the check reads is clean under any value of
 * that constant, including a wrong one, so deriving it would make every tree
 * below agree with the implementation instead of with §3.
 *
 * Every caller catalogs the skill as user-invoked, so the body also carries what
 * `human-start` reads: the description names `/ak:<name>` and the class, and the
 * first workflow step is the stop (AUTHORING.md §4.1).
 */
export function wellFormedSkill(name: string, description: string, preamble: string): string {
  return `---
name: ${name}
description: >-
  Human-started command: it runs only when the human's message begins with \`/ak:${name}\`. On any
  other request do not load or follow it; tell the human to type that command.
  ${description}
---

# ${name}

${preamble}

## When to use

When a human asks for the ${name} workflow on a ticket that already exists.

## Not for

Not for a request that names no ticket. Not for a second run against a ticket that already carries
a receipt. Not for a request to edit a file.

## Authority

Authority: \`explicit\`. A human starts it.

## Inputs

The ticket the request names. Absent: stop and report \`needs-input\`.

## Workflow

1. Check how this run was started. It is started only when the human's message begins with
   \`/ak:${name}\`. Otherwise stop, name the command and do nothing else.
2. Read the named ticket and record its id.
3. Produce the receipt and return it.

## Hard gates

Gate: no ticket, no run.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The ticket is obviously the one just discussed." | A ticket named in conversation is not a ticket that exists. | Stop and report \`needs-input\`. |

## Outputs

One receipt, published through the knowledgebase adapter.

## Side effects

\`artifact-write\`.

## Stop conditions

Stop when the workflow has produced its receipt.

## Limits

Runs per ticket: 1 (gate).
`;
}

/**
 * The denied strings used by the invalid fixtures.
 *
 * Committed fixture files carry the markers `__DENY_MODEL_TERM__` and
 * `__PLACEHOLDER_TERM__` instead of a real model name or a real unfinished
 * marker, so no tracked file under tests/ contains either. They are
 * substituted from src/denylist.ts when the fixture is materialized, which
 * also means the fixtures exercise whatever the current denylist actually
 * says rather than a copy of it that can drift.
 */
export const DENY_MARKER = "__DENY_MODEL_TERM__";
export const PLACEHOLDER_MARKER = "__PLACEHOLDER_TERM__";

export function sampleModelTerm(): string {
  const term = DENY_TERMS.find((t) => t.kind === "model-name");
  if (term === undefined) throw new Error("denylist has no model-name term");
  return term.probe;
}

export function samplePlaceholderTerm(): string {
  const term = PLACEHOLDER_TERMS[0];
  if (term === undefined) throw new Error("denylist has no placeholder term");
  return term.probe;
}

function substituteInPlace(dir: string, from: string, to: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      substituteInPlace(full, from, to);
      continue;
    }
    const text = readFileSync(full, "utf8");
    if (text.includes(from)) writeFileSync(full, text.split(from).join(to));
  }
}

/** Copy a committed fixture tree to a temp root, substituting the denied strings. */
export function materializeFixture(relPath: string): string {
  const source = join(import.meta.dir, "..", "fixtures", relPath);
  const root = mkdtempSync(join(tmpdir(), "ak-fixture-"));
  cpSync(source, root, { recursive: true });
  substituteInPlace(root, DENY_MARKER, sampleModelTerm());
  substituteInPlace(root, PLACEHOLDER_MARKER, samplePlaceholderTerm());
  return root;
}

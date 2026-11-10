/**
 * Predecessor reconciliation oracle for doc-review (FR-02 / AT-03).
 *
 * A successor is checked against a named predecessor for seed omission,
 * contradiction, and material addition. Alternatives are seeds like any other:
 * dropping one is an omission. Findings cite artifact id, seed id and line,
 * not the surrounding prose.
 */

const SEED_LINE = /^(?:[-*] |\d+\. )?(R|D|ALT)(\d+[a-z]?)\.\s+(.*)$/;

export type SeedKind = "requirement" | "decision" | "alternative";

export type Seed = {
  readonly id: string;
  readonly kind: SeedKind;
  readonly statement: string;
  readonly line: number;
};

export type SeedRef = {
  readonly artifact: string;
  readonly seed: string;
  readonly line: number;
};

export type ReconcileKind = "omission" | "contradiction" | "material-addition";

export type ReconcileFinding = {
  readonly kind: ReconcileKind;
  readonly seed: string;
  readonly predecessor: SeedRef | null;
  readonly successor: SeedRef | null;
};

function kindOf(prefix: string): SeedKind {
  if (prefix === "D") return "decision";
  if (prefix === "ALT") return "alternative";
  return "requirement";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ref(artifact: string, seed: Seed): SeedRef {
  return { artifact, seed: seed.id, line: seed.line };
}

/** ID-bearing seeds in document order. Heading-like wrapping is not a seed. */
export function parseSeeds(markdown: string): readonly Seed[] {
  const seeds: Seed[] = [];
  for (const [index, raw] of markdown.split("\n").entries()) {
    const match = SEED_LINE.exec((raw ?? "").trim());
    if (match === null) continue;
    const prefix = match[1] ?? "";
    const number = match[2] ?? "";
    const statement = collapse(match[3] ?? "");
    if (statement.length === 0) continue;
    seeds.push({
      id: `${prefix}${number}`,
      kind: kindOf(prefix),
      statement,
      line: index + 1,
    });
  }
  return seeds;
}

function firstById(seeds: readonly Seed[]): Map<string, Seed> {
  const out = new Map<string, Seed>();
  for (const seed of seeds) {
    if (!out.has(seed.id)) out.set(seed.id, seed);
  }
  return out;
}

/**
 * Compare successor seeds to the named predecessor. Duplicate ids in one
 * document keep the first occurrence; later repeats are the same seed.
 */
export function reconcilePredecessor(
  predecessorId: string,
  predecessorText: string,
  successorId: string,
  successorText: string,
): readonly ReconcileFinding[] {
  const prior = firstById(parseSeeds(predecessorText));
  const next = firstById(parseSeeds(successorText));
  const findings: ReconcileFinding[] = [];

  for (const [id, seed] of prior) {
    const later = next.get(id);
    if (later === undefined) {
      findings.push({
        kind: "omission",
        seed: id,
        predecessor: ref(predecessorId, seed),
        successor: null,
      });
      continue;
    }
    if (later.statement !== seed.statement) {
      findings.push({
        kind: "contradiction",
        seed: id,
        predecessor: ref(predecessorId, seed),
        successor: ref(successorId, later),
      });
    }
  }

  for (const [id, seed] of next) {
    if (prior.has(id)) continue;
    findings.push({
      kind: "material-addition",
      seed: id,
      predecessor: null,
      successor: ref(successorId, seed),
    });
  }

  return findings;
}

export function findingsOfKind(
  findings: readonly ReconcileFinding[],
  kind: ReconcileKind,
): readonly ReconcileFinding[] {
  return findings.filter((finding) => finding.kind === kind);
}

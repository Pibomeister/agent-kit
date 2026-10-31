/** A dispatch's identity for the independence checks: who answered and the lineage that produced it. */
export interface Lineaged {
  actor: string;
  lineage: string[];
}

// CONTRACT.md §3: neither supervisor's lineage may name the other supervisor's actor.
export function sharesLineage(a: Lineaged, b: Lineaged): boolean {
  return a.actor === b.actor || a.lineage.includes(b.actor) || b.lineage.includes(a.actor);
}

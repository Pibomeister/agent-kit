import { join } from "node:path";

import { readTextIfPresent } from "../util/fs.ts";
import { error, unavailable, type Issue } from "../validation/types.ts";
import type { SkillMode } from "./hosts.ts";

/**
 * The one file that states what each host supplies, for every host.
 *
 * Not `adapters/<host>/CONTRACT.md`. `adapters/codex/CONTRACT.md` §3 says
 * outright that "every `common#/$defs/capability` value carries the status
 * `adapters/claude-code/CONTRACT.md` §3 gives it, with no per-capability
 * difference on this host", and gives the reason there is no second copy: "the
 * copy that decided would be whichever one the code read". So the code reads
 * the one. What differs per host is which *restrictions* it enforces, which is
 * `hosts.ts`'s `enforces` set and a different question.
 */
export const CAPABILITY_TABLE_FILE = "adapters/claude-code/CONTRACT.md";

/** The check that does not run when the table cannot be read. */
export const MODE_CEILING_CHECK = "skill mode ceilings";

/**
 * §3's Status column, which that section calls a controlled vocabulary and
 * states once.
 *
 * Restated here because a parser has to recognise the values, and §3 makes the
 * consequence of a value outside them explicit: "Nuance belongs in **Detail**,
 * never in Status, because a compound status is a value no consumer can act
 * on." An unrecognised status is reported rather than coerced, because every
 * coercion available is a guess -- read as `satisfied` it certifies a skill
 * against a host that may not supply what it needs, and read as `not-provided`
 * it caps a skill the host may serve perfectly.
 */
export type CapabilityStatus = "satisfied" | "partial" | "convention-only" | "not-provided";

export const CAPABILITY_STATUSES: ReadonlyArray<CapabilityStatus> = [
  "satisfied",
  "partial",
  "convention-only",
  "not-provided",
];

function isStatus(value: string): value is CapabilityStatus {
  return (CAPABILITY_STATUSES as ReadonlyArray<string>).includes(value);
}

/**
 * The statuses under which a required capability caps a skill's autonomy.
 *
 * One set, in one place, because the alternative reading is defensible and the
 * choice between them has to be visible rather than spread across an
 * expression. Under the strict reading anything short of `satisfied` caps, and
 * `partial` would then cap: §3 gives `artifact-write` that status, and every
 * skill that emits a run artifact requires it, so most ceilings in this tree
 * would come out `guided` by construction rather than because any host
 * withheld anything. A ceiling that is `guided` for everything
 * is an instrument returning the same answer under both hypotheses.
 *
 * `not-provided` is what §4's own worked example uses. It names `runner-grants`
 * and `event-delivery` as the reason `profiles/autonomy` "does not install
 * against this host on its own", and §3 gives both of those exactly that
 * status. `partial` and `convention-only` are statuses §3 attaches a *stated
 * limitation* to -- the host does the thing and does not guarantee a property
 * of it -- and the package's own protocols are what §3's Detail column points
 * at for each, so those are limitations the package already answers for.
 *
 * Measured before it was chosen: on all 26 skill-adapter rows in this tree the
 * two readings give the identical ceiling, because every skill requiring a
 * `partial` capability also requires a `not-provided` one. The choice is not
 * observable here, which is exactly why it is argued from the contract.
 */
const BLOCKING: ReadonlySet<CapabilityStatus> = new Set<CapabilityStatus>(["not-provided"]);

export function blockingStatuses(): ReadonlySet<CapabilityStatus> {
  return BLOCKING;
}

export interface CapabilityTable {
  /**
   * Whether §3's table was found and had rows in it.
   *
   * False is never "nothing is provided" and never "everything is provided" --
   * it is a question with no answer, and `ceilingFor` returns no ceiling rather
   * than either of those.
   */
  available: boolean;
  /** Capability -> status, for rows whose status is in the vocabulary. */
  status: Map<string, CapabilityStatus>;
  issues: Issue[];
}

/** `| `cap` | `status` | detail |`, which is the only row shape §3 writes. */
const ROW = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm;

/**
 * §3's body: from its own heading to the next `## `, and no further.
 *
 * Scoped rather than swept over the whole file because §4 carries a table with
 * the same three-column shape -- Restriction, Enforced?, How the package treats
 * it -- and codex §3's differences table is a third. A parser reading every
 * table in the file would take rows out of those as capability statements, and
 * the answer for any capability named twice would be whichever row came last.
 */
function sectionThree(contract: string): string | null {
  return numberedSection(contract, 3);
}

/**
 * A contract's `## <n>.` section: from its own heading to the next `## `.
 *
 * Exported because the adapter contracts state what they supply in their own
 * §1 and are read the same way, for the same reason -- each of them carries
 * other tables in the same shape outside that section.
 */
export function numberedSection(contract: string, n: number): string | null {
  const start = contract.search(new RegExp(`^##\\s+${n}\\.\\s`, "m"));
  if (start === -1) return null;
  const rest = contract.slice(start);
  const end = rest.slice(1).search(/^##\s/m);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/**
 * Read §3's capability table out of the host contract.
 *
 * §3 states that "`ak validate` parses it out of this file rather than reading
 * a generated copy". Until this function existed that sentence described an
 * instrument nobody had built: nothing in `src/` opened the file, and the
 * package's one comparison of a skill against a host ran between
 * `skill.yaml`'s `unsupported` prose and `hosts.ts`'s `RESTRICTIONS`, which are
 * two vocabularies and neither of them this one.
 */
export function loadCapabilityTable(root: string): CapabilityTable {
  const issues: Issue[] = [];
  const status = new Map<string, CapabilityStatus>();
  const blank = (why: string): CapabilityTable => {
    issues.push(
      unavailable(
        "packaging.capability-table-unavailable",
        CAPABILITY_TABLE_FILE,
        MODE_CEILING_CHECK,
        `${why} Every skill's packaging.hosts[] mode is in the plan and the table those modes are measured against is not, so no ceiling was computed for any of them. This is not an empty table: an empty one answers 'nothing is withheld' for every capability and would certify every autonomous declaration in the tree. Restore ${CAPABILITY_TABLE_FILE}'s '## 3.' section with its '| \`capability\` | \`status\` | detail |' rows.`,
      ),
    );
    return { available: false, status, issues };
  };

  const contract = readTextIfPresent(join(root, CAPABILITY_TABLE_FILE));
  if (contract === null) return blank(`${CAPABILITY_TABLE_FILE} is not in the source tree.`);

  const section = sectionThree(contract);
  if (section === null) return blank(`${CAPABILITY_TABLE_FILE} has no '## 3.' section.`);

  let rows = 0;
  for (const match of section.matchAll(ROW)) {
    const capability = match[1] ?? "";
    const declared = match[2] ?? "";
    rows += 1;
    if (!isStatus(declared)) {
      issues.push(
        error(
          "packaging.unknown-capability-status",
          CAPABILITY_TABLE_FILE,
          `§3's row for '${capability}' states the status '${declared}', which is not one of ${CAPABILITY_STATUSES.join(", ")}. §3 calls the Status column a controlled vocabulary and puts nuance in Detail, because a compound status is a value no consumer can act on. '${capability}' now has no status on any host, so every skill requiring it is capped as if the table never mentioned it.`,
        ),
      );
      continue;
    }
    // First row wins, so a capability stated twice is decided by the one a
    // reader reaches first rather than by the end of the loop.
    if (!status.has(capability)) status.set(capability, declared);
  }

  if (rows === 0) return blank(`${CAPABILITY_TABLE_FILE}'s '## 3.' section holds no capability rows.`);
  return { available: true, status, issues };
}

/**
 * What the installed adapters add to what the host provides.
 *
 * `adapters/claude-code/CONTRACT.md` §3 states what **the host alone**
 * guarantees, and says that a "See `adapters/<x>/CONTRACT.md`" pointer is not a
 * claim of availability. So an adapter's supply is a second input rather than an
 * edit to the first: §3 keeps saying `not-provided`, and this says which adapter
 * would supply the capability and whether the install attached it.
 *
 * `suppliers` lists only capabilities an adapter's own contract states it
 * supplies *and fails closed on* when nothing is configured behind it. That is
 * what makes lifting the ceiling honest rather than the weakening §4 forbids:
 * an autonomous run whose knowledgebase is missing gets a refusal from
 * `kb-write`, not a write that silently did not happen (ruling
 * `fail-closed-adapter-lifts-ceiling`).
 */
export interface Supply {
  /** The adapter ids the install configuration attached. */
  attached: ReadonlySet<string>;
  /** Capability -> the adapters whose contract supplies it and fails closed, in catalog order. */
  suppliers: ReadonlyMap<string, readonly string[]>;
  /**
   * Capability -> adapter -> the capability that adapter's refusal is borrowed
   * from, for the rows whose adapter has no backend configured in this install.
   *
   * An adapter listed here lifts the capability only where the one it borrows
   * is itself available -- provided by the host, or supplied by an attached
   * adapter whose own borrowing holds. Otherwise the refusal the row promises
   * belongs to an adapter this install left out, and lifting on it would let
   * the install route around its own decision to cap that capability (ruling
   * `tracker-of-record-falls-back-to-kb`). Absent: nothing is borrowed.
   */
  fallbacks?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** No adapter attached and none supplying anything: the host alone, which is §3 read by itself. */
export const HOST_ALONE: Supply = { attached: new Set(), suppliers: new Map() };

/**
 * The most autonomy a skill may be packaged with, given what it requires.
 *
 * `adapters/claude-code/CONTRACT.md` §4: "A host that cannot enforce a
 * restriction an autonomous run requires **exposes the affected skill in
 * guided/manual mode and rejects autonomous mode.** It never runs the skill
 * with the restriction silently absent." `guided` is the ceiling and not
 * `manual` because §4 offers both and this is the most the rule permits; a
 * skill may still declare less.
 */
export interface Ceiling {
  /** `null` only when the table was unavailable: no ceiling, not a permissive one. */
  mode: SkillMode | null;
  /** Required capabilities the table gives a blocking status and no adapter supplies, in the order declared. */
  blocking: string[];
  /**
   * Required capabilities with no row in the table at all.
   *
   * Capped like a blocking one rather than waved through. A capability absent
   * from §3 has no stated status on any host, and reading absence as
   * `satisfied` certifies a skill against a table that never mentioned what it
   * needs -- which is the shape codex §3 records having had for three
   * capabilities its prose restatement silently omitted.
   */
  unknown: string[];
  /**
   * Required capabilities the host withholds, that an adapter would supply,
   * and that no attached adapter does -- each with the adapters that would.
   *
   * Kept apart from `blocking` because the fix is in a different file. A
   * blocking capability means the skill's row or its `requires[]` is wrong; a
   * detached one means this install chose not to attach an adapter, which is
   * `ak.install.yaml`'s decision to make and not a defect in the tree.
   */
  detached: Array<{
    capability: string;
    adapters: string[];
    /**
     * Set when a supplier is attached and still lifts nothing, because what its
     * no-backend path borrows is unavailable here: the capability borrowed and
     * the adapters that would supply it. Two fixes rather than one -- configure
     * the backend, or attach one of these.
     */
    fallsBackOn?: { capability: string; adapters: string[] };
  }>;
}

export function ceilingFor(requires: readonly string[], table: CapabilityTable, supply: Supply = HOST_ALONE): Ceiling {
  if (!table.available) return { mode: null, blocking: [], unknown: [], detached: [] };

  const blocking: string[] = [];
  const unknown: string[] = [];
  const detached: Ceiling["detached"] = [];
  for (const capability of requires) {
    const declared = table.status.get(capability);
    if (declared === undefined) {
      // Never lifted by an adapter. A capability §3 does not mention has no
      // host status for an adapter to add to, and an adapter row naming it is
      // as likely to share the typo as to correct it.
      unknown.push(capability);
      continue;
    }
    if (!BLOCKING.has(declared)) continue;
    const suppliers = supply.suppliers.get(capability) ?? [];
    const attached = suppliers.filter((adapter) => supply.attached.has(adapter));
    if (attached.some((adapter) => borrowingHolds(capability, adapter, table, supply, new Set([capability])))) continue;
    if (suppliers.length === 0) {
      blocking.push(capability);
      continue;
    }
    const borrowed = attached
      .map((adapter) => supply.fallbacks?.get(capability)?.get(adapter))
      .find((c) => c !== undefined);
    const row: Ceiling["detached"][number] = { capability, adapters: [...suppliers] };
    if (borrowed !== undefined) {
      row.fallsBackOn = { capability: borrowed, adapters: [...(supply.suppliers.get(borrowed) ?? [])] };
    }
    detached.push(row);
  }

  const capped = blocking.length > 0 || unknown.length > 0 || detached.length > 0;
  return { mode: capped ? "guided" : "autonomous", blocking, unknown, detached };
}

/**
 * Whether an attached adapter's supply of `capability` stands, given what its
 * no-backend path borrows.
 *
 * A borrowed capability the host provides holds; one the host withholds holds
 * only through an attached adapter whose own borrowing holds. `seen` stops a
 * cycle, which lifts nothing: two adapters each borrowing the other's refusal
 * have no refusal between them.
 */
function borrowingHolds(
  capability: string,
  adapter: string,
  table: CapabilityTable,
  supply: Supply,
  seen: ReadonlySet<string>,
): boolean {
  const borrowed = supply.fallbacks?.get(capability)?.get(adapter);
  if (borrowed === undefined) return true;
  if (seen.has(borrowed)) return false;
  const status = table.status.get(borrowed);
  if (status === undefined) return false;
  if (!BLOCKING.has(status)) return true;
  const next = new Set([...seen, borrowed]);
  return (supply.suppliers.get(borrowed) ?? []).some(
    (a) => supply.attached.has(a) && borrowingHolds(borrowed, a, table, supply, next),
  );
}

/**
 * What each session was shown at its start, read back from the
 * `hook.session-start` spans so an episode row can carry it beside the
 * session's outcome.
 *
 * The hook cannot write to the episode: it runs when the session opens, and
 * the episode exists only once the session has ended. So the hook's span
 * carries the session's key (`sessionKey`), and the episode builder asks this
 * lookup with the id the session's own record holds. A host may start one
 * session more than once (a resume, a compaction, a re-armed carrier), so the
 * answer is every id any of those starts showed, in the order first shown.
 *
 * Spans hold ids and counts only, so nothing here can carry a lesson's text.
 */
import Ajv from "ajv";
import type { LearnConfig } from "../core/config.ts";
import { sessionKey, spanRows } from "../core/trace.ts";
import type { ShownLookup } from "./episodes.ts";

/** A session-start span that names its session, with the two attributes read here. */
interface KeyedStart {
  name: "hook.session-start";
  attrs: { session: string; shown?: string[] };
}

const isKeyedStart = new Ajv({ strict: false }).compile<KeyedStart>({
  type: "object",
  required: ["name", "attrs"],
  properties: {
    name: { const: "hook.session-start" },
    attrs: {
      type: "object",
      required: ["session"],
      properties: { session: { type: "string" }, shown: { type: "array", items: { type: "string" } } },
    },
  },
});

function shownBySession(config: LearnConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of spanRows(config)) {
    if (!isKeyedStart(row)) continue;
    const { session, shown = [] } = row.attrs;
    out.set(session, [...new Set([...(out.get(session) ?? []), ...shown])]);
  }
  return out;
}

/**
 * The lookup for one run. The span files are read on the first question and
 * not before: most ticks write no episode and so never ask.
 */
export function shownLookup(config: LearnConfig): ShownLookup {
  let bySession: Map<string, string[]> | null = null;
  return (hostSessionId) => {
    const key = sessionKey(config, hostSessionId);
    if (key === null) return undefined;
    bySession ??= shownBySession(config);
    return bySession.get(key);
  };
}

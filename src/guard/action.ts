/**
 * The normalized tool call the guard evaluator judges.
 *
 * A host decoder turns its payload into one of these and nothing else reaches
 * the evaluator, so both hosts are judged by the same rules
 * (docs/decisions/0009-constitution-support.md, Decision 2). A shell call is
 * its exec vector: a command string the host hands a shell becomes
 * `["bash", "-c", text]`, and the evaluator parses the string as it parses any
 * inline shell. A patch carries every path it adds, updates, deletes or moves
 * to; a decoder that cannot list them sends no paths, which the evaluator
 * denies as unjudgeable.
 */
export type GuardAction =
  | { kind: "shell"; argv: ReadonlyArray<string> }
  | { kind: "read"; paths: ReadonlyArray<string> }
  | { kind: "write"; paths: ReadonlyArray<string> }
  | { kind: "patch"; paths: ReadonlyArray<string> };

/** What the evaluator knows about where the call runs, all supplied by the caller. */
export interface GuardContext {
  /** Absolute path of the workspace root the policy's globs are relative to. */
  root: string;
  /** Absolute working directory of the call; the root when absent. */
  cwd?: string;
  /** Absolute home directory, for `~` and `$HOME`. Absent, a path under either is located nowhere. */
  home?: string;
  /** The ticket's write scope (schemas/ticket.schema.json `allowed_changes.files`), which lifts `tests` protection. */
  scope?: { files: ReadonlyArray<string> };
}

/** A command string as a shell action. */
export function shellAction(command: string): GuardAction {
  return { kind: "shell", argv: ["bash", "-c", command] };
}

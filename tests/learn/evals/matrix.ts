/**
 * The eval matrix: which subjects run and which reviewers grade them. The bound file is
 * `.work/eval-matrix.yaml`, gitignored, because it is the one place a model binding is written;
 * `eval-matrix.example.yaml` beside this file shows the shape with role labels only. Validated
 * against `eval-matrix.schema.json`. Not a test file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { PACKAGE_ROOT } from "../../../src/learn/core/roles.ts";
import type { HostKind } from "./subjects/types.ts";

export const MATRIX_FILE = join(PACKAGE_ROOT, ".work", "eval-matrix.yaml");
export const MATRIX_SCHEMA = join(import.meta.dir, "eval-matrix.schema.json");
/**
 * A2 valid Claude-host sessions used at most 15 tool events before replying (197 sessions; p95 9).
 * Twenty leaves five events of headroom without turning the cap into an accidental six-turn gate.
 */
export const DEFAULT_MAX_TURNS = 20;

/** A subject under test. With no `model` the host runs its own default binding. */
export interface Subject {
  id: string;
  host: HostKind;
  /** The runner's binding, opaque here. Always a key, so a subject reads as `{ model?: string }` or `{ model: string | undefined }`. */
  model: string | undefined;
  /** Per-subject override. `null` removes the evaluator's default; absent preserves it. */
  maxTurns?: number | null;
}

/** A reviewer seat: always bound, so its independence from each subject can be checked. */
export interface Seat extends Subject {
  model: string;
}

export interface PanelRules {
  "independent-of": "subject";
  "min-reviewers": number;
  size?: number;
}

export interface TokenCaps {
  session: number;
  run: number;
}

export interface Matrix {
  subjects: Subject[];
  reviewers: Seat[];
  panels: PanelRules;
  tokenCaps?: TokenCaps;
  /** Repository-relative path under research/ or provenance/. */
  priceTable?: string;
}

type MatrixSubject = Omit<Subject, "maxTurns"> & { "max-turns"?: number | null };
type MatrixFile = Omit<Matrix, "subjects" | "tokenCaps" | "priceTable"> & {
  subjects: MatrixSubject[];
  "token-caps"?: TokenCaps;
  "price-table"?: string;
};

let validator: ReturnType<InstanceType<typeof Ajv2020>["compile"]> | undefined;

/** The cap this evaluator can enforce for `subject`; undefined means no cap. */
export function effectiveMaxTurns(subject: Subject, evaluatorDefault = DEFAULT_MAX_TURNS): number | undefined {
  if (subject.host === "codex" || subject.maxTurns === null) return undefined;
  return subject.maxTurns ?? evaluatorDefault;
}

/** Receipt fragment for the effective cap; JSON null means the host runs uncapped. */
export function turnCapReceipt(subject: Subject, evaluatorDefault = DEFAULT_MAX_TURNS): { max_turns: number | null } {
  return { max_turns: effectiveMaxTurns(subject, evaluatorDefault) ?? null };
}

/** Receipt fragment for the matrix's token ceilings; JSON null means no ceiling. */
export function tokenCapReceipt(caps: TokenCaps | undefined) {
  return { max_session_tokens: caps?.session ?? null, max_run_tokens: caps?.run ?? null };
}

/** Parse and validate matrix YAML. Throws with every problem found, never a partial matrix. */
export function parseMatrix(text: string, source = "eval matrix"): Matrix {
  validator ??= new Ajv2020({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync(MATRIX_SCHEMA, "utf8")) as object,
  );
  const value: unknown = parseYaml(text, { uniqueKeys: true });
  const problems: string[] = [];
  if (!validator(value)) {
    for (const e of validator.errors ?? [])
      problems.push(`${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"}`);
  } else {
    const seen = new Set<string>();
    const matrix = value as MatrixFile;
    for (const seat of [...matrix.subjects, ...matrix.reviewers]) {
      if (seen.has(seat.id)) problems.push(`seat id '${seat.id}' appears twice`);
      seen.add(seat.id);
    }
    for (const subject of matrix.subjects) {
      if (subject.host === "codex" && typeof subject["max-turns"] === "number") {
        problems.push(`subject '${subject.id}' uses host 'codex', which cannot enforce max-turns`);
      }
    }
    if (matrix["price-table"]?.split("/").includes(".."))
      problems.push("price-table must not traverse outside research/ or provenance/");
  }
  if (problems.length > 0) throw new Error(`${source}: ${problems.join("; ")}`);
  const matrix = value as MatrixFile;
  const { subjects, "token-caps": tokenCaps, "price-table": priceTable, ...rest } = matrix;
  const parsed: Matrix = {
    ...rest,
    subjects: subjects.map(({ "max-turns": maxTurns, ...subject }) => ({
      ...subject,
      model: subject.model,
      maxTurns,
    })),
  };
  if (tokenCaps !== undefined) parsed.tokenCaps = tokenCaps;
  if (priceTable !== undefined) parsed.priceTable = priceTable;
  return parsed;
}

/**
 * The matrix used when no bound file exists: one claude subject on the host's default binding, and
 * no reviewers, so every panel built from it is unavailable. Copy eval-matrix.example.yaml to
 * `.work/eval-matrix.yaml` and bind it to run more.
 */
export const DEFAULT_MATRIX: Matrix = {
  subjects: [{ id: "subject-default", host: "claude", model: undefined }],
  reviewers: [],
  panels: { "independent-of": "subject", "min-reviewers": 2 },
};

/** The bound matrix at `file`, or a copy of `DEFAULT_MATRIX` when the file is absent. */
export function loadMatrix(file = MATRIX_FILE): Matrix {
  if (!existsSync(file)) return structuredClone(DEFAULT_MATRIX);
  return parseMatrix(readFileSync(file, "utf8"), file);
}

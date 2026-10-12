/**
 * The checks preflight runs, one function per check, each returning a named
 * pass or fail with the reason. bind and install run the subset they depend on.
 */
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { loadCapabilityTable } from "../packaging/capability-table.ts";
import type { Evidence, Host, Upstream } from "./constants.ts";
import { LIFECYCLE_SKILLS, TRANSPORT_REFERENCE } from "./constants.ts";
import { git } from "./proc.ts";

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

const pass = (id: string, detail: string): Check => ({ id, ok: true, detail });
const fail = (id: string, detail: string): Check => ({ id, ok: false, detail });

/** The home contains the upstream commit the patch was made against. */
export function checkUpstreamCommit(fmHome: string, upstream: Upstream): Check {
  const id = "upstream-commit";
  if (!existsSync(join(fmHome, ".git"))) return fail(id, `${fmHome} is not a Firstmate git checkout`);
  const known = git(fmHome, ["cat-file", "-e", `${upstream.commit}^{commit}`]);
  if (known.code !== 0) return fail(id, `${fmHome} does not contain upstream commit ${upstream.commit}`);
  const ancestor = git(fmHome, ["merge-base", "--is-ancestor", upstream.commit, "HEAD"]);
  if (ancestor.code !== 0)
    return fail(id, `HEAD of ${fmHome} does not descend from upstream commit ${upstream.commit}`);
  return pass(id, `HEAD descends from ${upstream.commit}`);
}

/**
 * Every patch in the stack is applied, which reverse `git apply --check` proves: a
 * reverse applies cleanly only to a tree the forward patch is in. Later patches
 * rewrite lines earlier ones added, so the stack is peeled from the top in a
 * temporary index holding the home's working tree: check the top patch, reverse
 * it there, check the next. The home's own index and files are never changed.
 * Nothing here applies a patch.
 */
export function checkPatchApplied(fmHome: string, upstream: Upstream): Check {
  const id = "patch-applied";
  const ids = upstream.stack.map((p) => p.id);
  const missingFile = upstream.stack.find((p) => !existsSync(p.file));
  if (missingFile !== undefined) return fail(id, `patch file ${missingFile.file} is missing from agent-kit`);

  const scratch = mkdtempSync(join(tmpdir(), "ak-fm-index-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    for (const args of [
      ["read-tree", "HEAD"],
      ["add", "-A"],
    ]) {
      const r = git(fmHome, args, env);
      if (r.code !== 0) return fail(id, `cannot read ${fmHome}'s working tree: ${r.stderr.trim()}`);
    }
    for (let i = upstream.stack.length - 1; i >= 0; i--) {
      const patch = upstream.stack[i]!;
      if (git(fmHome, ["apply", "--cached", "--reverse", "--check", patch.file], env).code !== 0) {
        return fail(
          id,
          `${patch.id} is not applied to ${fmHome}. A home needs ${ids.join(" then ")}, applied in that order. Without 0001 an unmodified Firstmate forbids the worker's delegation and gives no-mistakes sole ownership of review; without 0002 nothing audits a worker's done (adapters/firstmate/CONTRACT.md §3). A maintainer applies the patches; no ak command does`,
        );
      }
      if (i > 0 && git(fmHome, ["apply", "--cached", "--reverse", patch.file], env).code !== 0) {
        return fail(id, `${patch.id} checked as applied but could not be peeled to check ${upstream.stack[i - 1]!.id}`);
      }
    }
    return pass(id, `${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} applied`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The project's trusted no-mistakes config parks a failing gate instead of
 * committing a fix. no-mistakes reads the config only from the default branch,
 * so that copy is the one judged: origin/HEAD, else main, else master. The
 * repository's value overrides the global default, and the global default
 * commits, so the repository must say 0 for each.
 */
export function checkNoMistakesConfig(project: string): Check {
  const id = "no-mistakes-auto-fix";
  if (!existsSync(project) || !statSync(project).isDirectory()) return fail(id, `${project} is not a directory`);
  const ref = ["origin/HEAD", "main", "master"].find(
    (r) => git(project, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]).code === 0,
  );
  if (ref === undefined)
    return fail(
      id,
      `${project} has no resolvable default branch (origin/HEAD, main or master), so the trusted .no-mistakes.yaml cannot be read`,
    );
  const file = `${ref}:.no-mistakes.yaml`;
  const shown = git(project, ["show", file]);
  if (shown.code !== 0)
    return fail(
      id,
      `${file} is missing in ${project}; the default branch must declare auto_fix.test, auto_fix.lint and auto_fix.ci as 0`,
    );
  let doc: unknown;
  try {
    doc = parseYaml(shown.text);
  } catch (e) {
    return fail(id, `${file} does not parse: ${(e as Error).message}`);
  }
  const autoFix = (doc as { auto_fix?: Record<string, unknown> } | null)?.auto_fix ?? {};
  const loose = ["test", "lint", "ci"].filter((step) => autoFix[step] !== 0);
  if (loose.length > 0) {
    return fail(
      id,
      `${file} must set auto_fix.${loose.join(", auto_fix.")} to 0, so a failing gate parks rather than committing a fix the lifecycle did not review (skills/super-ship/references/transport-no-mistakes.md)`,
    );
  }
  return pass(id, `${file} sets auto_fix.test, auto_fix.lint and auto_fix.ci to 0`);
}

/**
 * Where evidence goes. The knowledgebase fails closed: this adapter publishes
 * to none and does not supply kb-write (CONTRACT.md §1). A mock store must be a
 * writable directory.
 */
export function checkEvidence(evidence: Evidence | undefined): Check {
  const id = "evidence";
  if (evidence === undefined || evidence.store === "kb") {
    return fail(
      id,
      "the knowledgebase evidence store fails closed: this adapter does not publish to a knowledgebase (adapters/firstmate/CONTRACT.md §1). A demonstration may name a labeled mock store, which forces dry-run",
    );
  }
  try {
    mkdirSync(evidence.location, { recursive: true });
    if (!statSync(evidence.location).isDirectory()) return fail(id, `${evidence.location} is not a directory`);
    accessSync(evidence.location, constants.W_OK);
  } catch (e) {
    return fail(id, `mock evidence store ${evidence.location} is not writable: ${(e as Error).message}`);
  }
  return pass(id, `labeled mock store at ${evidence.location}; delivery is forced to dry-run`);
}

/** The built bundle carries the lifecycle and the transport reference. */
export function checkBundle(bundleDir: string): Check {
  const id = "skill-bundle";
  const needed = [...LIFECYCLE_SKILLS.map((s) => `skills/${s}/SKILL.md`), TRANSPORT_REFERENCE];
  const missing = needed.filter((rel) => !existsSync(join(bundleDir, rel)));
  if (missing.length > 0) return fail(id, `${bundleDir} is missing ${missing.join(", ")}; run ak build`);
  return pass(id, `${bundleDir} carries the lifecycle and the no-mistakes transport`);
}

/**
 * The host supplies isolated review contexts at least partially. Partial is
 * reported as partial: it is a pass with a named limit, never a silent one.
 * Independent context is reported but not required: no host attests it, so a
 * host-only verifier receipt is host-unattested and attested independence comes
 * from the runner (adapters/claude-code/CONTRACT.md, adapters/runner-contract/CONTRACT.md).
 */
export function checkHost(akRoot: string, host: Host): Check {
  const id = "host-capabilities";
  const table = loadCapabilityTable(akRoot);
  if (!table.available)
    return fail(id, "the host capability table is unavailable, so no host capability could be checked");
  const wanted = ["isolated-review-context", "independent-context"];
  const states = wanted.map((cap) => [cap, table.status.get(cap)] as const);
  const missing = states.filter(
    ([cap, s]) => cap === "isolated-review-context" && (s === undefined || s === "not-provided"),
  );
  const summary = states.map(([cap, s]) => `${cap}=${s ?? "unstated"}`).join(", ");
  if (missing.length > 0) return fail(id, `${host}: ${summary}`);
  return pass(id, `${host}: ${summary}`);
}

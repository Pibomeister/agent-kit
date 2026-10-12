/**
 * `ak firstmate` — preflight, bind, install, remove and status.
 *
 * Label: mock/contract. Every case runs against a temp Firstmate home built by
 * ./fixture.ts, never the live one, and against a synthetic upstream commit and
 * patch stack standing in for a5d78f8, 0001-agent-kit-mode and 0002-agent-kit-audit.
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { bind } from "../../src/firstmate/bind.ts";
import { checkPatchApplied } from "../../src/firstmate/checks.ts";
import { runFirstmate } from "../../src/firstmate/cli.ts";
import { install, remove } from "../../src/firstmate/install.ts";
import { pinBundle, treeHash } from "../../src/firstmate/pin.ts";
import { preflight } from "../../src/firstmate/preflight.ts";
import { statusLine, type StatusArgs } from "../../src/firstmate/status.ts";
import { validateBinding } from "../../src/firstmate/schema.ts";
import { FIXED_NOW, gitIn, makeBundle, makeDir, makeHome, makeProject, REPO } from "./fixture.ts";

function env(over: Partial<Parameters<typeof bind>[1]> = {}) {
  const { home, upstream } = makeHome({ patched: true });
  return {
    home,
    project: makeProject(),
    opts: {
      akRoot: REPO,
      bundleDir: makeBundle(),
      pinsDir: makeDir(),
      ledgerDir: makeDir(),
      upstream,
      now: FIXED_NOW,
      ...over,
    },
  };
}

function failed(checks: { id: string; ok: boolean }[]): string[] {
  return checks
    .values()
    .filter((c) => !c.ok)
    .map((c) => c.id)
    .toArray();
}

describe("preflight", () => {
  test("passes on a patched home, a trusted no-mistakes config and a mock evidence store", () => {
    const { home, project, opts } = env();
    const result = preflight(
      { fmHome: home, project, host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      opts,
    );
    expect(failed(result.checks)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("an unmodified upstream home is refused: the patch is not applied", () => {
    const { home, upstream } = makeHome({ patched: false });
    const result = preflight(
      { fmHome: home, project: makeProject(), host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      { akRoot: REPO, bundleDir: makeBundle(), pinsDir: makeDir(), ledgerDir: makeDir(), upstream, now: FIXED_NOW },
    );
    expect(failed(result.checks)).toEqual(["patch-applied"]);
    expect(result.ok).toBe(false);
  });

  test("a home with 0001 but not 0002 is refused, naming 0002", () => {
    const { home, upstream } = makeHome({ patched: "0001" });
    const result = preflight(
      { fmHome: home, project: makeProject(), host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      { akRoot: REPO, bundleDir: makeBundle(), pinsDir: makeDir(), ledgerDir: makeDir(), upstream, now: FIXED_NOW },
    );
    expect(failed(result.checks)).toEqual(["patch-applied"]);
    expect(result.checks.find((c) => c.id === "patch-applied")!.detail).toContain(
      "0002-agent-kit-audit is not applied",
    );
  });

  test("the stack is checked in a scratch index: a committed stack passes and the home's index is untouched", () => {
    const { home, upstream } = makeHome({ patched: true });
    const staged = gitIn(home, "diff", "--cached", "--name-only");
    const check = checkPatchApplied(home, upstream);
    expect(check).toEqual({
      id: "patch-applied",
      ok: true,
      detail: "0001-agent-kit-mode, 0002-agent-kit-audit are applied",
    });
    expect(gitIn(home, "diff", "--cached", "--name-only")).toBe(staged);
    expect(gitIn(home, "status", "--porcelain")).toBe("M bin/fm-dod-lib.sh");
    gitIn(home, "commit", "-qam", "apply 0001 and 0002");
    expect(checkPatchApplied(home, upstream).ok).toBe(true);
  });

  test("a home that does not contain the upstream commit is refused", () => {
    const { home, project, opts } = env();
    const result = preflight(
      { fmHome: home, project, host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      { ...opts, upstream: { ...opts.upstream, commit: "0000000" } },
    );
    expect(failed(result.checks)).toContain("upstream-commit");
  });

  test("the knowledgebase evidence store fails closed: this adapter publishes to none", () => {
    const { home, project, opts } = env();
    const result = preflight(
      { fmHome: home, project, host: "claude-code", evidence: { store: "kb", location: "kb://x" } },
      opts,
    );
    expect(failed(result.checks)).toEqual(["evidence"]);
    expect(result.checks.find((c) => c.id === "evidence")?.detail).toContain("fails closed");
  });

  test("a no-mistakes config that lets a gate commit a fix is refused, and so is a missing one", () => {
    const { home, opts } = env();
    const loose = makeProject("commands:\n  test: bun test\nauto_fix:\n  test: 0\n  lint: 3\n  ci: 0\n");
    const r1 = preflight(
      { fmHome: home, project: loose, host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      opts,
    );
    expect(failed(r1.checks)).toEqual(["no-mistakes-auto-fix"]);
    expect(r1.checks.find((c) => c.id === "no-mistakes-auto-fix")?.detail).toContain("lint");

    const none = makeProject("commands:\n  test: bun test\n");
    const r2 = preflight(
      { fmHome: home, project: none, host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      opts,
    );
    expect(failed(r2.checks)).toEqual(["no-mistakes-auto-fix"]);
  });

  test("a project path that does not exist is a named failure in preflight and bind, not a crash", () => {
    const { home, opts } = env();
    const project = join(makeDir(), "missing");
    const evidence = { store: "mock" as const, location: makeDir() };
    const p = preflight({ fmHome: home, project, host: "claude-code", evidence }, opts);
    expect(p.ok).toBe(false);
    expect(failed(p.checks)).toEqual(["no-mistakes-auto-fix"]);
    const b = bind(
      {
        fmHome: home,
        taskId: "T-9",
        project,
        mode: "agent-kit",
        host: "claude-code",
        evidence,
        bindingOut: join(home, "data/T-9/binding.json"),
      },
      opts,
    );
    expect(b.ok).toBe(false);
    expect(failed(b.checks)).toEqual(["no-mistakes-auto-fix"]);
  });

  test("the no-mistakes config is read from the default branch, not the working tree", () => {
    const { home, opts } = env();
    const good = "commands:\n  test: bun test\nauto_fix:\n  test: 0\n  lint: 0\n  ci: 0\n";
    const check = (project: string) =>
      preflight({ fmHome: home, project, host: "claude-code", evidence: { store: "mock", location: makeDir() } }, opts)
        .checks;

    const worktreeOnly = makeProject("commands:\n  test: bun test\n");
    writeFileSync(join(worktreeOnly, ".no-mistakes.yaml"), good);
    expect(failed(check(worktreeOnly))).toEqual(["no-mistakes-auto-fix"]);

    const committed = makeProject();
    writeFileSync(join(committed, ".no-mistakes.yaml"), "auto_fix:\n  test: 3\n");
    expect(failed(check(committed))).toEqual([]);

    const noDefault = makeProject();
    gitIn(noDefault, "branch", "-m", "trunk");
    const c = check(noDefault).find((x) => x.id === "no-mistakes-auto-fix");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("default branch");
  });

  test("a bundle missing a lifecycle skill or the transport reference is refused", () => {
    const { home, project, opts } = env();
    const r = preflight(
      { fmHome: home, project, host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      { ...opts, bundleDir: makeDir() },
    );
    expect(failed(r.checks)).toEqual(["skill-bundle"]);
  });

  test("host capabilities are read from the host contract and a partial status is reported, not hidden", () => {
    const { home, project, opts } = env();
    const r = preflight(
      { fmHome: home, project, host: "claude-code", evidence: { store: "mock", location: makeDir() } },
      opts,
    );
    const host = r.checks.find((c) => c.id === "host-capabilities");
    expect(host?.ok).toBe(true);
    expect(host?.detail).toContain("isolated-review-context=partial");
    expect(host?.detail).toContain("independent-context=not-provided");
  });
});

describe("bind", () => {
  test("writes a binding that validates, pins the bundle by content hash and renders the worker section", () => {
    const { home, project, opts } = env();
    const out = join(home, "data/T-1/agent-kit-binding.json");
    const r = bind(
      {
        fmHome: home,
        taskId: "T-1",
        project,
        mode: "agent-kit",
        bindingOut: out,
        host: "claude-code",
        evidence: { store: "mock", location: makeDir() },
      },
      opts,
    );
    expect(r.ok).toBe(true);
    const binding = JSON.parse(readFileSync(out, "utf8"));
    expect(validateBinding(REPO, binding)).toEqual([]);
    expect(binding.delivery).toEqual({
      action: "dry-run",
      transport: "no-mistakes",
      skip: ["review", "document", "rebase"],
      merge: false,
    });
    expect(binding.child_budget.max_depth).toBe(1);
    expect(binding.child_budget.charged_to).toBe(binding.run_id);
    expect(binding.work_source).toEqual({ kind: "firstmate-brief", ref: join(home, "data/T-1/brief.md") });
    expect(binding.skill_bundle.path.startsWith(opts.pinsDir)).toBe(true);
    expect(existsSync(join(binding.skill_bundle.path, "skills/super-ship/SKILL.md"))).toBe(true);
    expect(binding.source_snapshot.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(binding.source_snapshot.diff_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(r.markdown.startsWith("# agent-kit binding")).toBe(true);
    expect(r.markdown).toContain(binding.run_id);
    expect(r.markdown).toContain("labeled mock");
    expect(r.markdown).not.toMatch(/^Delivery contract: mode=/m);
    expect(r.markdown).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  test("the same task and inputs yield the same run id; a moved snapshot yields a different one", () => {
    const { home, project, opts } = env();
    const args = {
      fmHome: home,
      taskId: "T-2",
      project,
      mode: "agent-kit",
      host: "claude-code" as const,
      evidence: { store: "mock" as const, location: makeDir() },
    };
    const a = bind({ ...args, bindingOut: join(home, "data/T-2/a.json") }, opts);
    const b = bind({ ...args, bindingOut: join(home, "data/T-2/b.json") }, opts);
    expect(a.binding?.run_id).toBe(b.binding?.run_id);

    writeFileSync(join(project, "src/a.ts"), "export const a = 2;\n");
    const c = bind({ ...args, bindingOut: join(home, "data/T-2/c.json") }, opts);
    expect(c.binding?.source_snapshot.revision).toBe(a.binding?.source_snapshot.revision);
    expect(c.binding?.source_snapshot.diff_hash).not.toBe(a.binding?.source_snapshot.diff_hash);
    expect(c.binding?.run_id).not.toBe(a.binding?.run_id);
  });

  test("a bind that loses the race to create a new pin reuses the winner's pin and leaves no staging directory", () => {
    const bundleDir = makeBundle();
    const pinsDir = makeDir();
    let lost = false;
    const spy = spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      lost = true;
      fs.cpSync(bundleDir, to as string, { recursive: true });
      spy.mockRestore();
      fs.renameSync(from, to);
    });
    try {
      const pin = pinBundle(bundleDir, pinsDir);
      expect(lost).toBe(true);
      expect(typeof pin).toBe("object");
      expect((pin as { hash: string }).hash).toBe(`sha256:${treeHash(bundleDir)}`);
      expect(fs.readdirSync(pinsDir)).toEqual([treeHash(bundleDir)]);
    } finally {
      spy.mockRestore();
    }
  });

  test("the pinned bundle does not change when the kit is rebuilt", () => {
    const { home, project, opts } = env();
    const args = {
      fmHome: home,
      taskId: "T-3",
      project,
      mode: "agent-kit",
      host: "claude-code" as const,
      evidence: { store: "mock" as const, location: makeDir() },
    };
    const first = bind({ ...args, bindingOut: join(home, "data/T-3/binding.json") }, opts);
    writeFileSync(join(opts.bundleDir, "skills/super-ship/SKILL.md"), "---\nname: super-ship\n---\nchanged\n");
    const pinned = readFileSync(join(first.binding!.skill_bundle.path, "skills/super-ship/SKILL.md"), "utf8");
    expect(pinned).not.toContain("changed");
    const second = bind({ ...args, bindingOut: join(home, "data/T-3/binding2.json") }, opts);
    expect(second.binding?.skill_bundle.hash).not.toBe(first.binding?.skill_bundle.hash);
  });

  test("refuses a bundle built without the lifecycle gate, and writes no binding", () => {
    const { home, project, opts } = env();
    fs.rmSync(join(opts.bundleDir, "bin"), { recursive: true });
    const bindingOut = join(home, "data/T-5/binding.json");
    const r = bind(
      {
        fmHome: home,
        taskId: "T-5",
        project,
        mode: "agent-kit",
        host: "claude-code",
        bindingOut,
        evidence: { store: "mock", location: makeDir() },
      },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("has no bin/ak-gate.mjs");
    expect(existsSync(bindingOut)).toBe(false);
  });

  test("refuses a mode other than agent-kit, a knowledgebase store, an unpatched home and a binding the worker could write", () => {
    const { home, project, opts } = env();
    const base = {
      fmHome: home,
      taskId: "T-4",
      project,
      host: "claude-code" as const,
      bindingOut: join(home, "data/T-4/binding.json"),
    };
    expect(bind({ ...base, mode: "no-mistakes", evidence: { store: "mock", location: makeDir() } }, opts).ok).toBe(
      false,
    );
    expect(bind({ ...base, mode: "agent-kit", evidence: { store: "kb", location: "kb://x" } }, opts).ok).toBe(false);
    expect(
      bind(
        {
          ...base,
          mode: "agent-kit",
          bindingOut: join(project, "binding.json"),
          evidence: { store: "mock", location: makeDir() },
        },
        opts,
      ).ok,
    ).toBe(false);
    const unpatched = makeHome({ patched: false });
    expect(
      bind(
        { ...base, fmHome: unpatched.home, mode: "agent-kit", evidence: { store: "mock", location: makeDir() } },
        { ...opts, upstream: unpatched.upstream },
      ).ok,
    ).toBe(false);
    expect(existsSync(base.bindingOut)).toBe(false);
  });

  test("reads the evidence store from the home's agent-kit.env when no flag names it", () => {
    const { home, project, opts } = env();
    const location = makeDir();
    expect(install({ fmHome: home, evidence: { store: "mock", location } }, opts).ok).toBe(true);
    const r = bind(
      {
        fmHome: home,
        taskId: "T-5",
        project,
        mode: "agent-kit",
        host: "claude-code",
        bindingOut: join(home, "data/T-5/binding.json"),
      },
      opts,
    );
    expect(r.ok).toBe(true);
    expect(r.binding?.evidence).toEqual({
      store: "mock",
      location,
      label: "mock evidence store: fixture demonstration, not a knowledgebase",
    });
  });

  test("with no evidence store configured anywhere, bind fails closed on the knowledgebase", () => {
    const { home, project, opts } = env();
    const r = bind(
      {
        fmHome: home,
        taskId: "T-6",
        project,
        mode: "agent-kit",
        host: "claude-code",
        bindingOut: join(home, "data/T-6/binding.json"),
      },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("fails closed");
  });
});

describe("binding schema", () => {
  function good(): Record<string, unknown> {
    const { home, project, opts } = env();
    const r = bind(
      {
        fmHome: home,
        taskId: "T-7",
        project,
        mode: "agent-kit",
        host: "claude-code",
        bindingOut: join(home, "data/T-7/b.json"),
        evidence: { store: "mock", location: makeDir() },
      },
      opts,
    );
    return JSON.parse(JSON.stringify(r.binding));
  }

  test("a mock evidence store cannot back a publish", () => {
    const b = good();
    (b.delivery as Record<string, unknown>).action = "publish";
    expect(validateBinding(REPO, b).length).toBeGreaterThan(0);
  });

  test("child depth is fixed at 1 and merge is never granted", () => {
    const b1 = good();
    (b1.child_budget as Record<string, unknown>).max_depth = 2;
    expect(validateBinding(REPO, b1).length).toBeGreaterThan(0);
    const b2 = good();
    (b2.delivery as Record<string, unknown>).merge = true;
    expect(validateBinding(REPO, b2).length).toBeGreaterThan(0);
  });

  test("the transport skips review, document and rebase and nothing else", () => {
    const b = good();
    (b.delivery as Record<string, unknown>).skip = ["review"];
    expect(validateBinding(REPO, b).length).toBeGreaterThan(0);
  });

  test("a ticket work source must carry a hash; a brief must carry its ref", () => {
    const b1 = good();
    b1.work_source = { kind: "ticket", ref: "T-7" };
    expect(validateBinding(REPO, b1).length).toBeGreaterThan(0);
    const b2 = good();
    b2.work_source = { kind: "firstmate-brief" };
    expect(validateBinding(REPO, b2).length).toBeGreaterThan(0);
  });
});

describe("install and remove", () => {
  test("writes exactly its files, is idempotent, and remove deletes exactly those", () => {
    const { home, opts } = env();
    const location = makeDir();
    const first = install({ fmHome: home, evidence: { store: "mock", location } }, opts);
    expect(first.ok).toBe(true);
    expect(first.written.map((p) => p.slice(home.length + 1)).sort()).toEqual([
      "config/agent-kit.env",
      "config/agent-kit/evidence.env",
      "config/agent-kit/worker-settings.json",
    ]);
    const envText = readFileSync(join(home, "config/agent-kit.env"), "utf8");
    // Patch 0001's parser (bin/fm-agent-kit-lib.sh) refuses any key but these three, each once.
    const keys = envText
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((l) => l.slice(0, l.indexOf("=")));
    expect(keys.sort()).toEqual(["AK_FIRSTMATE_BIN", "AK_FIRSTMATE_PATCH", "AK_FIRSTMATE_WORKER_SETTINGS"]);
    expect(readFileSync(join(home, "config/agent-kit/evidence.env"), "utf8")).toContain("AK_FIRSTMATE_EVIDENCE=mock\n");
    expect(envText).toContain("AK_FIRSTMATE_PATCH=0001-agent-kit-mode\n");
    expect(envText).toContain(`AK_FIRSTMATE_WORKER_SETTINGS=${join(home, "config/agent-kit/worker-settings.json")}\n`);
    expect(envText).toMatch(/^AK_FIRSTMATE_BIN=\/.+/m);
    const settings = JSON.parse(readFileSync(join(home, "config/agent-kit/worker-settings.json"), "utf8"));
    const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toContain("child-guard.sh");
    // Patch 0001 replaces the token with a bare absolute path, so the quotes around it are ours.
    expect(command).toContain("--binding '__AK_FIRSTMATE_BINDING__'");

    const second = install({ fmHome: home, evidence: { store: "mock", location } }, opts);
    expect(second.ok).toBe(true);
    expect(readFileSync(join(home, "config/agent-kit.env"), "utf8")).toBe(envText);

    const gone = remove({ fmHome: home }, opts);
    expect(gone.ok).toBe(true);
    expect(existsSync(join(home, "config/agent-kit.env"))).toBe(false);
    expect(existsSync(join(home, "config/agent-kit"))).toBe(false);

    // Without evidence, no evidence file is written, and a stale one from an earlier install goes.
    install({ fmHome: home, evidence: { store: "mock", location } }, opts);
    const plain = install({ fmHome: home }, opts);
    expect(plain.written.map((p) => p.slice(home.length + 1)).sort()).toEqual([
      "config/agent-kit.env",
      "config/agent-kit/worker-settings.json",
    ]);
    expect(existsSync(join(home, "config/agent-kit/evidence.env"))).toBe(false);
    remove({ fmHome: home }, opts);
    expect(existsSync(join(home, "config/.keep"))).toBe(true);
  });

  test("refuses an unpatched home, and refuses to overwrite a file it did not write", () => {
    const unpatched = makeHome({ patched: false });
    const opts = {
      akRoot: REPO,
      bundleDir: makeBundle(),
      pinsDir: makeDir(),
      ledgerDir: makeDir(),
      upstream: unpatched.upstream,
      now: FIXED_NOW,
    };
    expect(install({ fmHome: unpatched.home }, opts).ok).toBe(false);
    expect(existsSync(join(unpatched.home, "config/agent-kit.env"))).toBe(false);

    const { home, opts: o2 } = env();
    writeFileSync(join(home, "config/agent-kit.env"), "SOMEONE_ELSE=1\n");
    expect(install({ fmHome: home }, o2).ok).toBe(false);
    expect(remove({ fmHome: home }, o2).ok).toBe(false);
    expect(readFileSync(join(home, "config/agent-kit.env"), "utf8")).toBe("SOMEONE_ELSE=1\n");
  });
});

describe("status", () => {
  const publish = { delivery: { action: "publish" as const } };
  const dry = { delivery: { action: "dry-run" as const } };

  test("maps each run state to one Firstmate status line (CONTRACT.md §4)", () => {
    expect(statusLine(publish, { outcome: "complete", at: 1, pr: "https://x/pr/1", evidence: ["r1", "v1"] })).toEqual({
      ok: true,
      line: "done [at=1]: PR https://x/pr/1 checks green evidence=r1,v1",
    });
    expect(statusLine(dry, { outcome: "complete", at: 1, evidence: ["r1"] }).line).toBe(
      "done [at=1]: dry-run ship prepared, nothing published evidence=r1",
    );
    expect(statusLine(dry, { outcome: "needs-input", at: 1, reason: "which base branch" }).line).toBe(
      "needs-decision [at=1]: which base branch",
    );
    expect(statusLine(dry, { outcome: "cap-reached", at: 1, run: "run-1", openFindings: ["f1", "f2"] }).line).toBe(
      "needs-decision [at=1] [key=fix-cap-run-1]: fix-cycle cap reached; blocked or replan; open findings=f1,f2",
    );
    expect(statusLine(dry, { outcome: "failed", at: 1, reason: "tests red" }).line).toBe("failed [at=1]: tests red");
    expect(statusLine(dry, { outcome: "cancelled", at: 1, by: "captain" }).line).toBe(
      "failed [at=1]: cancelled: captain",
    );
  });

  test("a child in an unknown state wins over every other outcome and keeps ownership", () => {
    for (const outcome of ["complete", "failed", "cancelled"] as const) {
      const r = statusLine(publish, {
        outcome,
        at: 2,
        pr: "https://x/pr/1",
        evidence: ["r1"],
        unknownChild: "c-3",
        reason: "x",
        by: "y",
      });
      expect(r.line).toBe("blocked [at=2]: child c-3 state unknown");
    }
  });

  test("a publish that reports done without a PR, or without evidence, is refused", () => {
    expect(statusLine(publish, { outcome: "complete", at: 1, evidence: ["r1"] }).ok).toBe(false);
    expect(statusLine(publish, { outcome: "complete", at: 1, pr: "https://x/pr/1", evidence: [] }).ok).toBe(false);
  });

  test("every non-complete outcome missing the field its line needs is refused, naming that field", () => {
    const rows: [StatusArgs, string][] = [
      [{ outcome: "needs-input", at: 1 }, "needs-input needs the decision, named"],
      [{ outcome: "cap-reached", at: 1, openFindings: ["f1"] }, "cap-reached needs the run id for its key"],
      [{ outcome: "failed", at: 1 }, "failed needs a reason"],
      [{ outcome: "cancelled", at: 1 }, "cancelled needs who cancelled it"],
    ];
    for (const [args, refusal] of rows) {
      expect(statusLine(dry, args)).toEqual({ ok: false, line: "", error: refusal });
    }
  });
});

describe("the ak firstmate command", () => {
  function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(argv, { cwd: REPO, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
    return { code, out, err };
  }

  test("with no subcommand prints its usage and exits 2", () => {
    const r = run(["firstmate"]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("ak firstmate preflight");
  });

  test("legacy patched preflight against a home without its upstream commit refuses", () => {
    const { home } = makeHome({ patched: true });
    const r = run([
      "firstmate",
      "preflight",
      "--legacy-patched",
      "--fm-home",
      home,
      "--project",
      makeProject(),
      "--evidence",
      "mock",
      "--evidence-location",
      makeDir(),
    ]);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toMatch(/FAIL\s+upstream-commit/);
    expect(r.err).toEqual([expect.stringMatching(/^deprecated:/)]);
  });

  test("deprecated bind refuses stock delivery modes without writing a binding", () => {
    const { home, project } = env();
    for (const mode of ["no-mistakes", "direct-PR"]) {
      const binding = join(home, `data/${mode}/binding.json`);
      const r = run([
        "firstmate",
        "bind",
        "--fm-home",
        home,
        "--task-id",
        mode,
        "--project",
        project,
        "--mode",
        mode,
        "--binding-out",
        binding,
      ]);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(existsSync(binding)).toBe(false);
      expect(r.err.at(-1)).toMatch(/^deprecated:/);
      expect(r.err.join("\n")).toContain("ak firstmate preflight");
      expect(r.err.join("\n")).toContain("supervisor");
      expect(r.err.join("\n")).toContain("bypass check");
      expect(r.err.join("\n")).not.toMatch(/bypass grant --/);
    }
  });

  test("deprecated legacy commands append exactly one final stderr line", () => {
    const { home, project } = env();
    for (const args of [
      [
        "bind",
        "--fm-home",
        home,
        "--task-id",
        "T-1",
        "--project",
        project,
        "--mode",
        "agent-kit",
        "--binding-out",
        join(home, "data/T-1/binding.json"),
        "--bogus",
      ],
      ["install", "--fm-home", home, "--bogus"],
      ["remove", "--fm-home", home, "--bogus"],
      ["grant", "--binding", join(home, "missing.json"), "--operation", "review.full", "--bogus"],
      ["status", join(home, "missing.json"), "--verify", "--bogus"],
      ["preflight", "--legacy-patched", "--fm-home", home, "--project", project, "--bogus"],
    ]) {
      const r = run(["firstmate", ...args]);
      expect(r.code).toBe(2);
      expect(r.out).toEqual([]);
      expect(r.err.filter((line) => line.startsWith("deprecated:"))).toHaveLength(1);
      expect(r.err.at(-1)).toMatch(/^deprecated:/);
    }
    const stock = run(["firstmate", "preflight", "--fm-home", home, "--project", project, "--bogus"]);
    expect(stock.err.some((line) => line.startsWith("deprecated:"))).toBe(false);
  });

  test("status reads a binding file and prints one line", () => {
    const { home, project, opts } = env();
    const out = join(home, "data/T-8/binding.json");
    bind(
      {
        fmHome: home,
        taskId: "T-8",
        project,
        mode: "agent-kit",
        host: "claude-code",
        bindingOut: out,
        evidence: { store: "mock", location: makeDir() },
      },
      opts,
    );
    // complete is audited first, which tests/firstmate/status.test.ts covers against a temp ledger.
    const r = run(["firstmate", "status", out, "failed", "--reason", "tests red", "--at", "5"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["failed [at=5]: tests red"]);
  });

  test("an unknown flag is an error, never ignored", () => {
    const r = run(["firstmate", "status", "x.json", "complete", "--bogus", "1"]);
    expect(r.code).toBe(2);
  });
});

function call(argv: string[]) {
  const err: string[] = [];
  const code = runFirstmate(argv, { out: () => {}, err: (line) => err.push(line) });
  return { code, first: err[0] };
}

describe("ak firstmate refuses an unknown selector with what it accepts", () => {
  test("subcommand", () => {
    expect(call(["sttaus"])).toEqual({
      code: 2,
      first: "ak firstmate: unknown subcommand 'sttaus'; did you mean status?",
    });
  });

  test("host", () => {
    expect(call(["preflight", "--host", "codx"])).toEqual({
      code: 2,
      first: "ak firstmate: --host: unknown host 'codx'; did you mean codex?",
    });
  });

  test("evidence store", () => {
    expect(call(["install", "--fm-home", "/nonexistent", "--evidence", "kbb", "--evidence-location", "x"])).toEqual({
      code: 2,
      first: "ak firstmate: --evidence: unknown store 'kbb'; did you mean kb?",
    });
  });

  test("delivery mode", () => {
    const brief = ["brief", "--run", "r", "--charter", "c", "--runner-socket", "s", "--worker-token", "t"];
    expect(call([...brief, "--delivery", "direct-pr"])).toEqual({
      code: 2,
      first:
        "ak firstmate brief: --delivery must be a stock Firstmate mode: unknown mode 'direct-pr'; did you mean direct-PR?",
    });
  });

  test("status outcome", () => {
    expect(call(["status", "/nonexistent/binding.json", "complet"])).toEqual({
      code: 2,
      first: "ak firstmate status: unknown outcome 'complet'; did you mean complete?",
    });
  });
});

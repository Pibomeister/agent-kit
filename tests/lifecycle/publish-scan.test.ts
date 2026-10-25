/**
 * `ak lifecycle publish-scan`: pull-request title, body and commit messages bound for a repository
 * outside the operator's organization are checked against the operator's internal markers before
 * publishing. Every case writes its own markers file and passes it with `--markers`.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { main } from "../../src/lifecycle/gate.ts";
import { defaultMarkersPath, loadMarkers, scanApplies, scanText } from "../../src/lifecycle/publish-scan.ts";
import { makeTree } from "../helpers/tree.ts";

const BRIEF =
  "Keep scratch files in the ignored work folder and never paste this brief into a pull request description.\n";

const MARKERS = [
  "# internal markers",
  "owner: example-org",
  "marker: example-org",
  "marker: build.example.internal",
  "marker: @example.com",
  "instructions: brief.md",
  "",
].join("\n");

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

/** A repository with a base commit and one commit per message, and a markers file beside it. */
function fixture(messages: readonly string[], markers = MARKERS) {
  const root = makeTree({ "cfg/markers": markers, "cfg/brief.md": BRIEF, "repo/README.md": "base\n" });
  const repo = join(root, "repo");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  for (const [i, message] of messages.entries())
    git(repo, "commit", "-q", "--allow-empty", "-m", message, "-m", `n${i}`);
  return { root, repo, markers: join(root, "cfg/markers") };
}

function run(argv: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["publish-scan", ...argv], { out: (l) => out.push(l), err: (l) => err.push(l) }, cwd);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("publish-scan", () => {
  test("clean title, body and commits on a public repository pass", () => {
    const f = fixture(["fix: bound the cache"]);
    const body = join(f.root, "body.md");
    writeFileSync(body, "Bounds the cache so reads stay small.\n");
    const r = run(
      [
        "--repo",
        "someone/tool",
        "--visibility",
        "public",
        "--title",
        "fix: bound the cache",
        "--body-file",
        body,
      ].concat(["--commits", "main~1..main", "--markers", f.markers]),
      f.repo,
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("ok: 3 text(s)");
  });

  test("a marker in the title stops the scan and names where it was found", () => {
    const f = fixture([]);
    const r = run(
      ["--repo", "someone/tool", "--title", "Wire up build.EXAMPLE.internal", "--markers", f.markers],
      f.repo,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('title contains the internal marker "build.example.internal"');
  });

  test("a work e-mail domain in a commit message stops the scan", () => {
    const f = fixture(["fix: thing", "chore: ask someone@example.com"]);
    const r = run(["--repo", "someone/tool", "--commits", "main~2..main", "--markers", f.markers], f.repo);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/commit [0-9a-f]{12} contains the internal marker "@example.com"/);
  });

  test("instruction text copied into the body stops the scan, across a rewrap", () => {
    const f = fixture([]);
    const body = join(f.root, "body.md");
    writeFileSync(body, "Summary.\n\nNever paste this brief\ninto a pull request description, as agreed.\n");
    const r = run(["--repo", "someone/tool", "--body-file", body, "--markers", f.markers], f.repo);
    expect(r.code).toBe(1);
    expect(r.err).toContain("body repeats instruction text from brief.md");
  });

  test("a private repository of a configured owner is not scanned", () => {
    const f = fixture([]);
    const r = run(
      ["--repo", "Example-Org/app", "--visibility", "PRIVATE", "--title", "example-org fix", "--markers", f.markers],
      f.repo,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("not scanned");
  });

  test("a private repository of another owner, or an unstated visibility, is scanned", () => {
    const f = fixture([]);
    const other = run(
      ["--repo", "someone/app", "--visibility", "private", "--title", "example-org fix", "--markers", f.markers],
      f.repo,
    );
    const unstated = run(["--repo", "example-org/app", "--title", "example-org fix", "--markers", f.markers], f.repo);
    expect(other.code).toBe(1);
    expect(unstated.code).toBe(1);
  });

  test("no markers file is reported as nothing to scan for, not as a refusal", () => {
    const f = fixture([]);
    const r = run(["--repo", "someone/tool", "--title", "x", "--markers", join(f.root, "absent")], f.repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to scan for");
  });

  test("an unreadable markers file, body or commit range refuses rather than passing", () => {
    const f = fixture([], "owner: example-org\nhost: build.example.internal\n");
    const bad = run(["--repo", "someone/tool", "--title", "x", "--markers", f.markers], f.repo);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('line 2: unknown kind "host"');
    const good = fixture([]);
    const body = run(["--repo", "someone/tool", "--body-file", "missing.md", "--markers", good.markers], good.repo);
    const range = run(["--repo", "someone/tool", "--commits", "nope..main", "--markers", good.markers], good.repo);
    expect(body.code).toBe(1);
    expect(range.code).toBe(1);
  });

  test("--repo is required and must be owner/name", () => {
    const f = fixture([]);
    expect(run(["--title", "x"], f.repo).code).toBe(2);
    expect(run(["--repo", "tool"], f.repo).code).toBe(2);
  });

  test("the library calls agree with the command", () => {
    const f = fixture([]);
    const markers = loadMarkers(f.markers);
    if (markers === undefined) throw new Error("fixture markers missing");
    expect(scanApplies(markers, "example-org/app", "internal")).toBe(false);
    expect(scanApplies(markers, "example-org/app", "public")).toBe(true);
    expect(scanText(markers, [{ source: "title", text: "plain text" }])).toEqual([]);
    expect(defaultMarkersPath({ AK_PUBLISH_MARKERS: "/x/markers" })).toBe("/x/markers");
  });
});

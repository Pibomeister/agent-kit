/**
 * Every fixed text agent-kit hands an agent, rendered the way the agent receives it.
 *
 * "Fixed" means the text does not depend on the user's work: the bundle the packager emits, the
 * maintainer instructions loaded into every session in this repository, the session-start block
 * the learning hook prints, the judge prompts before their inputs are appended, and the brief
 * sections handed to a Firstmate worker. Where a renderer takes inputs, the inputs here are
 * invented and fixed, so a change in size is a change in the renderer's own text.
 *
 * The bundle is planned in memory, never read from `dist/`, which a fresh clone does not have.
 * It is planned for the default install: `ak.install.yaml` changes the generated frontmatter, so
 * the planner reads a root that links every top-level entry of the tree except that file.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { entryBodyPath } from "../../src/catalog/layout.ts";
import { loadCatalog, type Catalog } from "../../src/catalog/load.ts";
import { stockBrief } from "../../src/firstmate/stock.ts";
import { loadConfig } from "../../src/learn/core/config.ts";
import type { LearnContext } from "../../src/learn/core/context.ts";
import { buildPrompt, type LearnRole } from "../../src/learn/core/roles.ts";
import { OUTPUT_CONTRACT as CONSOLIDATOR_CONTRACT } from "../../src/learn/memory/consolidate.ts";
import { OUTPUT_CONTRACT as LESSON_MERGER_CONTRACT } from "../../src/learn/memory/deep.ts";
import { memoryDir, SECTIONS, writeLesson } from "../../src/learn/memory/ledger.ts";
import { outputContract as reflectorContract } from "../../src/learn/memory/reflect.ts";
import { sessionStartBlock } from "../../src/learn/memory/session-context.ts";
import { reviewLedgerDir } from "../../src/learn/review/ledger.ts";
import { MAINTAINER_CONTRACT } from "../../src/learn/review/maintain.ts";
import { SKILL_SCOUT_CONTRACT } from "../../src/learn/skills/learn.ts";
import { rosterSection } from "../../src/learn/skills/roster.ts";
import { HOST_IDS } from "../../src/packaging/hosts.ts";
import { INSTALL_FILE } from "../../src/packaging/install.ts";
import { planBundle } from "../../src/packaging/plan.ts";
import { parseFrontmatter } from "../../src/util/frontmatter.ts";

export interface Surface {
  /** Stable key in the baseline. */
  id: string;
  /** The file to edit when this surface changes size. */
  file: string;
  text: string;
}

/** Loaded into every agent session opened in this repository (`CLAUDE.md` imports `AGENTS.md`). */
const REPO_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];

/** Handed to a Firstmate worker or supervisor as written (`adapters/firstmate/CONTRACT.md`). */
const FIRSTMATE_TEXTS = [
  "adapters/firstmate/WORKER.md",
  "adapters/firstmate/SUPERVISOR.md",
  "adapters/firstmate/CHILD-ROLES.md",
];

/** Every profile, so a skill outside the default install is held too. */
const BUNDLE_PROFILE = "all";

/** Bundle paths an agent reads: skill entry text, the references behind it and the shared material. */
const AGENT_FACING = /^(skills|references)\//;

function read(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

/** A root holding every top-level entry of `root` but the install file, so planning sees the default install. */
export function withDefaultInstall<T>(root: string, use: (planRoot: string) => T): T {
  const farm = mkdtempSync(join(tmpdir(), "ak-budget-"));
  try {
    for (const name of readdirSync(root)) if (name !== INSTALL_FILE) symlinkSync(join(root, name), join(farm, name));
    return use(farm);
  } finally {
    rmSync(farm, { recursive: true, force: true });
  }
}

function bundleSurfaces(root: string): Surface[] {
  return withDefaultInstall(root, (planRoot) => {
    const { catalog } = loadCatalog(planRoot);
    if (catalog === null) throw new Error("catalog.yaml did not load; the bundle cannot be planned");
    const out: Surface[] = [];
    for (const host of HOST_IDS) {
      const files = [...planBundle({ root: planRoot, catalog }, host, { profile: BUNDLE_PROFILE }).files.values()]
        .filter((file) => AGENT_FACING.test(file.path))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const listing: string[] = [];
      for (const file of files) {
        out.push({ id: `bundle/${host}:${file.path}`, file: file.source ?? file.path, text: file.contents });
        if (/^skills\/[^/]+\/SKILL\.md$/.test(file.path)) {
          const { data } = parseFrontmatter(file.contents);
          listing.push(`- ${String(data["name"])}: ${String(data["description"])}\n`);
        }
      }
      // What the host lists before any skill is read: one name and description per skill.
      out.push({ id: `bundle/${host}:skill-listing`, file: "skills/*/SKILL.md (description)", text: listing.join("") });
    }
    return out;
  });
}

function roleSurfaces(root: string, catalog: Catalog): Surface[] {
  return catalog
    .bySection("roles")
    .filter((entry) => entry.status === "authored")
    .map((entry) => {
      const file = entryBodyPath("roles", entry.id);
      return { id: `role:${entry.id}`, file, text: read(root, file) };
    });
}

/** The learning hook's session-start block, outside a repository and for an invented project. */
function hookSurfaces(root: string): Surface[] {
  const base = mkdtempSync(join(tmpdir(), "ak-budget-"));
  try {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: join(base, "config"),
      CLAUDE_MEM_DATA_DIR: join(base, "mem"),
      AK_LEARN_ROLES_DIR: join(root, "roles", "learn"),
    };
    const ctx: LearnContext = {
      cwd: base,
      io: { out: () => undefined, err: () => undefined },
      config: loadConfig(env),
      judge: () => null,
      env,
    };

    const project = join(base, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const review = reviewLedgerDir(ctx.config, project);
    mkdirSync(review, { recursive: true });
    writeFileSync(join(review, "index.md"), "# Review patterns\n");
    writeFileSync(
      join(review, "guardrails.md"),
      "# Guardrails\n\n- [rp-001] name the failing input in the test title\n",
    );
    const memory = memoryDir(ctx.config, project);
    mkdirSync(join(memory, "lessons"), { recursive: true });
    writeFileSync(
      join(memory, "memory.md"),
      `## Current state\n- the parser accepts tabs [obs:1]\n${SECTIONS.slice(1).join("\n")}\n`,
    );
    writeLesson(
      join(memory, "lessons", "ls-001.md"),
      {
        id: "ls-001",
        statement: "run the parser fixtures before the full suite",
        status: "confirmed",
        confidence: "0.90",
      },
      "\n",
    );

    return [
      {
        id: "hook:session-start (no repository)",
        file: "src/learn/skills/roster.ts",
        text: rosterSection(ctx, null, { packageRoot: root }),
      },
      {
        id: "hook:session-start (invented project)",
        file: "src/learn/memory/session-context.ts",
        text: sessionStartBlock({ ...ctx, cwd: project }),
      },
    ];
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Each learning judge's prompt before its inputs: the role prose, the output contract and the frame. */
function judgeSurfaces(root: string): Surface[] {
  const env: NodeJS.ProcessEnv = { AK_LEARN_ROLES_DIR: join(root, "roles", "learn") };
  const judges: ReadonlyArray<[role: LearnRole, file: string, contract: string]> = [
    ["pattern-maintainer", "src/learn/review/maintain.ts", MAINTAINER_CONTRACT],
    ["reflector", "src/learn/memory/reflect.ts", reflectorContract(loadConfig(env).memoryTokens, "2026-01-01")],
    ["consolidator", "src/learn/memory/consolidate.ts", CONSOLIDATOR_CONTRACT],
    ["lesson-merger", "src/learn/memory/deep.ts", LESSON_MERGER_CONTRACT],
    ["skill-scout", "src/learn/skills/learn.ts", SKILL_SCOUT_CONTRACT],
  ];
  return judges.map(([role, file, contract]) => ({
    id: `judge:${role}`,
    file,
    text: buildPrompt(role, contract, [], env),
  }));
}

function firstmateSurfaces(root: string): Surface[] {
  return [
    ...FIRSTMATE_TEXTS.map((file) => ({ id: `firstmate:${file}`, file, text: read(root, file) })),
    {
      id: "firstmate:stock-brief",
      file: "src/firstmate/stock.ts",
      text: stockBrief({
        run: "run-0001",
        charter: "/charters/charter.json",
        socket: "/run/ak/runner.sock",
        workerToken: "0".repeat(32),
        delivery: "direct-PR",
      }),
    },
  ];
}

export function collectSurfaces(root: string): Surface[] {
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("catalog.yaml did not load; the surfaces cannot be listed");
  return [
    ...REPO_INSTRUCTIONS.map((file) => ({ id: `repo:${file}`, file, text: read(root, file) })),
    ...bundleSurfaces(root),
    ...roleSurfaces(root, catalog),
    ...hookSurfaces(root),
    ...judgeSurfaces(root),
    ...firstmateSurfaces(root),
  ];
}

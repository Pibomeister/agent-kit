/**
 * `ak firstmate install|remove`: the files a patched Firstmate home reads to
 * find agent-kit, plus the evidence store only `ak` reads, and nothing else
 * (CONTRACT.md §3).
 *
 * install refuses a home the patch stack is not applied to, and refuses to overwrite
 * any file it did not write. remove deletes exactly those files, and only when
 * install wrote them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { checkPatchApplied, checkUpstreamCommit } from "./checks.ts";
import {
  BINDING_TOKEN,
  CHILD_GUARD,
  ENV_FILE,
  ENV_HEADER,
  EVIDENCE_FILE,
  PATCH_ID,
  SETTINGS_FILE,
  type Evidence,
  type FirstmateOptions,
} from "./constants.ts";

export interface InstallArgs {
  fmHome: string;
  evidence?: Evidence;
}

export interface InstallResult {
  ok: boolean;
  errors: string[];
  written: string[];
}

function envText(home: string, akRoot: string): string {
  const lines = [
    ENV_HEADER,
    `AK_FIRSTMATE_BIN=${join(akRoot, "src/cli.ts")}`,
    `AK_FIRSTMATE_PATCH=${PATCH_ID}`,
    `AK_FIRSTMATE_WORKER_SETTINGS=${join(home, SETTINGS_FILE)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function evidenceText(evidence: Evidence): string {
  return `${ENV_HEADER}\nAK_FIRSTMATE_EVIDENCE=${evidence.store}\nAK_FIRSTMATE_EVIDENCE_LOCATION=${evidence.location}\n`;
}

const SEMANTIC_LINT_HOOK = "tools/hooks/semantic-lint.ts";

function settingsText(akRoot: string): string {
  const hook = join(akRoot, CHILD_GUARD);
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: `bash '${hook}' --binding '${BINDING_TOKEN}'` }],
        },
      ],
      // The advisory semantic lint: on by default, quiet until the key file the pin names holds a key.
      Stop: [{ hooks: [{ type: "command", command: `bun '${join(akRoot, SEMANTIC_LINT_HOOK)}' hook`, timeout: 30 }] }],
    },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function ours(file: string, kind: "env" | "settings"): boolean {
  const text = readFileSync(file, "utf8");
  if (kind === "env") return text.startsWith(`${ENV_HEADER}\n`);
  return text.includes(CHILD_GUARD) && text.includes(BINDING_TOKEN);
}

export function install(args: InstallArgs, opts: FirstmateOptions): InstallResult {
  const home = resolve(args.fmHome);
  const upstream = checkUpstreamCommit(home, opts.upstream);
  const patch = upstream.ok ? checkPatchApplied(home, opts.upstream) : upstream;
  if (!patch.ok) return { ok: false, errors: [`${patch.id}: ${patch.detail}`], written: [] };

  const targets = [
    { rel: ENV_FILE, kind: "env" as const, text: envText(home, resolve(opts.akRoot)) },
    { rel: SETTINGS_FILE, kind: "settings" as const, text: settingsText(resolve(opts.akRoot)) },
    ...(args.evidence === undefined
      ? []
      : [{ rel: EVIDENCE_FILE, kind: "env" as const, text: evidenceText(args.evidence) }]),
  ];
  const stale = args.evidence === undefined ? [{ rel: EVIDENCE_FILE, kind: "env" as const }] : [];
  const foreign = [...targets, ...stale].filter(
    (t) => existsSync(join(home, t.rel)) && !ours(join(home, t.rel), t.kind),
  );
  if (foreign.length > 0) {
    return {
      ok: false,
      errors: foreign.map(
        (t) => `${join(home, t.rel)} exists and was not written by ak firstmate install; refusing to overwrite it`,
      ),
      written: [],
    };
  }
  for (const t of targets) {
    const full = join(home, t.rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, t.text);
  }
  for (const t of stale) if (existsSync(join(home, t.rel))) rmSync(join(home, t.rel));
  return { ok: true, errors: [], written: targets.map((t) => join(home, t.rel)) };
}

export function remove(args: { fmHome: string }, _opts: FirstmateOptions): InstallResult {
  const home = resolve(args.fmHome);
  const targets = [
    { rel: ENV_FILE, kind: "env" as const },
    { rel: SETTINGS_FILE, kind: "settings" as const },
    { rel: EVIDENCE_FILE, kind: "env" as const },
  ].filter((t) => existsSync(join(home, t.rel)));
  const foreign = targets.filter((t) => !ours(join(home, t.rel), t.kind));
  if (foreign.length > 0) {
    return {
      ok: false,
      errors: foreign.map((t) => `${join(home, t.rel)} was not written by ak firstmate install; refusing to delete it`),
      written: [],
    };
  }
  for (const t of targets) rmSync(join(home, t.rel));
  const settingsDir = join(home, dirname(SETTINGS_FILE));
  if (existsSync(settingsDir) && readdirSync(settingsDir).length === 0) rmdirSync(settingsDir);
  return { ok: true, errors: [], written: [] };
}

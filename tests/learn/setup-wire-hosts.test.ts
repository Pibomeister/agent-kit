/**
 * `ak learn setup wire` for the hosts beyond Claude and Codex: Droid, Grok and
 * Kimi. Every home is scratch space. The Droid and Kimi configuration files
 * are captured, sanitized ones (`tests/fixtures/learn-hosts/README.md`).
 */
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import type { RunResult } from "../../src/learn/core/proc.ts";
import { createSetupArea } from "../../src/learn/setup/cli.ts";
import { doctor } from "../../src/learn/setup/doctor.ts";
import { BLOCK_BEGIN, BLOCK_END, tomlHooks } from "../../src/learn/setup/toml-hooks.ts";
import { uninstall } from "../../src/learn/setup/uninstall.ts";
import { verifyChecks } from "../../src/learn/setup/verify.ts";
import {
  claudeSettingsPath,
  GROK_HOOKS_FILE,
  type Json,
  MEM_MODE,
  type SetupDeps,
  WIRE_HOSTS,
  wire,
} from "../../src/learn/setup/wire.ts";
import { scratch, type TestContext, testContext } from "./helpers.ts";

const AK = "/opt/bun /pkg/src/cli.ts learn hook";
const FIXTURES = join(import.meta.dir, "..", "fixtures", "learn-hosts");
const DROID_FIXTURE = join(FIXTURES, "droid", "settings.json");
const DROID_SETTINGS = readFileSync(DROID_FIXTURE, "utf8");
const KIMI_CONFIG = readFileSync(join(FIXTURES, "kimi", "config.toml"), "utf8");

function fakeDeps(ak = ["/opt/bun", "/pkg/src/cli.ts"]): SetupDeps {
  const home = scratch("ak-home-");
  const packageRoot = scratch("ak-pkg-");
  const mode = join(packageRoot, "adapters", "observation-source", "claude-mem");
  mkdirSync(mode, { recursive: true });
  writeFileSync(join(mode, `${MEM_MODE}.json`), "{}\n");
  return {
    home,
    platform: "linux",
    uid: 501,
    run: (): RunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    which: (bin) => `/usr/bin/${bin}`,
    ak,
    packageRoot,
  };
}

function context(deps: SetupDeps, env: Record<string, string> = {}): TestContext {
  return testContext({ env: { CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "", ...env } });
}

function put(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function text(path: string): string {
  return readFileSync(path, "utf8");
}

/** Claude and Grok, the hosts beside the one whose file was refused, came out of the same `wire` wired. */
function othersWired(ctx: TestContext, deps: SetupDeps): boolean {
  const checks = verifyChecks(ctx, deps).filter((check) => /^(claude|grok) .* hook$/.test(check.label));
  return checks.length === 5 && checks.every((check) => check.ok);
}

/** Verify's Droid, Grok and Kimi checks, one line each. */
function hostChecks(ctx: TestContext, deps: SetupDeps): string[] {
  return verifyChecks(ctx, deps)
    .filter((check) => /^(droid|grok|kimi) /.test(check.label))
    .map((check) => `${check.label}: ${check.ok ? "ok" : check.detail}`);
}

type Doc = { [key: string]: Json };
const isDoc = new Ajv({ strict: false }).compile<Doc>({ type: "object" });

function json(path: string): Doc {
  const parsed: unknown = JSON.parse(text(path));
  if (!isDoc(parsed)) throw new Error(`${path} does not hold a JSON object`);
  return parsed;
}

/** The `hooks` object of a wrapped hook file. */
function hooksOf(doc: Doc): Doc {
  if (!isDoc(doc.hooks)) throw new Error("the file has no hooks object");
  return doc.hooks;
}

function entries(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new Error("the event has no entry list");
  return value;
}

function ours(command: string, timeout = 10) {
  return { hooks: [{ type: "command", command, timeout }] };
}

const SESSION_START = ours(`${AK} session-start`);

describe("setup wire: Droid", () => {
  test("merges into the settings file that declares SessionStart, and everything else in it survives", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const settings = put(join(deps.home, ".factory", "settings.json"), DROID_SETTINGS);

    expect(wire(ctx, deps, { noMem: true })).toBe(0);
    expect(ctx.out).toContain(`${settings}: 1 hook entries added or updated`);
    const captured = json(DROID_FIXTURE);
    const events = hooksOf(captured);
    expect(json(settings)).toEqual({
      ...captured,
      hooks: { ...events, SessionStart: [...entries(events.SessionStart), SESSION_START] },
    });
    expect(Object.keys(hooksOf(json(settings)))).toEqual(Object.keys(events));
    // Droid's own bookkeeping sits among the events; it stays where Droid put it.
    expect(text(settings)).toContain('"claudeHooksImported": true,\n    "importedClaudeHooks": [');
    expect(text(`${settings}.bak`)).toBe(DROID_SETTINGS);
    expect(existsSync(join(deps.home, ".factory", "hooks.json"))).toBe(false);

    const once = text(settings);
    const again = context(deps);
    expect(wire(again, deps, { noMem: true })).toBe(0);
    expect(text(settings)).toBe(once);
    expect(again.out).toContain(`${settings}: already wired`);
  });

  test("a home with no hooks at all gets a standalone hooks.json, keyed by event with no wrapper", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    expect(wire(ctx, deps, { host: "droid" })).toBe(0);
    expect(json(join(deps.home, ".factory", "hooks.json"))).toEqual({ SessionStart: [SESSION_START] });
    expect(readdirSync(join(deps.home, ".factory"))).toEqual(["hooks.json"]);
    expect(existsSync(ctx.config.configDir)).toBe(false);
  });

  test("the entry goes where SessionStart is read from: a standalone file's event replaces the settings file's", () => {
    const foreign = { hooks: [{ type: "command", command: "echo hi" }] };
    const cases = [
      {
        name: "both declare it",
        standalone: { SessionStart: [foreign] },
        settings: { hooks: { SessionStart: [foreign] } },
        to: "hooks.json",
      },
      {
        name: "only settings declares it",
        standalone: { Stop: [foreign] },
        settings: { hooks: { SessionStart: [foreign] } },
        to: "settings.json",
      },
      {
        name: "neither declares it",
        standalone: { Stop: [foreign] },
        settings: { hooks: { Stop: [foreign] } },
        to: "hooks.json",
      },
      {
        name: "settings holds other hooks and no standalone file exists",
        standalone: null,
        settings: { hooks: { Stop: [foreign] } },
        to: "settings.json",
      },
      { name: "settings holds no hooks", standalone: null, settings: { diffMode: "github" }, to: "hooks.json" },
    ];
    for (const item of cases) {
      const deps = fakeDeps();
      const home = join(deps.home, ".factory");
      if (item.standalone !== null) put(join(home, "hooks.json"), JSON.stringify(item.standalone));
      put(join(home, "settings.json"), JSON.stringify(item.settings));
      expect(wire(context(deps), deps, { host: "droid" })).toBe(0);
      const wired = readdirSync(home).filter((name) => text(join(home, name)).includes(`${AK} session-start`));
      expect({ name: item.name, wired }).toEqual({ name: item.name, wired: [item.to] });
    }
  });

  test("the legacy hooks/hooks.json is used while hooks.json is absent", () => {
    const deps = fakeDeps();
    const legacy = put(join(deps.home, ".factory", "hooks", "hooks.json"), JSON.stringify({ SessionStart: [] }));
    expect(wire(context(deps), deps, { host: "droid" })).toBe(0);
    expect(json(legacy)).toEqual({ SessionStart: [SESSION_START] });
    expect(existsSync(join(deps.home, ".factory", "hooks.json"))).toBe(false);
  });

  test("FACTORY_HOME_OVERRIDE replaces the home directory, not the .factory folder", () => {
    const deps = fakeDeps();
    const elsewhere = scratch("ak-factory-");
    expect(wire(context(deps, { FACTORY_HOME_OVERRIDE: elsewhere }), deps, { host: "droid" })).toBe(0);
    expect(json(join(elsewhere, ".factory", "hooks.json"))).toEqual({ SessionStart: [SESSION_START] });
    expect(existsSync(join(deps.home, ".factory"))).toBe(false);
  });

  test("a settings file with a comment in it may hold hooks this cannot see: Droid alone is skipped, and uninstall leaves the file in peace", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const commented = '{\n  // my hooks\n  "hooks": {}\n}\n';
    const settings = put(join(deps.home, ".factory", "settings.json"), commented);
    mkdirSync(join(deps.home, ".grok"));
    const reason = `${settings} is not valid JSON; fix it or remove it, nothing written`;
    expect(wire(ctx, deps, {})).toBe(1);
    expect(ctx.err).toEqual([reason]);
    expect(text(settings)).toBe(commented);
    expect(readdirSync(join(deps.home, ".factory"))).toEqual(["settings.json"]);
    expect(othersWired(ctx, deps)).toBe(true);
    expect(hostChecks(ctx, deps)).toContain(`droid hooks: not wired: ${reason}`);

    ctx.err.length = 0;
    expect(uninstall(ctx, deps)).toBe(0);
    expect(ctx.err).toEqual([]);
    expect(text(settings)).toBe(commented);
  });

  test("a hooks key that is not an object is refused by name", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const settings = put(join(deps.home, ".factory", "settings.json"), '{"hooks": []}');
    expect(wire(ctx, deps, { host: "droid" })).toBe(1);
    expect(ctx.err).toEqual([`${settings}: "hooks" is not an object; nothing written`]);
    expect(text(settings)).toBe('{"hooks": []}');
  });

  test("an event whose entries cannot be read is refused by name, in every file shape, and left as it was", () => {
    const unreadable = '[{"matcher": null, "hooks": [{"type": "command", "command": "echo mine"}]}]';
    for (const [host, file, body] of [
      ["droid", join(".factory", "hooks.json"), `{"SessionStart": ${unreadable}}`],
      ["droid", join(".factory", "settings.json"), `{"hooks": {"SessionStart": ${unreadable}}}`],
      ["codex", join(".codex", "hooks.json"), `{"hooks": {"SessionStart": ["echo mine"]}}`],
      ["claude", "settings.json", `{"hooks": {"Stop": {"hooks": []}}}`],
    ] as const) {
      const deps = fakeDeps();
      const ctx = context(deps);
      const path = put(host === "claude" ? claudeSettingsPath(ctx) : join(deps.home, file), body);
      const event = host === "claude" ? "Stop" : "SessionStart";
      expect(wire(ctx, deps, { host })).toBe(1);
      expect(ctx.err).toEqual([`${path}: "${event}" is not a list of hook entries; nothing written`]);
      expect(text(path)).toBe(body);
      expect(existsSync(`${path}.bak`)).toBe(false);
    }
  });

  test("an unreadable event nothing is wired on is carried through, and an empty one is filled", () => {
    const deps = fakeDeps();
    const hooks = put(join(deps.home, ".factory", "hooks.json"), '{"Stop": "later", "SessionStart": []}');
    expect(wire(context(deps), deps, { host: "droid" })).toBe(0);
    expect(json(hooks)).toEqual({ Stop: "later", SessionStart: [SESSION_START] });
  });
});

describe("setup wire: Grok", () => {
  const WIRED = {
    hooks: {
      PostToolUse: [ours(`${AK} session-start --host grok`)],
      SessionStart: [ours(`${AK} session-start --host grok --arm`)],
      PostCompact: [ours(`${AK} session-start --host grok --arm`)],
    },
  };

  test("writes a hook file of its own beside the user's, and wiring again changes nothing", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const theirs = put(join(deps.home, ".grok", "hooks", "mine.json"), '{"hooks":{}}');
    expect(wire(ctx, deps, { noMem: true })).toBe(0);
    const file = join(deps.home, ".grok", "hooks", GROK_HOOKS_FILE);
    expect(json(file)).toEqual(WIRED);
    expect(text(theirs)).toBe('{"hooks":{}}');
    const once = text(file);
    expect(wire(context(deps), deps, { noMem: true })).toBe(0);
    expect(text(file)).toBe(once);
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  test("GROK_HOME is honoured, and --host grok creates it", () => {
    const deps = fakeDeps();
    const home = join(scratch("ak-grok-"), "g");
    expect(wire(context(deps, { GROK_HOME: home }), deps, { host: "grok" })).toBe(0);
    expect(json(join(home, "hooks", GROK_HOOKS_FILE))).toEqual(WIRED);
    expect(existsSync(join(deps.home, ".grok"))).toBe(false);
  });

  test("a moved package updates the entries in place, and a hand-added hook in the file is kept", () => {
    const deps = fakeDeps();
    expect(wire(context(deps), deps, { host: "grok" })).toBe(0);
    const file = join(deps.home, ".grok", "hooks", GROK_HOOKS_FILE);
    const mine = { hooks: [{ type: "command", command: "echo done" }] };
    writeFileSync(file, JSON.stringify({ hooks: { ...WIRED.hooks, Stop: [mine] } }));
    const moved = { ...deps, ak: ["/new/bun", "/new pkg/src/cli.ts"] };
    expect(wire(context(deps), moved, { host: "grok" })).toBe(0);
    const base = "/new/bun '/new pkg/src/cli.ts' learn hook session-start --host grok";
    expect(json(file)).toEqual({
      hooks: {
        PostToolUse: [ours(base)],
        SessionStart: [ours(`${base} --arm`)],
        PostCompact: [ours(`${base} --arm`)],
        Stop: [mine],
      },
    });
  });
});

describe("setup wire: Kimi", () => {
  const BLOCK = [
    BLOCK_BEGIN,
    "# Written by `ak learn setup wire`; `ak learn setup uninstall` removes this block.",
    "[[hooks]]",
    'event = "UserPromptSubmit"',
    `command = "${AK} session-start --host kimi"`,
    "timeout = 10",
    "",
    "[[hooks]]",
    'event = "SessionStart"',
    `command = "${AK} session-start --host kimi --arm"`,
    "timeout = 10",
    "",
    "[[hooks]]",
    'event = "PostCompact"',
    `command = "${AK} session-start --host kimi --arm"`,
    "timeout = 10",
    BLOCK_END,
    "",
  ].join("\n");

  test("appends one marked block to a captured config, leaving every other byte and block as found", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const config = put(join(deps.home, ".kimi-code", "config.toml"), KIMI_CONFIG);
    expect(wire(ctx, deps, { noMem: true })).toBe(0);
    expect(ctx.out).toContain(`${config}: hook block written`);
    expect(text(config)).toBe(`${KIMI_CONFIG}\n${BLOCK}`);
    expect(text(`${config}.bak`)).toBe(KIMI_CONFIG);
    const before = tomlHooks(KIMI_CONFIG) ?? [];
    expect(before).toHaveLength(8);
    expect(tomlHooks(text(config))).toHaveLength(before.length + 3);

    const again = context(deps);
    expect(wire(again, deps, { noMem: true })).toBe(0);
    expect(text(config)).toBe(`${KIMI_CONFIG}\n${BLOCK}`);
    expect(again.out).toContain(`${config}: already wired`);
  });

  test("every table carries only the keys Kimi's schema allows", () => {
    const deps = fakeDeps();
    expect(wire(context(deps), deps, { host: "kimi" })).toBe(0);
    const parsed = Bun.TOML.parse(text(join(deps.home, ".kimi-code", "config.toml")));
    expect(parsed).toEqual({
      hooks: [
        { event: "UserPromptSubmit", command: `${AK} session-start --host kimi`, timeout: 10 },
        { event: "SessionStart", command: `${AK} session-start --host kimi --arm`, timeout: 10 },
        { event: "PostCompact", command: `${AK} session-start --host kimi --arm`, timeout: 10 },
      ],
    });
  });

  test("a moved package rewrites the block where it stands, with a path that needs quoting", () => {
    const deps = fakeDeps();
    const config = put(join(deps.home, ".kimi-code", "config.toml"), KIMI_CONFIG);
    expect(wire(context(deps), deps, { host: "kimi" })).toBe(0);
    writeFileSync(config, `${text(config)}\n[tail]\nkept = true\n`);
    const moved = { ...deps, ak: ["/new/bun", `/it's "new"/src/cli.ts`] };
    expect(wire(context(deps), moved, { host: "kimi" })).toBe(0);
    const after = text(config);
    expect(after.split(BLOCK_BEGIN)).toHaveLength(2);
    expect(after.startsWith(`${KIMI_CONFIG}\n${BLOCK_BEGIN}\n`)).toBe(true);
    expect(after.endsWith(`${BLOCK_END}\n\n[tail]\nkept = true\n`)).toBe(true);
    const commands = (tomlHooks(after) ?? []).map((hook) => hook.command);
    expect(commands.slice(8)).toEqual([
      `/new/bun '/it'\\''s "new"/src/cli.ts' learn hook session-start --host kimi`,
      `/new/bun '/it'\\''s "new"/src/cli.ts' learn hook session-start --host kimi --arm`,
      `/new/bun '/it'\\''s "new"/src/cli.ts' learn hook session-start --host kimi --arm`,
    ]);
  });

  test("KIMI_CODE_HOME is honoured, and --host kimi creates it", () => {
    const deps = fakeDeps();
    const home = join(scratch("ak-kimi-"), "k");
    expect(wire(context(deps, { KIMI_CODE_HOME: home }), deps, { host: "kimi" })).toBe(0);
    expect(text(join(home, "config.toml"))).toBe(BLOCK);
    expect(existsSync(join(deps.home, ".kimi-code"))).toBe(false);
  });

  test("a config this runtime cannot read as TOML, or whose block lost a marker, is refused, and Kimi alone is skipped", () => {
    const unread =
      "cannot be read as TOML by this runtime, whose parser also rejects some valid files, date and time values among them; fix the file or quote that value, nothing written";
    const unpaired =
      "cannot take the agent-kit [[hooks]] block between its two marker lines as they stand; restore the pair or remove both lines, nothing written";
    for (const [broken, reason] of [
      ['name = = "x"\n', unread],
      ["released = 2024-01-01\n", unread],
      ["at = 07:32:00\n", unread],
      [`a = 1\n${BLOCK_BEGIN}\n`, unpaired],
      [`${BLOCK_END}\n${BLOCK_BEGIN}\n`, unpaired],
    ] as const) {
      const deps = fakeDeps();
      const ctx = context(deps);
      const config = put(join(deps.home, ".kimi-code", "config.toml"), broken);
      mkdirSync(join(deps.home, ".grok"));
      expect(wire(ctx, deps, {})).toBe(1);
      expect(ctx.err).toEqual([`${config} ${reason}`]);
      expect(text(config)).toBe(broken);
      expect(readdirSync(join(deps.home, ".kimi-code"))).toEqual(["config.toml"]);
      expect(othersWired(ctx, deps)).toBe(true);
      expect(hostChecks(ctx, deps)).toContain(`kimi hooks: not wired: ${ctx.err[0]}`);
    }
  });

  test("a config that assigns `hooks` as a key cannot take a [[hooks]] table after it, and is refused", () => {
    for (const closed of [
      "hooks = []\n",
      'model = "m"\nhooks = [{ event = "Stop", command = "echo hi" }]\n\n[ui]\ntheme = "dark"\n',
      'paths = [\n  ["a", "b"],\n]\nhooks = []\n',
    ]) {
      const deps = fakeDeps();
      const ctx = context(deps);
      const config = put(join(deps.home, ".kimi-code", "config.toml"), closed);
      mkdirSync(join(deps.home, ".grok"));
      const reason = `${config} assigns \`hooks\` as a key, which no [[hooks]] table can follow; declare its hooks as [[hooks]] tables, nothing written`;
      expect(wire(ctx, deps, {})).toBe(1);
      expect(ctx.err).toEqual([reason]);
      expect(text(config)).toBe(closed);
      expect(readdirSync(join(deps.home, ".kimi-code"))).toEqual(["config.toml"]);
      expect(othersWired(ctx, deps)).toBe(true);
      expect(hostChecks(ctx, deps)).toContain(`kimi hooks: not wired: ${reason}`);
    }
  });

  test("a `hooks` key inside another table, or a `[` line inside a root value, does not stop the block", () => {
    for (const open of [
      '[ui]\nhooks = "on"\n',
      'paths = [\n  ["a", "b"],\n]\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo hi"\n',
    ]) {
      const deps = fakeDeps();
      const config = put(join(deps.home, ".kimi-code", "config.toml"), open);
      expect(wire(context(deps), deps, { host: "kimi" })).toBe(0);
      expect(text(config)).toStartWith(open);
      expect(tomlHooks(text(config))?.filter((hook) => hook.command?.startsWith(AK))).toHaveLength(3);
    }
  });
});

describe("setup wire: every host", () => {
  test("a host whose home is absent is skipped with the command that creates it", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    expect(wire(ctx, deps, { noMem: true })).toBe(0);
    expect(ctx.out.slice(1)).toEqual([
      `${join(deps.home, ".codex")} not present; skipping Codex hooks (pass --host codex to create it)`,
      `${join(deps.home, ".factory")} not present; skipping Droid hooks (pass --host droid to create it)`,
      `${join(deps.home, ".grok")} not present; skipping Grok hooks (pass --host grok to create it)`,
      `${join(deps.home, ".kimi-code")} not present; skipping Kimi hooks (pass --host kimi to create it)`,
    ]);
    expect(readdirSync(deps.home)).toEqual([]);
  });

  test("one run wires every host whose home exists, and --host touches that host alone", () => {
    const deps = fakeDeps();
    for (const dir of [".factory", ".grok", ".kimi-code"]) mkdirSync(join(deps.home, dir));
    const ctx = context(deps);
    expect(wire(ctx, deps, { noMem: true })).toBe(0);
    expect(existsSync(join(ctx.config.configDir, "settings.json"))).toBe(true);
    expect(existsSync(join(deps.home, ".factory", "hooks.json"))).toBe(true);
    expect(existsSync(join(deps.home, ".grok", "hooks", GROK_HOOKS_FILE))).toBe(true);
    expect(existsSync(join(deps.home, ".kimi-code", "config.toml"))).toBe(true);

    const only = fakeDeps();
    const lone = context(only);
    for (const dir of [".factory", ".grok", ".kimi-code"]) mkdirSync(join(only.home, dir));
    expect(wire(lone, only, { host: "grok" })).toBe(0);
    expect(readdirSync(join(only.home, ".factory"))).toEqual([]);
    expect(readdirSync(join(only.home, ".kimi-code"))).toEqual([]);
    expect(existsSync(lone.config.configDir)).toBe(false);
    expect(existsSync(join(only.home, ".claude-mem"))).toBe(false);
  });

  test("the CLI takes each host by name and refuses any other", () => {
    const deps = fakeDeps();
    const run = createSetupArea(() => deps).verbs.wire?.run;
    if (run === undefined) throw new Error("setup has no wire verb");
    for (const host of WIRE_HOSTS) expect(run(parseLearnArgs(["--host", host, "--no-mem"]), context(deps))).toBe(0);
    const refused = context(deps);
    expect(run(parseLearnArgs(["--host", "vim"]), refused)).toBe(2);
    expect(refused.err).toEqual([
      "ak learn setup wire: --host: unknown host 'vim'; valid: claude, codex, droid, grok, kimi",
    ]);
  });
});

/** A home with every host present and wired. */
function wiredHome() {
  const deps = fakeDeps();
  const ctx = context(deps);
  const settings = put(join(deps.home, ".factory", "settings.json"), DROID_SETTINGS);
  const config = put(join(deps.home, ".kimi-code", "config.toml"), KIMI_CONFIG);
  mkdirSync(join(deps.home, ".grok"));
  expect(wire(ctx, deps, { noMem: true })).toBe(0);
  return { deps, ctx, settings, config, grok: join(deps.home, ".grok", "hooks", GROK_HOOKS_FILE) };
}

describe("setup uninstall, verify and doctor: every host", () => {
  test("uninstall takes out exactly what wire put in", () => {
    const { deps, settings, config, grok } = wiredHome();
    const ctx = context(deps);
    expect(uninstall(ctx, deps)).toBe(0);
    expect(json(settings)).toEqual(json(DROID_FIXTURE));
    expect(text(config)).toBe(KIMI_CONFIG);
    expect(existsSync(grok)).toBe(false);
    expect(ctx.out).toContain(`${settings}: 1 hook entries removed`);
    expect(ctx.out).toContain(`${grok}: 3 hook entries removed`);
    expect(ctx.out).toContain(`${config}: hook block removed`);
    expect(ctx.err).toEqual([]);
  });

  test("uninstall keeps a hook the user added to the Grok file, and a standalone Droid file loses only ours", () => {
    const deps = fakeDeps();
    const mine = { hooks: [{ type: "command", command: "echo done" }] };
    const hooks = put(
      join(deps.home, ".factory", "hooks.json"),
      JSON.stringify({ SessionStart: [mine], note: "kept", imported: [{ from: "elsewhere" }] }),
    );
    expect(wire(context(deps), deps, { host: "droid" })).toBe(0);
    expect(wire(context(deps), deps, { host: "grok" })).toBe(0);
    const grok = join(deps.home, ".grok", "hooks", GROK_HOOKS_FILE);
    writeFileSync(grok, JSON.stringify({ hooks: { ...hooksOf(json(grok)), Stop: [mine] } }));
    expect(uninstall(context(deps), deps)).toBe(0);
    expect(json(hooks)).toEqual({ SessionStart: [mine], note: "kept", imported: [{ from: "elsewhere" }] });
    expect(json(grok)).toEqual({ hooks: { Stop: [mine] } });
  });

  test("uninstall leaves a Kimi config whose block lost a marker untouched, and says so", () => {
    const deps = fakeDeps();
    const ctx = context(deps);
    const config = put(join(deps.home, ".kimi-code", "config.toml"), `a = 1\n${BLOCK_BEGIN}\n`);
    expect(uninstall(ctx, deps)).toBe(0);
    expect(text(config)).toBe(`a = 1\n${BLOCK_BEGIN}\n`);
    expect(ctx.err).toEqual([`${config}: the agent-kit hook block is not one marked pair; remove it by hand`]);
  });

  test("verify checks each host whose home exists, and fails one that was never wired", () => {
    const { deps, ctx } = wiredHome();
    const hosts = verifyChecks(ctx, deps).filter((check) => /^(droid|grok|kimi) /.test(check.label));
    expect(hosts.map((check) => `${check.label}: ${check.ok ? "ok" : check.detail}`)).toEqual([
      "droid SessionStart hook: ok",
      "grok PostToolUse hook: ok",
      "grok SessionStart hook: ok",
      "grok PostCompact hook: ok",
      "kimi UserPromptSubmit hook: ok",
      "kimi SessionStart hook: ok",
      "kimi PostCompact hook: ok",
    ]);

    const bare = fakeDeps();
    mkdirSync(join(bare.home, ".kimi-code"));
    const unwired = verifyChecks(context(bare), bare).filter((check) => /^(droid|grok|kimi) /.test(check.label));
    expect(unwired.map((check) => `${check.label}: ${check.ok ? "ok" : check.detail}`)).toEqual([
      "kimi UserPromptSubmit hook: 0 entries",
      "kimi SessionStart hook: 0 entries",
      "kimi PostCompact hook: 0 entries",
    ]);
  });

  test("doctor prints where it looks for each host", () => {
    const deps = fakeDeps();
    mkdirSync(join(deps.home, ".grok"));
    const ctx = context(deps, { KIMI_CODE_HOME: "/elsewhere/kimi" });
    doctor(ctx, deps);
    expect(ctx.out).toContain(`  droid home          ${join(deps.home, ".factory")}   (absent)`);
    expect(ctx.out).toContain(`  grok home           ${join(deps.home, ".grok")}`);
    expect(ctx.out).toContain("  kimi home           /elsewhere/kimi   (absent)");
  });
});

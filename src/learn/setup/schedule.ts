/**
 * `ak learn setup schedule` — the scheduler unit that runs `ak learn memory tick`.
 *
 * launchd on macOS, a systemd user timer where `systemctl` exists, otherwise a
 * cron line to add by hand. `PATH` is baked into the unit because a scheduler
 * starts without one, and `CLAUDE_CONFIG_DIR` is baked in exactly when the
 * operator's environment sets it, so the judge runs under the login the
 * operator has. The unit carries no
 * sandboxing directive such as `ProtectHome`: the tick must read claude-mem's
 * database under the home directory.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { splitCommand } from "../core/config.ts";
import type { LearnContext } from "../core/context.ts";
import launchdTemplate from "./templates/launchd.plist.tmpl" with { type: "text" };
import serviceTemplate from "./templates/systemd.service.tmpl" with { type: "text" };
import timerTemplate from "./templates/systemd.timer.tmpl" with { type: "text" };
import { unitScopeDiffers } from "./scope.ts";
import type { SetupDeps } from "./wire.ts";
import { shellQuote } from "./wire.ts";

export const LABEL = "dev.agent-kit.learn";
/** The skill doctor loop's unit (`doctor/loop.ts`), which `setup uninstall` removes with the tick's. */
export const DOCTOR_LOOP_LABEL = "dev.agent-kit.learn.doctor";
export const DEFAULT_INTERVAL_S = 900;
/** Embedded, so the single-file bundle renders units with no template files beside it. */
const TEMPLATES = {
  "launchd.plist.tmpl": launchdTemplate,
  "systemd.service.tmpl": serviceTemplate,
  "systemd.timer.tmpl": timerTemplate,
};

/** A repeat in seconds that also fires at load and boot, or one fixed weekly time that fires at neither. */
export type Cadence = number | "weekly";

export type SchedulerKind = "launchd" | "systemd" | "cron" | "none";

export function schedulerKind(deps: SetupDeps): SchedulerKind {
  if (deps.platform === "darwin") return "launchd";
  if (deps.which("systemctl") !== null) return "systemd";
  return deps.which("crontab") !== null ? "cron" : "none";
}

export interface UnitPaths {
  unit: string;
  timer?: string;
}

export function unitPaths(deps: SetupDeps, kind: SchedulerKind, label: string = LABEL): UnitPaths | null {
  if (kind === "launchd") return { unit: join(deps.home, "Library", "LaunchAgents", `${label}.plist`) };
  if (kind === "systemd") {
    const dir = join(deps.home, ".config", "systemd", "user");
    return { unit: join(dir, `${label}.service`), timer: join(dir, `${label}.timer`) };
  }
  return null;
}

export function tickArgv(deps: SetupDeps): string[] {
  return [...deps.ak, "learn", "memory", "tick"];
}

/** What one scheduler unit runs and how the scheduler names it. */
export interface UnitSpec {
  label: string;
  argv: string[];
  /** The systemd service's description. */
  service: string;
  /** What the systemd timer runs, in its description. */
  timer: string;
}

export function tickUnit(deps: SetupDeps): UnitSpec {
  return {
    label: LABEL,
    argv: tickArgv(deps),
    service: "agent-kit learning runtime: scheduled memory tick",
    timer: "the agent-kit learning tick",
  };
}

export function schedulerLog(ctx: LearnContext): string {
  return join(ctx.config.runtimeDir, "scheduler.log");
}

/** Variables passed through to the unit when set: where claude-mem and the worker hosts live, and every `AK_LEARN_*` knob including the judge command. */
const PASSTHROUGH = ["CLAUDE_MEM_DATA_DIR", "CODEX_HOME", "FACTORY_HOME_OVERRIDE", "GROK_HOME", "KIMI_HOME"];
/**
 * Never baked: the repo scope lives in the runtime's scope file, which the hooks read too, so a
 * re-run from a shell without the variable cannot widen the tick, nor one with it pin a stale scope.
 */
const NOT_BAKED = ["AK_LEARN_REPOS"];

/** The unit's environment, in a stable order. */
export function unitEnvironment(ctx: LearnContext): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const configDir = ctx.env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined && configDir.trim() !== "") out.push(["CLAUDE_CONFIG_DIR", configDir]);
  out.push(["PATH", ctx.env.PATH && ctx.env.PATH !== "" ? ctx.env.PATH : "/usr/local/bin:/usr/bin:/bin"]);
  const extra = Object.keys(ctx.env)
    .filter((key) => (PASSTHROUGH.includes(key) || key.startsWith("AK_LEARN_")) && !NOT_BAKED.includes(key))
    .sort();
  for (const key of extra) {
    const value = ctx.env[key];
    if (value !== undefined && value !== "") out.push([key, value]);
  }
  return out;
}

/** `$name` / `${name}` substitution. A variable with no value is an error, never an empty string. */
export function renderTemplate(name: keyof typeof TEMPLATES, vars: Readonly<Record<string, string | number>>): string {
  const text = TEMPLATES[name];
  return text.replace(/\$(?:\{(\w+)\}|(\w+))/g, (_, braced: string | undefined, bare: string | undefined) => {
    const key = (braced ?? bare)!;
    const value = vars[key];
    if (value === undefined) throw new Error(`template ${name}: no value for $${key}`);
    return String(value);
  });
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The command line a written unit runs, decoded from what `launchdPlist` (its argument strings) or
 * `systemdService` (its ExecStart, with the `%%` and `$$` escapes undone) wrote. Each decoder sits
 * beside its encoder so the two change together.
 */
export function unitArgv(text: string): string[] {
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1];
  if (exec !== undefined) return splitCommand(exec.replace(/%%/g, "%").replace(/\$\$/g, "$"));
  return [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((match) =>
    (match[1] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );
}

export function launchdPlist(
  ctx: LearnContext,
  deps: SetupDeps,
  cadence: Cadence,
  unit: UnitSpec = tickUnit(deps),
): string {
  return renderTemplate("launchd.plist.tmpl", {
    label: unit.label,
    arguments: unit.argv.map((arg) => `    <string>${xml(arg)}</string>`).join("\n"),
    trigger:
      cadence === "weekly"
        ? `  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>12</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>`
        : `  <key>StartInterval</key>
  <integer>${cadence}</integer>
  <key>RunAtLoad</key>
  <true/>`,
    environment: unitEnvironment(ctx)
      .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
      .join("\n"),
    log: xml(schedulerLog(ctx)),
  });
}

/** systemd expands `%` specifiers and `$` variables in these lines; both are doubled so a value reaches the tick verbatim. */
function systemdQuote(arg: string): string {
  const escaped = arg.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdService(ctx: LearnContext, deps: SetupDeps, unit: UnitSpec = tickUnit(deps)): string {
  return renderTemplate("systemd.service.tmpl", {
    description: unit.service,
    exec: unit.argv.map(systemdQuote).join(" "),
    environment: unitEnvironment(ctx)
      .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
      .join("\n"),
    log: systemdQuote(schedulerLog(ctx)),
  });
}

function wholeMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export function systemdTimer(cadence: Cadence, label: string = LABEL, what = "the agent-kit learning tick"): string {
  return renderTemplate("systemd.timer.tmpl", {
    what,
    when: cadence === "weekly" ? "every week" : `every ${wholeMinutes(cadence)} minutes`,
    trigger:
      cadence === "weekly"
        ? "OnCalendar=Sun 12:00\nPersistent=true"
        : `OnBootSec=2min\nOnUnitActiveSec=${wholeMinutes(cadence)}min`,
    unit: `${label}.service`,
  });
}

function cronWhen(cadence: Cadence): string {
  if (cadence === "weekly") return "0 12 * * 0";
  const minutes = wholeMinutes(cadence);
  return minutes < 60 ? `*/${minutes} * * * *` : `0 */${Math.max(1, Math.min(23, Math.round(minutes / 60)))} * * *`;
}

/** A crontab line. The weekly cadence fires on Sundays at noon. Intervals of an hour or more fire on the hour. Cron turns a bare `%` into a newline, so each is escaped. */
export function cronLine(
  ctx: LearnContext,
  deps: SetupDeps,
  cadence: Cadence,
  unit: UnitSpec = tickUnit(deps),
): string {
  const env = unitEnvironment(ctx).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = `${[...env, ...unit.argv.map(shellQuote)].join(" ")} >> ${shellQuote(schedulerLog(ctx))} 2>&1`;
  return `${cronWhen(cadence)} ${command.replace(/%/g, "\\%")}`;
}

/** `900`, `15m` or `1h` as seconds; null when unparseable or under a minute. */
export function parseInterval(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_INTERVAL_S;
  const match = /^(\d+)([smh]?)$/.exec(value.trim());
  if (match === null) return null;
  const n = Number.parseInt(match[1]!, 10) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
  return n >= 60 ? n : null;
}

/** Units carry `AK_LEARN_*` values such as the judge command, so they are readable by their owner only. */
function writeIfChanged(ctx: LearnContext, path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) {
    chmodSync(path, 0o600);
    ctx.io.out(`${path}: unchanged`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  ctx.io.out(`${path}: written`);
}

/** Write the unit for this machine's scheduler, and load it when asked. */
export function schedule(
  ctx: LearnContext,
  deps: SetupDeps,
  options: { intervalS?: number; load?: boolean } = {},
): number {
  const intervalS = options.intervalS ?? DEFAULT_INTERVAL_S;
  if (unitScopeDiffers(ctx)) {
    ctx.io.err(
      "ak learn setup schedule: AK_LEARN_REPOS is not carried into the unit, and the scope file differs, " +
        "so the scheduled tick would run with another scope; run `ak learn setup scope --set` with the same roots first",
    );
    return 1;
  }
  return installUnit(ctx, deps, tickUnit(deps), intervalS, options.load === true);
}

/** Write one unit for this machine's scheduler, and load it when asked. */
export function installUnit(
  ctx: LearnContext,
  deps: SetupDeps,
  unit: UnitSpec,
  cadence: Cadence,
  load: boolean,
): number {
  const kind = schedulerKind(deps);
  mkdirSync(ctx.config.runtimeDir, { recursive: true });
  if (kind === "none") {
    ctx.io.out("no supported scheduler (launchd, systemd, cron); run this from your own scheduler:");
    ctx.io.out(`  ${unit.argv.map(shellQuote).join(" ")}`);
    return 0;
  }
  if (kind === "cron") {
    ctx.io.out("add this line with `crontab -e`:");
    ctx.io.out(`  ${cronLine(ctx, deps, cadence, unit)}`);
    return 0;
  }
  const paths = unitPaths(deps, kind, unit.label)!;
  if (kind === "launchd") {
    writeIfChanged(ctx, paths.unit, launchdPlist(ctx, deps, cadence, unit));
  } else {
    writeIfChanged(ctx, paths.unit, systemdService(ctx, deps, unit));
    writeIfChanged(ctx, paths.timer!, systemdTimer(cadence, unit.label, unit.timer));
  }
  if (!load) {
    ctx.io.out("not loaded; rerun with --load to register it");
    return 0;
  }
  return loadUnit(ctx, deps, kind, paths, unit.label);
}

export function loadUnit(
  ctx: LearnContext,
  deps: SetupDeps,
  kind: SchedulerKind,
  paths: UnitPaths,
  label: string = LABEL,
): number {
  if (kind === "launchd") {
    const domain = `gui/${deps.uid}`;
    deps.run(["launchctl", "bootout", `${domain}/${label}`]);
    const result = deps.run(["launchctl", "bootstrap", domain, paths.unit]);
    ctx.io.out(`launchd: ${result.code === 0 ? "loaded" : `bootstrap failed: ${result.stderr.trim()}`}`);
    ctx.io.out(`status:  launchctl print ${domain}/${label}`);
    return result.code === 0 ? 0 : 1;
  }
  if (kind === "systemd") {
    deps.run(["systemctl", "--user", "daemon-reload"]);
    const result = deps.run(["systemctl", "--user", "enable", "--now", `${label}.timer`]);
    ctx.io.out(`systemd: ${result.code === 0 ? "timer enabled" : `enable failed: ${result.stderr.trim()}`}`);
    ctx.io.out(`status:  systemctl --user list-timers ${label}.timer`);
    return result.code === 0 ? 0 : 1;
  }
  return 0;
}

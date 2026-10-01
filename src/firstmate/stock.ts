/** Adapter for Firstmate's existing brief, spawn, status, inbox and delivery modes. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { checkBundle, checkHost, type Check } from "./checks.ts";
import { git } from "./proc.ts";
import type { Host } from "./constants.ts";

export interface StockPreflight {
  ok: boolean;
  mode: "guided" | "runner-candidate";
  checks: Check[];
}

export function preflightStock(
  fmHome: string,
  project: string,
  host: Host,
  akRoot: string,
  bundleDir: string,
  socket?: string,
): StockPreflight {
  const scripts = ["fm-brief.sh", "fm-spawn.sh", "fm-tasks-axi.sh"].map((name) => join(fmHome, "bin", name));
  const home: Check = scripts.every(existsSync)
    ? {
        id: "stock-firstmate",
        ok: true,
        detail: "normal brief and spawn commands are present; no patch or pinned commit required",
      }
    : {
        id: "stock-firstmate",
        ok: false,
        detail: `missing stock Firstmate commands: ${scripts.filter((file) => !existsSync(file)).join(", ")}`,
      };
  const checkout = git(project, ["rev-parse", "--show-toplevel"]);
  const repository: Check =
    checkout.code === 0
      ? { id: "project", ok: true, detail: `${checkout.text.trim()} is a git checkout` }
      : { id: "project", ok: false, detail: `${project} is not a git checkout` };
  const runner: Check =
    socket === undefined
      ? { id: "runner", ok: true, detail: "no runner socket supplied; guided checkpoints only" }
      : existsSync(socket) && statSync(socket).isSocket()
        ? {
            id: "runner",
            ok: true,
            detail: "runner socket exists; each run still validates its standing grant and trusted evidence",
          }
        : { id: "runner", ok: false, detail: `${socket} is not a live runner socket` };
  const delivery: Check = {
    id: "delivery",
    ok: true,
    detail:
      "use the task's normal no-mistakes or direct-PR mode; an auto-fix invalidates old runner evidence and requires new verification",
  };
  const bundle = checkBundle(bundleDir);
  const readyBundle =
    socket !== undefined && bundle.ok && !existsSync(join(bundleDir, "skills", "autopilot", "SKILL.md"))
      ? { id: "skill-bundle", ok: false, detail: `${bundleDir} lacks autopilot; run ak build --profile all` }
      : bundle;
  const checks = [home, repository, checkHost(akRoot, host), readyBundle, runner, delivery];
  return { ok: checks.every((check) => check.ok), mode: socket === undefined ? "guided" : "runner-candidate", checks };
}

export interface BriefArgs {
  run: string;
  charter: string;
  socket: string;
  workerToken: string;
  delivery: "no-mistakes" | "direct-PR" | "local-only";
}

export function stockBrief(args: BriefArgs): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.run) ||
    args.workerToken.length < 32 ||
    [args.charter, args.socket, args.workerToken].some((value) => /[\r\n\0]/.test(value))
  )
    throw new Error("invalid run, path or worker token for a Firstmate brief");
  return `## Agent Kit autopilot on stock Firstmate

This is a normal Firstmate crewmate task. Firstmate remains the outer supervisor; use this task's
existing status file, steering inbox and ${args.delivery} delivery contract. Do not invoke a new
Firstmate mode or treat this brief as authority to start a phase.

Runner run: ${args.run}
Approved charter: ${args.charter}
Runner socket: ${args.socket}
Worker token: ${args.workerToken}

At entry, set AK_RUNNER_SOCKET and AK_RUNNER_TOKEN to the socket and worker token above. Read the
runner's status for run ${args.run}. Load autopilot only if start_authority.kind is standing-grant
and its grant names this run, Firstmate, autopilot.start and the approved charter hash. A missing
or mismatched attestation is needs-decision; no phase command runs. The runner validates each
checkpoint grant and keeps evidence outside this worktree. Firstmate dispatches the two supervisor
seats as separate ordinary crewmates, never your children. With configured seat launchers the
runner asks Firstmate for them on decide; otherwise Firstmate submits both judgments before you
call decide, using the stock seat-launch and seat-judge commands. Use the normal status and inbox
handoff, not a polling loop.

Use ak runner call prepare and decide for checkpoints, sync after code changes, run-verify for
runner-owned verification, and ledger for the handback. A refused card returns one escalation;
report it through the normal Firstmate needs-decision status and inbox protocol. Use the task's
normal delivery mode for push and pull request. If delivery changes the head, sync, verify and
review again before reporting done. Never merge or deploy under this charter.

Evidence handoff: when you create a spec, ticket, review note or other checkpoint evidence, write
it in your worktree and call sync so the runner observes the current revision and diff. Report its
path, proposed evidence id and kind to Firstmate in a working status line. Firstmate copies the
bytes into its private runner evidence intake, calls collect with the supervisor token and current
revision, then sends the accepted evidence id and hash through your inbox. Prepare the card with
that id only after this receipt arrives. Your worker token cannot call collect, and a worker path
or self-reported test result is not trusted gate evidence. Wait for Firstmate's separate seat
judgments before calling decide; do not poll for them.
`;
}

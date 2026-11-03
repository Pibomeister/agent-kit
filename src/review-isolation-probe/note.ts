import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { profileFor } from "./hosts.ts";
import type { ProbeReport } from "./types.ts";

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderNote(report: ProbeReport): string {
  const profile = profileFor(report.host);
  const rows: string[] = [];
  for (const arm of report.arms) {
    const marker = arm.marker ?? "none";
    rows.push(`| ${arm.id} | \`${marker}\` | ${arm.verdict} | ${cell(arm.reason)} |`);
  }
  const commands = report.commands.length === 0 ? "none invoked" : report.commands.map((c) => `\`${c}\``).join("\n\n");
  const lines = [
    `# Review isolation probe — ${report.host}`,
    "",
    report.date,
    "",
    "Opt-in, live, billed. One arm per leak channel. Each arm plants a fresh `MARKER_` plus 32 hex",
    "digits, dispatches a new generic subagent through the doc-review path (not a fork or a resume),",
    "and scores the host's child transcript and the child's launch configuration. The child's answer",
    "is not the verdict. A pass means that channel did not leak at this host version; it does not mean",
    "no other channel does. Where the host does not expose the channel, the arm is `unobservable`,",
    "never a pass.",
  ];
  if (report.host === "claude-code") {
    lines.push(
      "",
      "On Claude Code, a fresh spawn is the absence of resume/fork in the Agent input, not a",
      "positive attestation, so a pass does not claim the host attested freshness.",
    );
  }
  lines.push(
    "",
    "## Instrument",
    "",
    "| Item | Value |",
    "|---|---|",
    `| Host | ${report.host} |`,
    `| Host version | ${cell(report.hostVersion)} |`,
    `| Plugins / hooks | ${cell(report.pluginsAndHooks)} |`,
    `| Driver | ${report.driver} |`,
    `| Work | ${report.work} |`,
    `| Verdict JSON | ${report.verdictPath} |`,
    "",
    "## What this host exposes",
    "",
    profile.exposes,
    "",
    "## Arms",
    "",
    "| Arm | Marker | Verdict | Observation |",
    "|---|---|---|---|",
    ...rows,
    "",
    "### Channels",
    "",
  );
  for (const arm of report.arms) {
    lines.push(`- **${arm.id}:** ${profile.channels[arm.id]}`);
  }
  lines.push("", "## Commands", "", commands, "", "## Receipts", "", `Verdict JSON: \`${report.verdictPath}\``, "");
  return `${lines.join("\n")}\n`;
}

export function writeNote(report: ProbeReport): void {
  mkdirSync(dirname(report.notePath), { recursive: true });
  writeFileSync(report.notePath, renderNote(report));
}

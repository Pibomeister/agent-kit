import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../util/hash.ts";
import type { KbRefusal, PublishOutcome } from "./local-git.ts";

function markAttempt(directory: string, record: string): void {
  const file = openSync(join(directory, `${sha256Hex(record)}.attempt`), "wx", 0o600);
  try {
    writeFileSync(file, `${record}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function publishTrailRecord(
  directory: string,
  record: string,
  publishArtifact: () => PublishOutcome | KbRefusal,
): PublishOutcome | KbRefusal {
  try {
    markAttempt(directory, record);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return {
        status: "failed",
        code: "kb.trail-publication-unknown",
        message: `${record}: publication outcome unknown; an earlier attempt was marked, so the record is not resent.`,
      };
    }
    return {
      status: "failed",
      code: "kb.trail-attempt-unrecorded",
      message: `${record}: the publish-attempt mark could not be made durable; nothing was sent.`,
    };
  }
  return publishArtifact();
}

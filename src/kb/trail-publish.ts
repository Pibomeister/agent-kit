import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../util/hash.ts";
import type { KbRefusal } from "./local-git.ts";

export function markTrailAttempt(directory: string, record: string): KbRefusal | null {
  let created = false;
  try {
    const file = openSync(join(directory, `${sha256Hex(record)}.attempt`), "wx", 0o600);
    created = true;
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
  } catch (error) {
    if (!created && error instanceof Error && "code" in error && error.code === "EEXIST") {
      return {
        status: "failed",
        code: "kb.trail-publication-unknown",
        message: `${record}: publication outcome unknown; an attempt was marked, so the record is not resent.`,
      };
    }
    return {
      status: "failed",
      code: "kb.trail-attempt-unrecorded",
      message: created
        ? `${record}: this call created a mark but could not make it durable; nothing was sent. The mark remains; a later call conservatively reports publication-unknown and must not resend.`
        : `${record}: the publish-attempt mark could not be created; nothing was sent and this call created no mark.`,
    };
  }
  return null;
}

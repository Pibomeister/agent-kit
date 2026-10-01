import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** The runner calls this interface; a later central KB adapter can provide its own refs. */
export interface EvidenceStore {
  put(runId: string, evidenceId: string, bytes: Buffer): string;
  read(ref: string): Buffer;
}

export class PrivateFileEvidenceStore implements EvidenceStore {
  readonly root: string;

  constructor(stateDir: string) {
    this.root = join(stateDir, "evidence");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const resolved = realpathSync(this.root);
    const rel = relative(stateDir, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("evidence store escapes runner state directory");
  }

  put(runId: string, evidenceId: string, bytes: Buffer): string {
    const ref = join(this.root, `${runId}-${evidenceId}.evidence`);
    writeFileSync(ref, bytes, { flag: "wx", mode: 0o600 });
    return ref;
  }

  read(ref: string): Buffer {
    const resolved = realpathSync(ref);
    const rel = relative(this.root, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("evidence ref escapes runner store");
    return readFileSync(resolved);
  }
}

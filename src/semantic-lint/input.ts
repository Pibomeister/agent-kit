/** Tracked working changes only. Exclusions are reported, never treated as reviewed. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { run } from "../learn/core/proc.ts";

export interface InputFile {
  path: string;
  content: string;
}

export interface HookInput {
  files: InputFile[];
  excluded: Array<{ path: string; reason: string }>;
  excludedOmitted?: number;
}

const EXCLUDED_PATH =
  /(?:^|\/)(?:\.[^/]+|node_modules|dist|provenance|research|fixtures?|vendor|coverage|logs?|private|secrets?)(?:\/|$)|(?:^|[/. _-])(?:credentials?|secrets?|tokens?|id_rsa|id_ed25519)(?:[/. _-]|$)|\.(?:env|pem|key|p12|pfx|lock)$/i;
const SECRET_CONTENT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[^A-Za-z0-9_$])["']?[A-Za-z0-9_$-]*(?:api[_-]?key|access[_-]?(?:token|key)|client[_-]?secret|secret|private[_-]?key|token|password|authorization)[A-Za-z0-9_$-]*["']?\s*[=:]\s*["']?[^\s"']{4,}|\b(?:sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16})|:\/\/[^/\s:@]+:[^/\s@]+@/i;
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|sh|md|txt|ya?ml|json|java|swift|kt|cs|c|h|cpp)$/i;

function binary(content: string): boolean {
  if (content.includes("\uFFFD")) return true;
  for (const character of content) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

export function collectInput(cwd: string): HookInput {
  const top = run(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 1_500 });
  if (top.code !== 0) throw new Error("repository");
  const root = realpathSync(top.stdout.trim());
  const changed = run(["git", "diff", "HEAD", "--name-only", "-z", "--diff-filter=ACMR", "--"], {
    cwd: root,
    timeoutMs: 1_500,
  });
  if (changed.code !== 0) throw new Error("repository");
  const input: HookInput = { files: [], excluded: [], excludedOmitted: 0 };
  let bytes = 0;
  let excludedBytes = 0;
  for (const path of changed.stdout.split("\0").filter(Boolean).toSorted()) {
    let reason: string | undefined;
    const absolute = resolve(root, path);
    if (EXCLUDED_PATH.test(path)) reason = "sensitive-path";
    else if (!TEXT_FILE.test(path)) reason = "unsupported";
    else {
      try {
        const stat = lstatSync(absolute);
        const rel = relative(root, realpathSync(absolute));
        if (stat.isSymbolicLink() || rel.startsWith("..") || isAbsolute(rel) || !stat.isFile()) reason = "symlink";
        else if (
          input.files.length >= 32 ||
          stat.size > 16_384 ||
          bytes + stat.size + Buffer.byteLength(path) + 64 > 49_152
        )
          reason = "size-limit";
        else {
          const content = readFileSync(join(root, path), "utf8");
          if (binary(content)) reason = "binary";
          else if (SECRET_CONTENT.test(content)) reason = "secret-content";
          else {
            input.files.push({ path, content });
            bytes += Buffer.byteLength(content) + Buffer.byteLength(path) + 64;
          }
        }
      } catch {
        reason = "unreadable";
      }
    }
    if (reason !== undefined) {
      const pathBytes = Buffer.byteLength(JSON.stringify(path));
      if (input.excluded.length < 128 && excludedBytes + pathBytes <= 8_192) {
        input.excluded.push({ path, reason });
        excludedBytes += pathBytes;
      } else input.excludedOmitted = (input.excludedOmitted ?? 0) + 1;
    }
  }
  return input;
}

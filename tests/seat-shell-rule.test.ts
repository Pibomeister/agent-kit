/**
 * The shell rule every dispatched seat and sub-agent is handed: deletes and container removals run as
 * standalone commands on literal scratch paths, or the container starts with `docker run --rm`, never
 * inside a compound command. An unattended host stops on the permission prompt a compound delete
 * raises, so a text that drops the rule stalls the seats that read it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const CARRIERS = [
  "skills/super-review/references/panel.md",
  "protocols/review-delta/PROTOCOL.md",
  "skills/doc-review/SKILL.md",
  "roles/implementer/ROLE.md",
  "roles/verifier/ROLE.md",
];

test.each(CARRIERS)("%s carries the shell rule", (path) => {
  const text = readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
  expect(text).toContain("`docker run --rm`");
  expect(text).toMatch(/literal (path|scratch path|name)/);
  expect(text).toContain("compound command");
});

test("super-review hands the panel's shell rule to every seat packet", () => {
  const text = readFileSync(join(ROOT, "skills/super-review/SKILL.md"), "utf8").replace(/\s+/g, " ");
  expect(text).toContain("Every packet carries the shell rule in `./references/panel.md`");
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { runValidation } from "../src/validation/run.ts";
import { skippedChecks } from "../src/validation/types.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const ROOT = join(import.meta.dir, "..");
const donorsRequired = process.env.AK_REQUIRE_DONORS === "1";
const donorsPresent = existsSync(join(ROOT, ".donors"));

type CiStep = { run?: string };
type CiWorkflow = { jobs?: { check?: { steps?: CiStep[] } } };

function isCiWorkflow(value: unknown): value is CiWorkflow {
  return value instanceof Object && !Array.isArray(value);
}

describe("receipt instruments place .donors by copy or clone, never symlink", () => {
  test("CI clones donors before it validates", () => {
    const document: unknown = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    expect(isCiWorkflow(document)).toBe(true);
    if (!isCiWorkflow(document)) return;
    const runs = (document.jobs?.check?.steps ?? []).map((step) => step.run);
    const clone = runs.indexOf("tools/donors/clone.sh");
    const validate = runs.indexOf("bun run validate");
    expect(clone).toBeGreaterThanOrEqual(0);
    expect(validate).toBeGreaterThan(clone);
  });

  test("validate-figure.sh and pre-push copy .donors and do not symlink them", () => {
    for (const rel of ["research/probes/validate-figure.sh", "tools/hooks/pre-push"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src).toMatch(/cp -R "[^"]*\.donors" "[^"]*\.donors"/);
      expect(src).not.toMatch(/ln -s[^\n]*\.donors/);
    }
  });

  test("a copied .donors is not the working tree after the working tree changes", () => {
    const scratch = processScratch("ak-receipt-donors-");
    const working = join(scratch, "working");
    const extract = join(scratch, "extract");
    mkdirSync(join(working, ".donors"), { recursive: true });
    mkdirSync(extract, { recursive: true });
    writeFileSync(join(working, ".donors", "marker"), "original\n");
    const copied = Bun.spawnSync(["cp", "-R", join(working, ".donors"), join(extract, ".donors")]);
    expect(copied.exitCode).toBe(0);
    writeFileSync(join(working, ".donors", "marker"), "changed\n");
    expect(readFileSync(join(extract, ".donors", "marker"), "utf8")).toBe("original\n");
  });
});

describe("provenance pin check skip count", () => {
  test.if(donorsPresent || donorsRequired)(
    "is 0 when .donors is present",
    () => {
      expect(existsSync(join(ROOT, ".donors"))).toBe(true);
      const result = runValidation(ROOT, { only: ["provenance"] });
      expect(result.issues.some((issue) => issue.rule === "provenance.donors-unavailable")).toBe(false);
      expect(skippedChecks(result.issues)).not.toContain("donor paths at pin");
    },
    120_000,
  );
});

import { expect, test } from "bun:test";

import { loadSkillManifest } from "../../src/packaging/manifest.ts";
import { REPO } from "./fixture.ts";

test("super-ship contract declares the no-mistakes handoff gate as an output", () => {
  const outputs = loadSkillManifest(REPO, "super-ship").raw["outputs"];
  expect(Array.isArray(outputs)).toBe(true);
  const ids = Array.isArray(outputs) ? outputs.map((output: { id?: unknown }) => output.id) : [];
  expect(ids).toContain("ship-preflight-gate");
  expect(ids).toContain("ship-evidence");
});

import { expect, test } from "bun:test";

import marketplace from "../.claude-plugin/marketplace.json" with { type: "json" };

test("GitHub plugin source uses anonymous HTTPS rather than SSH shorthand", () => {
  const source = marketplace.plugins.find((plugin) => plugin.name === "ak")?.source;
  expect(source?.source).toBe("git-subdir");
  expect(source?.url).toBe("https://github.com/Pibomeister/agent-kit.git");
  expect(source?.ref).toBe("published");
  expect(source?.path).toBe("dist/claude-code");
});

import { describe, expect, test } from "bun:test";

import { globToRegExp } from "../src/util/glob.ts";

describe("the shared glob matcher", () => {
  test("`**` matches a path that holds a newline", () => {
    expect(globToRegExp("src/core/**").test("src/core/a\nb.ts")).toBe(true);
    expect(globToRegExp("src/**/x.ts").test("src/a\nb/x.ts")).toBe(true);
    expect(globToRegExp("**/x.ts").test("a\nb/x.ts")).toBe(true);
  });

  test("`?` matches one character that is not a slash", () => {
    expect(globToRegExp("src/core?.ts").test("src/coreA.ts")).toBe(true);
    expect(globToRegExp("src/core?.ts").test("src/core/.ts")).toBe(false);
    expect(globToRegExp("src/core?.ts").test("src/core.ts")).toBe(false);
  });

  test("`*` stays inside one segment and `**/` may match no directory", () => {
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/**/b.ts").test("src/b.ts")).toBe(true);
    expect(globToRegExp("src/core/**").test("src/core/.hidden/a.ts")).toBe(true);
  });
});

/** Stdout that mixes a JSON-looking answer with a final VERDICT line. */
export const MIXED_JSON_PLUS_VERDICT: ReadonlyArray<readonly [string, string]> = [
  ["fenced", '```json\n{"choice":"REJECT","rationale":"x"}\n```\nVERDICT: WORTHY\n'],
  ["log line", '{"choice":"REJECT","rationale":"x"}\nseat finished\nVERDICT: WORTHY\n'],
  ["trailing comma", '{"choice":"REJECT","rationale":"x",}\nVERDICT: WORTHY\n'],
  ["truncated brace", '{"choice":"REJECT","rationale":"x"\nVERDICT: WORTHY\n'],
  ["NDJSON", '{"choice":"REJECT","rationale":"x"}\n{"choice":"WORTHY","rationale":"y"}\nVERDICT: WORTHY\n'],
  ["single quotes", "{'choice':'REJECT','rationale':'x'}\nVERDICT: WORTHY\n"],
  ["BOM", '\uFEFF{"choice":"REJECT","rationale":"x"}\nVERDICT: WORTHY\n'],
];

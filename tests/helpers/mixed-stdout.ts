const REJECT = '{"choice":"REJECT","rationale":"x"}';

/** Stdout that mixes a JSON-looking answer with a final VERDICT line. */
export const MIXED_JSON_PLUS_VERDICT: ReadonlyArray<readonly [string, string]> = [
  ["fenced", `\`\`\`json\n${REJECT}\n\`\`\`\nVERDICT: WORTHY\n`],
  ["log line", `${REJECT}\nseat finished\nVERDICT: WORTHY\n`],
  ["trailing comma", '{"choice":"REJECT","rationale":"x",}\nVERDICT: WORTHY\n'],
  ["truncated brace", '{"choice":"REJECT","rationale":"x"\nVERDICT: WORTHY\n'],
  ["NDJSON", `${REJECT}\n{"choice":"WORTHY","rationale":"y"}\nVERDICT: WORTHY\n`],
  ["single quotes", "{'choice':'REJECT','rationale':'x'}\nVERDICT: WORTHY\n"],
  ["BOM", `\uFEFF${REJECT}\nVERDICT: WORTHY\n`],
  ["prose prefix", `The seat answers ${REJECT}\nVERDICT: WORTHY\n`],
  ["INFO prefix", `INFO: ${REJECT}\nVERDICT: WORTHY\n`],
  ["timestamp prefix", `2026-11-25T13:00:00Z ${REJECT}\nVERDICT: WORTHY\n`],
  ["blockquote", `> ${REJECT}\nVERDICT: WORTHY\n`],
  ["list item", `- ${REJECT}\nVERDICT: WORTHY\n`],
  ["same-line fence", `note\n\`\`\`json ${REJECT}\nVERDICT: WORTHY\n`],
  ["CRLF", `INFO: ${REJECT}\r\nVERDICT: WORTHY\n`],
  ["ZWSP", `\u200B${REJECT}\nVERDICT: WORTHY\n`],
  ["ZWJ", `\u200D${REJECT}\nVERDICT: WORTHY\n`],
];

/** Remainder lines that look like JSON but are not an object or array. */
export const WORTHY_WITH_JSON_SCALAR: ReadonlyArray<readonly [string, string]> = [
  ["lone brace", "{\nVERDICT: WORTHY\n"],
  ["number", "42\nVERDICT: WORTHY\n"],
  ["true", "true\nVERDICT: WORTHY\n"],
  ["null", "null\nVERDICT: WORTHY\n"],
];

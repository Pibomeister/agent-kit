import { createInterface } from "node:readline";

interface StubReply {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: object;
  params?: object;
}

const send = (value: StubReply) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const id = /"id":(\d+)/.exec(line)?.[1];
  if (id === "1") send({ jsonrpc: "2.0", id: 1, result: { userAgent: "stub" } });
  if (id === "2")
    send({
      jsonrpc: "2.0",
      id: 2,
      result: { model: "model-under-test", thread: { id: "thread-stub" } },
    });
  if (id === "3") {
    send({
      jsonrpc: "2.0",
      id: 3,
      result: { turn: { id: "turn-stub", items: [], status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-other", turn: { id: "turn-other", items: [], status: "completed" } },
    });
    setTimeout(finishTurn, 50);
  }
});

function finishTurn() {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread-stub",
      item: {
        id: "change-stub",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "notes/new.md", kind: { type: "add" }, diff: "" },
          { path: "notes/kept.md", kind: { type: "update", move_path: null }, diff: "" },
          { path: "notes/old.md", kind: { type: "delete" }, diff: "" },
        ],
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: "thread-stub", item: { id: "item-stub", type: "agentMessage", text: "ok" } },
  });
  send({
    jsonrpc: "2.0",
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: {
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          totalTokens: 12,
        },
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread-stub", turn: { id: "turn-stub", items: [], status: "completed" } },
  });
}

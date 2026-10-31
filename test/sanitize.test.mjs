import { test } from "node:test";
import assert from "node:assert/strict";

import { rewriteChatBody, sanitizeChatRequest } from "../sanitize.mjs";
import { SenseNovaPlugin } from "../index.mjs";

test("developer 角色映射成 system", () => {
  const { body, changes } = sanitizeChatRequest({
    messages: [{ role: "developer", content: "be nice" }],
  });
  assert.deepEqual(body.messages, [{ role: "system", content: "be nice" }]);
  assert.deepEqual(changes, ["messages[0].role"]);
});

test("不带 tool_calls 的 assistant content:null 补成空串", () => {
  const { body } = sanitizeChatRequest({
    messages: [{ role: "assistant", content: null }],
  });
  assert.deepEqual(body.messages, [{ role: "assistant", content: "" }]);
});

test("带 tool_calls 的 assistant content:null 保持原样", () => {
  const message = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
  };
  const { body, changes } = sanitizeChatRequest({ messages: [message] });
  assert.deepEqual(body.messages, [message]);
  assert.equal(changes.length, 0);
});

test("tool / system 的空 content 补成空串", () => {
  const { body } = sanitizeChatRequest({
    messages: [
      { role: "tool", content: null, tool_call_id: "1" },
      { role: "system" },
    ],
  });
  assert.deepEqual(body.messages, [
    { role: "tool", content: "", tool_call_id: "1" },
    { role: "system", content: "" },
  ]);
});

test("content 为数字转成字符串", () => {
  const { body } = sanitizeChatRequest({ messages: [{ role: "user", content: 123 }] });
  assert.deepEqual(body.messages, [{ role: "user", content: "123" }]);
});

test("arguments 对象序列化成 JSON 字符串", () => {
  const { body } = sanitizeChatRequest({
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: { a: 1 } } }],
      },
    ],
  });
  assert.deepEqual(body.messages[0].tool_calls[0].function.arguments, '{"a":1}');
});

test("采样参数的数字字符串转成数字", () => {
  const { body } = sanitizeChatRequest({ temperature: "0.7", top_p: "0.9" });
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.9);
});

test("不支持的顶层字段被摘掉", () => {
  const { body, changes } = sanitizeChatRequest({
    logprobs: true,
    top_logprobs: 3,
    metadata: { x: 1 },
    messages: [],
  });
  assert.equal("logprobs" in body, false);
  assert.equal("top_logprobs" in body, false);
  assert.equal("metadata" in body, false);
  assert.deepEqual(changes, ["logprobs", "top_logprobs", "metadata"]);
});

test("reasoning_effort: off 翻成 none，minimal/max 是合法档位不动", () => {
  assert.equal(sanitizeChatRequest({ reasoning_effort: "off" }).body.reasoning_effort, "none");
  assert.equal(sanitizeChatRequest({ reasoning_effort: "max" }).body.reasoning_effort, "max");
  assert.equal(sanitizeChatRequest({ reasoning_effort: "minimal" }).body.reasoning_effort, "minimal");
  assert.equal("reasoning_effort" in sanitizeChatRequest({ reasoning_effort: "turbo" }).body, false);
});

test("干净的请求零改动", () => {
  const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.7 };
  const { body: next, changes } = sanitizeChatRequest(body);
  assert.deepEqual(next, body);
  assert.deepEqual(changes, []);
});

test("user 空 content 和越界数值刻意不代改", () => {
  const body = { messages: [{ role: "user", content: "" }], temperature: 3 };
  const { body: next, changes } = sanitizeChatRequest(body);
  assert.deepEqual(next, body);
  assert.deepEqual(changes, []);
});

test("rewriteChatBody：非 GET 的 JSON body 被改写", async () => {
  const input = new Request("https://token.sensenova.cn/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "developer", content: "hi" }] }),
  });
  const result = await rewriteChatBody(input, undefined, new Headers({ authorization: "Bearer x" }));
  assert.notEqual(result, null);
  assert.deepEqual(JSON.parse(await result.input.text()).messages, [
    { role: "system", content: "hi" },
  ]);
});

test("rewriteChatBody：GET 和非 JSON body 原样放行", async () => {
  assert.equal(await rewriteChatBody("https://x/v1/models", undefined, new Headers()), null);
  assert.equal(
    await rewriteChatBody("https://x/v1/chat/completions", { method: "POST", body: "not json" }, new Headers()),
    null,
  );
});

test("fetch 钩子端到端：body 被清洗后发出，干净 body 不动", async () => {
  async function through(key, input, init) {
    const plugin = await SenseNovaPlugin({}, {});
    const { fetch: wrapped } = await plugin.auth.loader(async () => ({ type: "api", key }));
    const real = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (a, b) => {
      const req = a instanceof Request ? a : null;
      seen = {
        url: req ? req.url : a,
        body: req ? await req.text() : typeof b?.body === "string" ? b.body : undefined,
      };
      return new Response("{}", { status: 200 });
    };
    try {
      await wrapped(input, init);
    } finally {
      globalThis.fetch = real;
    }
    return seen;
  }

  const url = "https://token.sensenova.cn/v1/chat/completions";
  const dirty = await through(
    "sk-test",
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "developer", content: "hi" }] }),
    },
  );
  assert.deepEqual(JSON.parse(dirty.body).messages, [{ role: "system", content: "hi" }]);

  const clean = await through(
    "sk-test",
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    },
  );
  assert.deepEqual(JSON.parse(clean.body).messages, [{ role: "user", content: "hi" }]);
});

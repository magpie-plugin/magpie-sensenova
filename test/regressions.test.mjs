import { test } from "node:test";
import assert from "node:assert/strict";

import { SenseNovaPlugin } from "../index.mjs";
import { normalizeModel, toConfigModel } from "../models.mjs";
import { rewriteChatBody } from "../sanitize.mjs";

const URL_ = "https://token.sensenova.cn/v1/chat/completions";

/** 跑一次 fetch 钩子，返回全局 fetch 收到的东西。 */
async function through(options, input, init) {
  const plugin = await SenseNovaPlugin({}, options);
  const { fetch: wrapped } = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (a, b) => {
    const req = a instanceof Request ? a : null;
    seen = {
      called: true,
      url: req ? req.url : a,
      headers: req ? req.headers : new Headers(b?.headers),
      body: req ? await req.text() : typeof b?.body === "string" ? b.body : undefined,
    };
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await wrapped(input, init);
    return { seen, result };
  } finally {
    globalThis.fetch = real;
  }
}

test("body 已被消费的 Request 不抛错，原样透传", async () => {
  // clone() 在 body 已读/锁定时抛 TypeError: unusable。以前这个异常会从
  // fetch 钩子冒出去，让一个本来能发的请求失败。
  const request = new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "developer", content: "hi" }] }),
  });
  await request.text(); // 模拟 host 已经读过 body
  assert.equal(await rewriteChatBody(request, undefined, new Headers()), null);

  const { seen } = await through({}, request, undefined);
  assert.equal(seen.called, true, "请求仍应发出");
  assert.equal(seen.headers.get("authorization"), "Bearer sk-test");
});

test("Request 自带的头不会被 init 的头整体覆盖", async () => {
  const request = new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "r-1" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const { seen } = await through({}, request, { headers: { "x-trace": "t-1" } });
  assert.equal(seen.headers.get("content-type"), "application/json", "Request 的 content-type 应保留");
  assert.equal(seen.headers.get("x-request-id"), "r-1", "Request 的其他头应保留");
  assert.equal(seen.headers.get("x-trace"), "t-1", "init 的头应叠加");
  assert.equal(seen.headers.get("authorization"), "Bearer sk-test");
});

test("tool_call 是对象时不吞掉工具能力", () => {
  // 以前 `raw.tool_call` 直接进 supportsTools，对象在 `=== true` 处判假，
  // 模型被声明成不支持工具，Agent 的工具调用静默失效。
  const withObject = normalizeModel({ id: "m", supported_features: ["tools"], tool_call: { supported: true } });
  assert.equal(withObject.supportsTools, true);
  assert.equal(toConfigModel(withObject).tool_call, true);

  const objectOnly = normalizeModel({ id: "m2", tool_call: { supported: true } });
  assert.equal(typeof objectOnly.supportsTools, "boolean");

  const explicitFalse = normalizeModel({ id: "m3", supports_tools: false, supported_features: ["tools"] });
  assert.equal(explicitFalse.supportsTools, false, "明确的布尔 false 仍应生效");
});

test("预限流排队超时回 503 + Retry-After，而不是无限等", async () => {
  // rpmLimit=1、窗口 10 秒、排队上限 50ms：第二个请求必然等不到空位。
  const plugin = await SenseNovaPlugin({}, { rpmLimit: 1, rpmWindowMs: 10_000, throttleMaxWaitMs: 50 });
  const { fetch: wrapped } = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const first = await wrapped(URL_, { method: "POST", body: "{}" });
    assert.equal(first.status, 200, "第一个请求正常放行");

    const started = Date.now();
    const second = await wrapped(URL_, { method: "POST", body: "{}" });
    const waited = Date.now() - started;
    assert.equal(second.status, 503);
    assert.ok(Number(second.headers.get("retry-after")) >= 1, "应带 Retry-After");
    assert.ok(waited < 2_000, `不该等到窗口结束（实测 ${waited}ms）`);
    assert.equal(calls, 1, "被限的请求不应打到上游");
  } finally {
    globalThis.fetch = real;
  }
});

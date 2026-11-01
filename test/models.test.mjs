import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeModelConfigs } from "../models.mjs";
import { SenseNovaPlugin } from "../index.mjs";

test("mergeModelConfigs：单字段覆盖只改该字段", () => {
  const defaults = {
    "m-a": { name: "A", reasoning: true, limit: { context: 100, output: 10 } },
    "m-b": { name: "B", reasoning: true },
  };
  const out = mergeModelConfigs(defaults, { "m-a": { reasoning: false } });
  assert.equal(out["m-a"].reasoning, false, "被覆盖的字段生效");
  assert.equal(out["m-a"].name, "A", "同模型其余字段保留");
  assert.deepEqual(out["m-a"].limit, { context: 100, output: 10 }, "limit 整体保留");
  assert.equal(out["m-b"].name, "B", "别的模型不受影响");
});

test("mergeModelConfigs：用户新增模型原样进入", () => {
  const out = mergeModelConfigs({ "m-a": { name: "A" } }, { "m-new": { name: "New" } });
  assert.deepEqual(out["m-new"], { name: "New" });
});

test("config 钩子：深合并后用户覆盖不再丢模型声明", async () => {
  const plugin = await SenseNovaPlugin({}, {});
  const cfg = { provider: { sensenova: { models: { "kimi-k3": { reasoning: false } } } } };
  await plugin.config(cfg);
  const entry = cfg.provider.sensenova.models["kimi-k3"];
  assert.equal(entry.reasoning, false, "用户覆盖的字段生效");
  assert.ok(entry.attachment !== undefined || entry.modalities, "快照里 kimi-k3 的其余声明保留");
  assert.equal(cfg.provider.sensenova.models["deepseek-flash"].name, "DeepSeek Flash", "别的模型不受影响");
});

test("protocol 选项切换 wire API 与 baseURL", async () => {
  for (const [protocol, npm, base] of [
    ["chat", "@ai-sdk/openai-compatible", "https://token.sensenova.cn/v1"],
    ["anthropic", "@ai-sdk/anthropic", "https://token.sensenova.cn"],
    ["responses", "@ai-sdk/openai", "https://token.sensenova.cn/v1"],
  ]) {
    const plugin = await SenseNovaPlugin({}, { protocol });
    const cfg = {};
    await plugin.config(cfg);
    const p = cfg.provider.sensenova;
    assert.equal(p.npm, npm, `${protocol} 的 SDK 包`);
    assert.equal(p.api, base, `${protocol} 的 baseURL`);
  }
});

test("未识别的 protocol 回落到 chat", async () => {
  const plugin = await SenseNovaPlugin({}, { protocol: "graphql" });
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider.sensenova.npm, "@ai-sdk/openai-compatible");
});

test("anthropic 协议下 chat 形状的 body 不被改写（发送原样）", async () => {
  const plugin = await SenseNovaPlugin({}, { protocol: "anthropic" });
  const { fetch: wrapped } = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  const real = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (a, b) => {
    const req = a instanceof Request ? a : null;
    sentBody = req ? await req.text() : b?.body;
    return new Response("{}", { status: 200 });
  };
  try {
    await wrapped("https://token.sensenova.cn/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 这在 chat 形状里是必改的（developer 角色）；anthropic 形状必须原样放行
      body: JSON.stringify({ messages: [{ role: "developer", content: "hi" }] }),
    });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sentBody, JSON.stringify({ messages: [{ role: "developer", content: "hi" }] }));
});

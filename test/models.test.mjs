import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeModelConfigs, effortVariants, toConfigModel, toProviderModel } from "../models.mjs";
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

test("chat 档位：官方 5 档映射 reasoningEffort，争议值不入列", () => {
  const v = effortVariants("chat");
  assert.deepEqual(Object.keys(v), ["none", "low", "medium", "high", "max"]);
  assert.deepEqual(v.none, { reasoningEffort: "none" });
  assert.deepEqual(v.high, { reasoningEffort: "high" });
});

test("anthropic 档位：none 关思考，其余走 output_config.effort", () => {
  const v = effortVariants("anthropic");
  assert.deepEqual(v.none, { thinking: { type: "disabled" } });
  assert.deepEqual(v.high, { thinking: { type: "enabled" }, output_config: { effort: "high" } });
  assert.deepEqual(Object.keys(v), ["none", "low", "medium", "high", "xhigh", "max"]);
});

test("responses 无档位（官方未提供推理控制）", () => {
  assert.equal(effortVariants("responses"), undefined);
});

test("模型条目带档位；reasoning: false 的模型不带", () => {
  const reasoning = { id: "m", name: "M", reasoning: true, supportsTools: true };
  assert.ok(toConfigModel(reasoning, "chat").variants);
  assert.deepEqual(toConfigModel(reasoning, "responses").variants, undefined);
  assert.deepEqual(toProviderModel(reasoning, "p", { protocol: "anthropic" }).variants.none, {
    thinking: { type: "disabled" },
  });

  const plain = { id: "p", name: "P", reasoning: false, supportsTools: true };
  assert.equal(toConfigModel(plain, "chat").variants, undefined);
  assert.deepEqual(toProviderModel(plain, "p", { protocol: "chat" }).variants, {});
});

test("config 钩子的模型声明按 protocol 带档位", async () => {
  const plugin = await SenseNovaPlugin({}, { protocol: "anthropic" });
  const cfg = {};
  await plugin.config(cfg);
  const entry = cfg.provider.sensenova.models["kimi-k3"];
  assert.deepEqual(entry.variants.none, { thinking: { type: "disabled" } });
});


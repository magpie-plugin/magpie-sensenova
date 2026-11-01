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

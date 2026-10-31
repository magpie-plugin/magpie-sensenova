import { test } from "node:test";
import assert from "node:assert/strict";

import { SenseNovaPlugin } from "../index.mjs";

/**
 * 依次跑 N 个请求，记录每个真正发出（全局 fetch 被调用）的时刻。
 */
async function sendTimes(options, count) {
  const plugin = await SenseNovaPlugin({}, options);
  const { fetch: wrapped } = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }));
  const real = globalThis.fetch;
  const at = [];
  globalThis.fetch = async () => {
    at.push(Date.now());
    return new Response("{}", { status: 200 });
  };
  try {
    for (let i = 0; i < count; i += 1) {
      await wrapped("https://token.sensenova.cn/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
    }
  } finally {
    globalThis.fetch = real;
  }
  return at;
}

test("RPM 预限流：窗口打满后，第 3 个请求被 hold 到第 1 个滑出窗口", async () => {
  const at = await sendTimes({ rpmLimit: 2, rpmWindowMs: 150 }, 3);
  assert.equal(at.length, 3);
  const gap1 = at[1] - at[0];
  const gap2 = at[2] - at[0];
  // at[i] 是全局 fetch 被调用的时刻，比节流器入窗晚几毫秒（隔了 readAuth 和
  // sanitize），阈值按窗口的 3/4 取，容忍这段偏移。
  assert.ok(gap1 < 100, `前两个应在窗口内立即发出，实测间隔 ${gap1}ms`);
  assert.ok(gap2 >= 110, `第三个应等第一个滑出 150ms 窗口，实测 ${gap2}ms`);
  assert.ok(gap2 < 500, `第三个不应等过头，实测 ${gap2}ms`);
});

test("rpmLimit: 0 关闭预限流", async () => {
  const at = await sendTimes({ rpmLimit: 0 }, 3);
  assert.equal(at.length, 3);
  assert.ok(at[2] - at[0] < 100, `全部应立即发出，实测总耗时 ${at[2] - at[0]}ms`);
});

test("默认 rpmLimit 生效（无 options 时也是 2）", async () => {
  const at = await sendTimes({ rpmWindowMs: 100 }, 3);
  assert.ok(at[2] - at[0] >= 70, `默认配置下第三个也应被预限流，实测 ${at[2] - at[0]}ms`);
});

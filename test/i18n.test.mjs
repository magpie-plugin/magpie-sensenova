import { test } from "node:test";
import assert from "node:assert/strict";

import { fill, poolLabel, resolveLocale, strings } from "../i18n.mjs";

test("显式 locale 胜过一切", () => {
  // 即便本机是中文，指定 en 也要给 en。
  assert.equal(resolveLocale("en", { LANG: "zh_CN.UTF-8" }, "zh-CN"), "en");
  assert.equal(resolveLocale("zh", { LANG: "en_US.UTF-8" }, "en-US"), "zh");
});

test("带地区的标签按前缀识别", () => {
  assert.equal(resolveLocale("zh-CN"), "zh");
  assert.equal(resolveLocale("zh-TW"), "zh");
  assert.equal(resolveLocale("en-US"), "en");
});

test("auto 跟机器的 Intl 走", () => {
  assert.equal(resolveLocale("auto", {}, "zh-CN"), "zh");
  assert.equal(resolveLocale("auto", {}, "en-GB"), "en");
});

test("Intl 没有结论时才看环境变量", () => {
  // 无 ICU 的 Node 上 Intl 会报自己的默认值，此时环境变量才是真信息。
  assert.equal(resolveLocale("auto", { LANG: "zh_CN.UTF-8" }, ""), "zh");
  assert.equal(resolveLocale("auto", { LANG: "en_US.UTF-8" }, ""), "en");
});

test("POSIX 的 C / POSIX 不被当成「不是中文所以英文」", () => {
  // 本机 LANG 就是 C.UTF-8；把它读成 en 会让中文用户看到英文。
  assert.equal(resolveLocale("auto", { LANG: "C.UTF-8" }, ""), "en", "跳过 C 之后没有可用信息，落到兜底 en");
  assert.equal(resolveLocale("auto", { LC_ALL: "C", LANG: "zh_CN.UTF-8" }, ""), "zh", "C 被跳过，继续看 LANG");
  assert.equal(resolveLocale("auto", { LANG: "POSIX" }, ""), "en");
});

test("LC_ALL 优先于 LANG", () => {
  assert.equal(resolveLocale("auto", { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, ""), "zh");
});

test("两份字符串表的关键字对称", () => {
  const zh = strings("zh");
  const en = strings("en");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "漏翻一条会在这里露出来");
  assert.equal(en.locale, "en");
  assert.equal(en.unit, "credits");
  assert.equal(zh.unit, "积分");
});

test("未知 locale 退回中文表，而不是空对象", () => {
  assert.equal(strings("fr").locale, "zh");
});

test("通用池的标签由插件决定，不套专属池的命名规则", () => {
  // 回归：接口返回的通用池名就是「通用积分池」，套上「积分池 → Dedicated Pool」
  // 的规则会得到「通用 Dedicated Pool」这种胡话。
  const en = strings("en");
  assert.equal(poolLabel("通用积分池", en, false), "General Pool");
  assert.equal(poolLabel("通用积分池", strings("zh"), false), "通用积分池");
});

test("专属池按控制台自己的叫法翻译", () => {
  const en = strings("en");
  assert.equal(poolLabel("Flash-Lite积分池", en, true), "Flash-Lite Dedicated Pool");
  assert.equal(poolLabel("Flash-Lite积分池", strings("zh"), true), "Flash-Lite积分池");
});

test("对不上的池名原样透传，不硬改", () => {
  const en = strings("en");
  assert.equal(poolLabel("Something Else", en, true), "Something Else");
});

test("池名缺失时退回通用叫法", () => {
  assert.equal(poolLabel(undefined, strings("en"), true), "Dedicated Pool");
  assert.equal(poolLabel("", strings("en"), true), "Dedicated Pool");
  assert.equal(poolLabel(undefined, strings("en"), false), "General Pool");
  assert.equal(poolLabel("  ", strings("zh"), true), "专属积分池");
});

test("fill 替换已知占位符，未知的原样留着", () => {
  assert.equal(fill("HTTP {status}", { status: 404 }), "HTTP 404");
  assert.equal(fill("bad {nope}", { status: 404 }), "bad {nope}", "宁可露出占位符，也不要 undefined");
});

test("带「专属」的池名也翻干净，不留双空格", () => {
  // 接口在不同响应里给过 "Flash-Lite积分池" 和 "Flash-Lite 专属积分池" 两种。
  const en = strings("en");
  assert.equal(poolLabel("Flash-Lite 专属积分池", en, true), "Flash-Lite Dedicated Pool");
  assert.equal(poolLabel("Flash-Lite积分池", en, true), "Flash-Lite Dedicated Pool");
});

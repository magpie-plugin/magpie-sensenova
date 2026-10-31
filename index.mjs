/**
 * SenseNova (商量 / 日日新) provider plugin for Magpie.
 *
 * Two things in one package, because the platform splits them across two hosts:
 *
 *   - **The provider.** Token Plan speaks the OpenAI dialect at
 *     `https://token.sensenova.cn/v1`, so serving requests is the ordinary
 *     `@ai-sdk/openai-compatible` path and the `fetch` hook forwards untouched.
 *
 *   - **The quota.** The 积分额度 that the console shows lives on a different
 *     API entirely — `platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`
 *     — behind an OAuth bearer token, not an API key. No API-key-accessible
 *     quota endpoint exists on this platform, so the two credentials are
 *     genuinely separate and both are collected at sign-in.
 *
 * The quota is reported through `auth.usage`, which is the only channel Magpie
 * offers: plugins cannot add panels or pages, and nothing feeds the 用量概览
 * analytics page. What `auth.usage` returns is rendered on the provider's
 * account row, in `magpie quota`, and at the gateway's `GET /v1/magpie/quotas`.
 *
 * This file exports **exactly one function, and nothing else**, so the module
 * also loads under OpenCode, which refuses an entry exporting any non-function
 * value. Helpers live in `internal.mjs`, `quota.mjs` and `models.mjs`.
 *
 * @module magpie-sensenova
 */

import { PROVIDER, ICON, apiKeyOf, consoleAuthOf, fellBack, readAuth } from "./internal.mjs";
import { FALLBACK_MODELS, NPM, createCatalog, toConfigModel, toProviderModel } from "./models.mjs";
import {
  accountNameOf,
  credentialSlotOf,
  isLegacyCredentials,
  QuotaError,
  readAccountCredentials,
  readCredentials,
  readQuota,
  writeAccountCredentials,
  writeCredentials,
} from "./quota.mjs";
import { fill, resolveLocale, strings as tableFor } from "./i18n.mjs";
import { rewriteChatBody } from "./sanitize.mjs";

const DEFAULT_QUOTA_TTL_MS = 60_000;
/** 商换单把 Key 的 RPM 上限很低（实测约 3），默认按 2 预限流留出余量。 */
const DEFAULT_RPM_LIMIT = 2;
const RPM_WINDOW_MS = 60_000;

/**
 * Build the plugin.
 *
 * @param {{client?: object}} input - the plugin input the host passes.
 * @param {object} [options] - the `options` field from `plugins.json`.
 * @returns {Promise<object>} the hooks the host calls.
 */
export async function SenseNovaPlugin({ client } = {}, options = {}) {
  const locale = resolveLocale(options.locale);
  const t = tableFor(locale);
  const opts = {
    baseURL: options.baseURL ?? undefined,
    quotaTtlMs: Number(options.quotaTtlMs) > 0 ? Number(options.quotaTtlMs) : DEFAULT_QUOTA_TTL_MS,
    scopeModel: typeof options.scopeModel === "string" ? options.scopeModel : "flash-lite",
    credentialsFile: options.credentialsFile ?? undefined,
    // `0` 关闭预限流。rpmWindowMs 是测试接缝，生产恒为 60 秒。
    rpmLimit: Number(options.rpmLimit ?? DEFAULT_RPM_LIMIT) || 0,
    rpmWindowMs: Number(options.rpmWindowMs) > 0 ? Number(options.rpmWindowMs) : RPM_WINDOW_MS,
  };
  const catalog = createCatalog({ baseURL: opts.baseURL });

  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: "sensenova", level, message } });
    } catch {
      /* the host's logger is best-effort */
    }
  };

  const seedModels = () => catalog.peek() ?? FALLBACK_MODELS;
  const modelsAsConfig = (models) =>
    Object.fromEntries(models.map((m) => [m.id, toConfigModel(m)]));

  /**
   * The credentials for one account.
   *
   * Console tokens are per account, not per machine: quota is account-level, and one
   * token belongs to one console account. They therefore live in that account's own
   * slot of the shared file (see `readAccountCredentials`), and only the token's own
   * account may read the CLI's single-account top-level record. Handing the top-level
   * token to every account is what made several account rows show one and the same
   * quota — the last account to sign in won, and `ensureToken` then short-circuited on
   * its unexpired token instead of ever signing in as anyone else.
   *
   * The account and password still come from the sign-in prompts when supplied, and
   * otherwise from the shared file, which is the single-account arrangement the CLI
   * drives. `base` / `client_id` / `redirect_uri` stay file-level: they identify the
   * deployment, not the account.
   */
  const credentialsFor = (auth, slot, file = readCredentials(opts.credentialsFile) ?? {}) => {
    const fromAuth = consoleAuthOf(auth);
    const own = readAccountCredentials(file, slot);
    return {
      base: own.base ?? file.base,
      client_id: own.client_id ?? file.client_id,
      redirect_uri: own.redirect_uri ?? file.redirect_uri,
      // Not `file.access_token`: that is the CLI's account, possibly somebody else's.
      access_token: own.access_token,
      refresh_token: own.refresh_token,
      expires_at: own.expires_at,
      id_token: own.id_token,
      cookie: fromAuth.cookie ?? own.cookie,
      username: fromAuth.username ?? own.username ?? file.username,
      password: fromAuth.password ?? own.password ?? file.password,
      iam_base: fromAuth.iamBase ?? own.iam_base ?? file.iam_base,
      __slot: slot,
      // A renewal goes into the slot, and additionally back into the CLI's record when
      // that record is the one this account has been reading, so the CLI's copy does
      // not go stale for the single-account case.
      __legacy: isLegacyCredentials(file, slot),
      __file: opts.credentialsFile,
    };
  };

  /**
   * Which slot an account's tokens belong in.
   *
   * The typed account names the slot. With none typed, the name carried by the file's
   * single-account token is adopted instead — that keeps "leave the account fields
   * blank and use what the `snquota` CLI stored" working, which is the common setup,
   * while still refusing to hand one account's token to another: the moment a second
   * account names itself, it gets its own slot and stops borrowing.
   */
  const slotOf = (auth, file) =>
    credentialSlotOf({
      name: consoleAuthOf(auth).username ?? accountNameOf(file),
      key: apiKeyOf(auth),
    });

  /** Cache quota per account so a polled hook costs one request a minute. */
  const quotaCache = new Map();

  /**
   * What Magpie puts on the account row.
   *
   * Magpie shows `user` when the hook supplies it and falls back to labelling the
   * account by its API key when it does not. The console tokens carry the
   * account's own display name, which is the name the console's header shows and
   * therefore the one a user recognises; the account typed at sign-in is a phone
   * number or an email, which is what the user logged in with rather than who
   * they are. So the token's name wins, the typed account is the fallback, and
   * only when neither exists does Magpie fall back to the API key.
   */
  const accountLabel = (cfg) => accountNameOf(cfg) ?? cfg.username;

  const quotaFor = async (getAuth) => {
    const auth = await readAuth(getAuth);
    const file = readCredentials(opts.credentialsFile) ?? {};
    // The slot is part of the cache key: two sign-ins can share one API key while
    // naming different accounts, and keying on the key alone would let the second row
    // read the first row's figures.
    const slot = slotOf(auth, file);
    const cacheKey = `${apiKeyOf(auth) ?? ""}\u0000${slot ?? ""}`;
    const hit = quotaCache.get(cacheKey);
    if (hit && Date.now() - hit.at < opts.quotaTtlMs) return hit.value;

    const cfg = credentialsFor(auth, slot, file);
    if (!cfg.access_token && !cfg.refresh_token && !cfg.cookie && !cfg.password) {
      const value = { error: t.noAccount };
      quotaCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }

    try {
      const { quota, changed } = await readQuota(cfg, { scopeModel: opts.scopeModel, strings: t });
      if (changed) {
        // Its own slot always; the CLI's top-level record as well only when that was
        // the record this account read from.
        writeAccountCredentials(cfg, slot, cfg.__file);
        if (cfg.__legacy) writeCredentials(cfg, cfg.__file);
      }
      // 套餐名用接口给的（实际是 "Free Plan"），拿不到才退回通用叫法。
      const { plan, ...rest } = quota;
      const user = accountLabel(cfg);
      const value = {
        plan: plan ?? t.planFallback,
        ...(user ? { user } : {}),
        ...rest,
      };
      quotaCache.set(cacheKey, { at: Date.now(), value });
      return value;
    } catch (error) {
      // A failed read must not be cached for the full TTL: the next poll is
      // exactly when a token that just expired should be retried.
      const user = accountLabel(cfg);
      const value = {
        plan: t.planFallback,
        ...(user ? { user } : {}),
        error: error instanceof QuotaError ? error.message : fill(t.readFailed, { detail: error.message }),
      };
      quotaCache.set(cacheKey, { at: Date.now() - opts.quotaTtlMs + 15_000, value });
      log("warn", `sensenova: quota read failed: ${error.message}`);
      return value;
    }
  };

  return {
    /** Declare the provider and its models. */
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: "SenseNova",
        npm: NPM,
        api: opts.baseURL ?? "https://token.sensenova.cn/v1",
        ...was,
        models: { ...modelsAsConfig(seedModels()), ...(was.models ?? {}) },
      };
    },

    provider: {
      id: PROVIDER,
      /**
       * The models this account can actually use.
       *
       * Returning the declared list unchanged on failure keeps the provider
       * usable: Magpie marks it as fallen back rather than letting it vanish.
       */
      async models(provider, { auth } = {}) {
        const id = provider?.id ?? PROVIDER;
        const declared = provider?.models ?? modelsAsConfig(seedModels());
        const key = apiKeyOf(auth);
        if (!key) return fellBack(declared);
        try {
          const live = await catalog.load(key);
          if (!live.length) return fellBack(declared);
          return Object.fromEntries(
            live.map((m) => [
              m.id,
              toProviderModel(m, id, { baseURL: opts.baseURL ?? catalog.baseURL }),
            ])
          );
        } catch (error) {
          log("warn", `sensenova: keeping the known model list: ${error.message}`);
          return fellBack(declared);
        }
      },
    },

    auth: {
      provider: PROVIDER,
      ...(ICON === undefined ? {} : { icon: ICON }),

      /**
       * The account, resolved into request routing.
       *
       * The body is not forwarded blindly: the Token Plan gateway's schema
       * validation rejects several legal OpenAI shapes (`developer` role,
       * null content, object `tool_calls` arguments, …), so those get the
       * semantically equivalent rewrite from `sanitize.mjs` first. Everything
       * else — GETs, non-JSON bodies, already-clean requests — passes as sent.
       */
      async loader(getAuth) {
        const key = apiKeyOf(await readAuth(getAuth));
        // 本账号在当前窗口内的发送时刻。loader 每账号各跑一次，闭包就是天然的按账号状态。
        let sent = [];
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        /**
         * 本地 RPM 预限流：窗口打满就把请求 hold 到最早一次发送滑出窗口再发。
         * Magpie 的 Failover 是被动的（429 发生后才让账号退避），这里是主动排队，
         * 配合多账号「轮流」路由把每把 Key 压在 RPM 红线内，让 429 基本不发生。
         */
        const throttle = async () => {
          if (!opts.rpmLimit) return;
          for (;;) {
            const now = Date.now();
            sent = sent.filter((at) => now - at < opts.rpmWindowMs);
            if (sent.length < opts.rpmLimit) {
              sent.push(now);
              return;
            }
            await wait(sent[0] + opts.rpmWindowMs - now);
          }
        };
        return {
          baseURL: opts.baseURL ?? "https://token.sensenova.cn/v1",
          apiKey: key,
          async fetch(input, init) {
            await throttle();
            // Re-read per request so a sign-in that changes mid-session is
            // picked up without waiting for the loader to re-run.
            const current = apiKeyOf(await readAuth(getAuth));
            const source = input instanceof Request ? input : null;
            const headers = new Headers(init?.headers ?? source?.headers);
            if (current === undefined) headers.delete("authorization");
            else headers.set("authorization", `Bearer ${current}`);
            const clean = await rewriteChatBody(input, init, headers);
            if (clean) {
              log("info", `sensenova: rewrote ${clean.changes.join(", ")} for the gateway`);
              return fetch(clean.input, clean.init);
            }
            // A Request carries its own body, and re-issuing one by URL alone
            // silently drops it — so clone it instead of rebuilding the call.
            if (source) return fetch(new Request(source, { ...init, headers }));
            return fetch(input, { ...init, headers });
          },
        };
      },

      /**
       * The 积分额度, as the provider card shows it.
       *
       * SenseNova's pools map onto Magpie's window model directly: the 5-hour
       * window is 18000 seconds, the weekly one 604800, and the Flash-Lite pool
       * is scoped to its own model family. The 活动固定积分 balance has no
       * window, so it is reported as `balance`.
       */
      async usage(getAuth) {
        return quotaFor(getAuth);
      },

      /**
       * One method: an API key, plus the console account that can read quota.
       *
       * The console fields are optional and only asked for once, at sign-in,
       * because the quota endpoint has no API-key path. Leaving them blank
       * falls back to whatever `snquota` already stored on this machine.
       */
      methods: [
        {
          type: "api",
          label: t.methodLabel,
          // The key question is Magpie's own: for an `api` method it asks for the
          // credential itself and stores it, which is why the community plugins
          // declare only their extra fields here. Declaring a `key` prompt as
          // well asks the user for the same secret twice — reported by a user,
          // and the reason a sign-in here wanted one more line of input than
          // this array has entries.
          placeholder: "sk-…",
          prompts: [
            {
              type: "text",
              // `email` rather than `username`: Magpie names an account from
              // `accountId`, then `metadata.email`, then `email`, and only
              // otherwise labels it by the credential. A prompt's key is what
              // lands in `metadata`, so naming the field `email` is what makes
              // the account row read as the account instead of "API key …HohJ".
              // Reading it back is `consoleAuthOf`'s job.
              key: "email",
              message: t.promptAccount,
              placeholder: t.placeholderAccount,
            },
            {
              type: "text",
              key: "password",
              message: t.promptPassword,
              placeholder: t.placeholderPassword,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Request-body sanitisation: rewrite "legal OpenAI, rejected by SenseNova"
 * shapes into semantically equivalent shapes the gateway accepts.
 *
 * Why this layer exists
 * ---------------------
 * The Token Plan gateway's schema validation is much stricter than OpenAI's,
 * and shapes that every OpenAI-spec client may legitimately emit get a 400.
 * The catalogue below is measured against the real upstream (2026-10-30, on
 * `deepseek-v4-flash`, by the dsh-sensenova-pool project — the same gateway
 * serves both harnesses):
 *
 *   {"role":"developer","content":"…"}          ← OpenAI's new system role; only `system` is accepted
 *   {"role":"assistant","content":null}         ← without tool_calls
 *   {"role":"assistant"}                        ← field missing entirely
 *   {"role":"system"|"tool","content":null}     ← empty tool result
 *   "arguments": {"a":1}                        ← must be a JSON *string*
 *   "content": 123                              ← string or array only
 *   "temperature": "0.7"                        ← numbers only
 *   "logprobs" / "top_logprobs" / "metadata"    ← not supported
 *   "reasoning_effort": "off"                   ← SenseNova spells it `none`
 *
 * Every rewrite is semantically equivalent — the request's intent is untouched.
 * Three things are deliberately NOT rewritten (rewriting them only pushes the
 * error further away, or alters what the caller asked for): empty user
 * content, out-of-range numbers, and unknown roles.
 *
 * @module magpie-sensenova/sanitize
 */

/** Role names the gateway does not know, mapped to their equivalent. */
const ROLE_ALIASES = { developer: "system" };

/** Roles whose `content` may be absent/null; the gateway wants an empty string. */
const NULLABLE_CONTENT_ROLES = new Set(["assistant", "system", "tool"]);

/** Top-level fields the gateway rejects outright. */
const UNSUPPORTED_FIELDS = ["logprobs", "top_logprobs", "metadata"];

/** Sampling parameters that must be numbers, not numeric strings. */
const NUMERIC_PARAMS = ["temperature", "top_p", "frequency_penalty", "presence_penalty"];

/**
 * `reasoning_effort` values the gateway accepts. `minimal` and `max` are legal
 * grades — mapping them away would silently change the requested reasoning
 * strength. The only translation needed is `off` → `none`.
 */
const REASONING_EFFORT_ALLOWED = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const REASONING_EFFORT_ALIASES = { off: "none" };

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The body of a Request, or undefined when it cannot be read.
 *
 * `clone()` throws on a body that is already consumed or locked — a condition
 * this hook must survive, since the only sane answer then is to forward the
 * call untouched rather than fail a request the host could have sent.
 */
async function readSourceBody(source) {
  try {
    return await source.clone().text();
  } catch {
    return undefined;
  }
}

/** Null/missing content for the nullable roles; unchanged otherwise. */
function normalizeContent(message) {
  if ("content" in message && message.content !== null && message.content !== undefined) {
    if (typeof message.content === "string" || Array.isArray(message.content)) return undefined;
    if (typeof message.content === "number" || typeof message.content === "boolean") {
      return { ...message, content: String(message.content) };
    }
    return undefined;
  }
  // assistant carrying tool_calls may keep content:null — the gateway accepts it.
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return undefined;
  }
  if (typeof message.role === "string" && NULLABLE_CONTENT_ROLES.has(message.role)) {
    return { ...message, content: "" };
  }
  return undefined;
}

function normalizeRole(message) {
  if (typeof message.role !== "string") return undefined;
  const mapped = ROLE_ALIASES[message.role.trim().toLowerCase()];
  if (mapped === undefined || mapped === message.role) return undefined;
  return { ...message, role: mapped };
}

/** `tool_calls[*].function.arguments` must be a JSON string, never an object. */
function normalizeToolCalls(message) {
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  let changed = false;
  const next = calls.map((call) => {
    if (!isRecord(call) || !isRecord(call.function)) return call;
    if (typeof call.function.arguments === "string") return call;
    changed = true;
    return {
      ...call,
      function: { ...call.function, arguments: JSON.stringify(call.function.arguments ?? {}) },
    };
  });
  return changed ? { ...message, tool_calls: next } : undefined;
}

function sanitizeMessages(messages, changes) {
  if (!Array.isArray(messages)) return messages;
  const steps = [
    ["role", normalizeRole],
    ["content", normalizeContent],
    ["arguments", normalizeToolCalls],
  ];
  return messages.map((message, index) => {
    if (!isRecord(message)) return message;
    let current = message;
    for (const [label, step] of steps) {
      const result = step(current);
      if (result !== undefined) {
        current = result;
        changes.push(`messages[${index}].${label}`);
      }
    }
    return current;
  });
}

/** Unknown values are dropped rather than guessed — a 400 is worse than no effort. */
function sanitizeReasoningEffort(body, changes) {
  if (!("reasoning_effort" in body)) return;
  const raw = body.reasoning_effort;
  if (typeof raw !== "string") {
    delete body.reasoning_effort;
    changes.push("reasoning_effort");
    return;
  }
  const lowered = raw.trim().toLowerCase();
  if (REASONING_EFFORT_ALLOWED.has(lowered)) {
    if (lowered !== raw) {
      body.reasoning_effort = lowered;
      changes.push("reasoning_effort");
    }
    return;
  }
  const mapped = REASONING_EFFORT_ALIASES[lowered];
  delete body.reasoning_effort;
  if (mapped !== undefined) body.reasoning_effort = mapped;
  changes.push("reasoning_effort");
}

/**
 * Sanitize one OpenAI chat request body, semantically equivalently.
 *
 * @param {unknown} input - the parsed request body.
 * @returns {{body: unknown, changes: string[]}} `changes` names every rewrite,
 *   so callers can log what was touched; empty means the body passed as-is.
 */
export function sanitizeChatRequest(input) {
  const changes = [];
  if (!isRecord(input)) return { body: input, changes };
  const body = { ...input };
  for (const field of UNSUPPORTED_FIELDS) {
    if (field in body) {
      delete body[field];
      changes.push(field);
    }
  }
  for (const field of NUMERIC_PARAMS) {
    if (typeof body[field] === "string") {
      const parsed = Number(body[field]);
      if (Number.isFinite(parsed)) {
        body[field] = parsed;
        changes.push(field);
      }
    }
  }
  sanitizeReasoningEffort(body, changes);
  if ("messages" in body) body.messages = sanitizeMessages(body.messages, changes);
  return { body, changes };
}

/**
 * Rewrite the body of a fetch call when it is a chat request needing repairs.
 *
 * Reads the body only to validate and rewrite it in memory; nothing is stored
 * or logged beyond the names of the fields that changed. Returns null when the
 * call should go out exactly as it arrived.
 *
 * @param {Request|string|URL} input
 * @param {RequestInit} [init]
 * @param {Headers} [headers] - already-merged headers to send with.
 * @returns {Promise<null|{input: Request|string|URL, init: RequestInit, changes: string[]}>}
 */
export async function rewriteChatBody(input, init, headers) {
  const source = input instanceof Request ? input : null;
  const method = String(init?.method ?? source?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const raw =
    init?.body !== undefined && init.body !== null
      ? init.body
      : source?.body
        ? await readSourceBody(source)
        : undefined;
  if (typeof raw !== "string" || !raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const { body, changes } = sanitizeChatRequest(parsed);
  if (!changes.length) return null;
  const payload = JSON.stringify(body);
  if (source) return { input: new Request(source, { ...init, headers, body: payload }), init: {}, changes };
  return { input, init: { ...init, headers, body: payload }, changes };
}

// src/index.ts
import { join as join3 } from "node:path";
import { homedir } from "node:os";

// src/adapter/auth.ts
import { createHash as createHash2, randomBytes as randomBytes2, randomUUID as randomUUID2 } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/adapter/cosy.ts
import {
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  randomUUID,
  constants
} from "node:crypto";
import { hostname, platform, arch } from "node:os";
var QWENWORK_RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
var QWENWORK_APP = { version: "1.2.1", release: "1.2.1-26092107" };
var QWENWORK_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
var COSY_VERSION = "1.1.59";
function userBlob(account) {
  const raw = JSON.stringify({
    uid: account.uid,
    aid: "",
    name: account.name ?? "",
    email: account.email ?? "",
    security_oauth_token: account.access
  });
  const key = Buffer.from(randomBytes(8).toString("hex").slice(0, 16));
  const cipher = createCipheriv("aes-128-cbc", key, key);
  const info = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]).toString("base64");
  const wrapped = publicEncrypt({ key: QWENWORK_RSA_KEY, padding: constants.RSA_PKCS1_PADDING }, key).toString("base64");
  return { info, key: wrapped };
}
function machineOS(a = arch(), p = platform()) {
  const renamed = { x64: "x86_64", arm64: "aarch64" }[a] ?? a;
  return `${renamed}_${p}`;
}
function machineHostname(name2 = hostname()) {
  const trimmed = String(name2 ?? "").trim();
  if (trimmed === "") return "";
  const CAP = 96;
  const hash = (v) => createHash("sha256").update(v, "utf8").digest("hex").slice(0, 8);
  const cap = (v) => {
    if (v.length <= CAP) return v;
    const head = v.slice(0, CAP - 8 - 1).replace(/[-\s]+$/u, "");
    return head ? `${head}-${hash(v)}` : `unknown-${hash(v)}`;
  };
  const HOST_SAFE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u;
  if (HOST_SAFE.test(trimmed)) return cap(trimmed);
  try {
    const ascii = new URL(`http://${trimmed}`).hostname;
    if (ascii !== "" && HOST_SAFE.test(ascii)) return cap(ascii);
  } catch {
  }
  const safe = trimmed.replace(/[^\x21-\x7e]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return cap(safe ? `${safe}-${hash(trimmed)}` : `unknown-${hash(trimmed)}`);
}
function cosyHeaders(url, account, body, ts = Math.floor(Date.now() / 1e3)) {
  if (!account.machineId) throw new Error("qwenwork: \u8D26\u53F7\u7F3A\u5C11 machineId\uFF0C\u9700\u8981\u91CD\u65B0\u767B\u5F55");
  const blob = userBlob(account);
  const payload = Buffer.from(
    JSON.stringify({
      version: "v1",
      requestId: randomUUID(),
      info: blob.info,
      cosyVersion: COSY_VERSION,
      ideVersion: ""
    })
  ).toString("base64");
  let path = new URL(url).pathname;
  if (path.startsWith("/algo")) path = path.slice(5);
  const sig = createHash("md5").update(`${payload}
${blob.key}
${ts}
${body}
${path}`).digest("hex");
  const m = account.machineId;
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Business-Product": "qoder_work",
    "Cosy-Business-Type": "agent",
    "Cosy-ClientIp": m,
    "Cosy-ClientType": "6",
    "Cosy-Data-Policy": "disagree",
    "Cosy-Date": String(ts),
    "Cosy-Key": blob.key,
    "Cosy-MachineId": m,
    "Cosy-MachineToken": m,
    "Cosy-MachineType": "5",
    "Cosy-MachineOS": machineOS(),
    "Cosy-Scene": "qwork",
    "Cosy-User": account.uid,
    "Cosy-Version": COSY_VERSION,
    "Login-Version": "v2"
  };
}
function chatHeaders(url, account, body, modelKey, source = "system") {
  const h = cosyHeaders(url, account, body);
  delete h["Cosy-ClientIp"];
  delete h["Cosy-MachineToken"];
  delete h["Cosy-MachineType"];
  const host = machineHostname();
  if (host) h["Cosy-MachineHostname"] = host;
  return {
    ...h,
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Model-Key": modelKey,
    "X-Model-Source": source
  };
}
function clientHeaders() {
  const { version, release } = QWENWORK_APP;
  return {
    "User-Agent": `qoderwork/${version}`,
    "X-Request-Id": randomUUID(),
    "X-QwenWork-Version": version,
    "X-QwenWork-Release-Version": release,
    "X-QwenWork-Build": release.split("-")[1] ?? "",
    "X-QwenWork-Platform": platform(),
    "X-QwenWork-Arch": arch(),
    "X-QwenWork-Channel": "stable"
  };
}
function newMachineId() {
  return randomUUID();
}

// src/adapter/auth.ts
var GATEWAY = "https://gateway.qwenwork.cn";
var WEB = "https://gateway.qwenwork.cn";
var REDIRECT = "qwenwork-cn://";
var SIGN_IN_TIMEOUT = 15 * 60 * 1e3;
var DEFAULT_POLL_INTERVAL = 2e3;
var b64url = (buf) => buf.toString("base64url");
function startDeviceSignIn(gateway = GATEWAY, pollInterval = DEFAULT_POLL_INTERVAL) {
  const verifier = b64url(randomBytes2(64));
  const challenge = b64url(createHash2("sha256").update(verifier).digest());
  const nonce = randomUUID2();
  const machineId = newMachineId();
  const q = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: machineId,
    client_id: QWENWORK_CLIENT_ID,
    redirect_uri: REDIRECT
  });
  const until = Date.now() + SIGN_IN_TIMEOUT;
  return {
    url: `${WEB}/device/selectAccounts?${q}`,
    instructions: "\u5728\u6D4F\u89C8\u5668\u91CC\u767B\u5F55\u5343\u95EE\u529E\u516C\u5E76\u6388\u6743\u672C\u8BBE\u5907",
    async wait() {
      let device = null;
      let lastError = "";
      while (device === null) {
        if (Date.now() > until) {
          throw new Error(`qwenwork: \u767B\u5F55\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB${lastError ? `\uFF08\u6700\u540E\u9519\u8BEF\uFF1A${lastError}\uFF09` : ""}`);
        }
        try {
          const r = await openapi(gateway, "/api/v1/deviceToken/poll", {
            query: { nonce, verifier, challenge_method: "S256" }
          });
          const body = r.json;
          if (r.status === 200 && String(body?.token ?? "").trim() !== "") {
            device = body;
            break;
          }
          const errorCode = String(body?.errorCode ?? "");
          if (errorCode === "INVALID_DEVICE_FLOW" || errorCode === "EXPIRED" || errorCode === "DENIED") {
            const said = String(body?.errorMessage ?? r.text).slice(0, 200);
            throw new Error(`qwenwork: \u8BBE\u5907\u6D41\u65E0\u6548\uFF08${errorCode}\uFF09\uFF1A${said}`);
          }
          if (r.status === 403) {
            throw new Error(`qwenwork: \u6388\u6743\u88AB\u62D2\u7EDD\uFF08HTTP 403\uFF09\uFF1A${r.text.trim().slice(0, 200)}`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("qwenwork:")) throw error;
          lastError = error instanceof Error ? error.message : String(error);
        }
        await sleep(pollInterval);
      }
      const token = String(device.token).trim();
      let uid = String(device.user_id ?? "").trim();
      let email = "";
      let name2 = String(device.user_name ?? "");
      let plan;
      let balance;
      let quota;
      let renewsAt;
      let period;
      try {
        const ctx = await readAccountContext(gateway, token);
        uid = ctx.uid || uid;
        email = ctx.email;
        name2 = ctx.name || name2;
        plan = ctx.plan;
        balance = ctx.balance;
        quota = ctx.quota;
        renewsAt = ctx.renewsAt;
        period = ctx.period;
      } catch {
      }
      if (uid === "") {
        throw new Error("qwenwork: \u767B\u5F55\u6CA1\u6709\u8FD4\u56DE\u7528\u6237 id\uFF0C\u65E0\u6CD5\u7B7E\u540D\u8BF7\u6C42\uFF1B\u8BF7\u91CD\u8BD5");
      }
      return {
        uid,
        access: token,
        refresh: String(device.refresh_token ?? ""),
        expires: deviceExpiry(device),
        name: name2,
        email,
        machineId,
        ...plan !== void 0 ? { plan } : {},
        ...balance !== void 0 ? { balance } : {},
        ...quota !== void 0 ? { quota } : {},
        ...renewsAt !== void 0 ? { renewsAt } : {},
        ...period !== void 0 ? { period } : {},
        syncedAt: Date.now(),
        label: email || name2 || uid
      };
    }
  };
}
async function readAccountContext(gateway, token) {
  const r = await openapi(gateway, "/api/v1/adapter/user/account-context?include=user,plan,quota", { token });
  if (r.status < 200 || r.status >= 300) {
    if (r.status === 401) throw new Error("qwenwork: \u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    throw new Error(`qwenwork: \u8BFB\u53D6\u8D26\u53F7\u4FE1\u606F\u5931\u8D25\uFF08HTTP ${r.status}\uFF09`);
  }
  const data = unwrap(r.json);
  const user = data.user ?? data;
  const uid = String(user?.id ?? user?.user_id ?? user?.uid ?? "").trim();
  const email = String(user?.email ?? "");
  const name2 = String(user?.name ?? user?.username ?? "");
  const p = data.plan;
  const plan = typeof p?.name === "string" && p.name.trim() !== "" ? p.name : void 0;
  const period = typeof p?.period === "string" && p.period.trim() !== "" ? p.period : void 0;
  const dueAt = Date.parse(String(p?.next_due_date ?? "").trim());
  const renewsAt = Number.isNaN(dueAt) ? void 0 : dueAt;
  const q = data.quota;
  const num = (v) => {
    if (v === null || v === void 0 || v === "") return void 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : void 0;
  };
  const quota = q === void 0 || q === null ? void 0 : {
    ...num(q.total) !== void 0 ? { total: num(q.total) } : {},
    ...num(q.used) !== void 0 ? { used: num(q.used) } : {},
    ...num(q.remaining) !== void 0 ? { remaining: num(q.remaining) } : {},
    ...typeof q.exceeded === "boolean" ? { exceeded: q.exceeded } : {}
  };
  return {
    uid,
    name: name2,
    email,
    ...plan !== void 0 ? { plan } : {},
    ...quota !== void 0 ? { quota } : {},
    ...renewsAt !== void 0 ? { renewsAt } : {},
    ...period !== void 0 ? { period } : {},
    // 保留两位小数就够了，900 位小数没意义
    ...quota?.remaining !== void 0 ? { balance: `${round2(quota.remaining)} credits` } : {}
  };
}
function round2(n) {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toFixed(2);
}
function deviceExpiry(dt) {
  const at = Date.parse(String(dt?.expires_at ?? "").trim());
  if (!Number.isNaN(at)) return at;
  const secs = Number(dt?.expires_in);
  if (Number.isFinite(secs) && secs > 0) return Date.now() + secs * 1e3;
  return Date.now() + 24 * 60 * 60 * 1e3;
}
function unwrap(v) {
  const o = v;
  if (o && typeof o.data === "object" && o.data !== null && !Array.isArray(o.data)) {
    return o.data;
  }
  return o ?? {};
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function openapi(gateway, path, opts = {}) {
  const url = new URL(gateway + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers = {
    Accept: "application/json",
    ...clientHeaders()
  };
  if (opts.body !== void 0) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === void 0 ? void 0 : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}
var AccountStore = class {
  #path;
  #accounts = [];
  #loaded = false;
  constructor(dataDir) {
    this.#path = join(dataDir, "accounts.json");
  }
  get path() {
    return this.#path;
  }
  async load() {
    if (this.#loaded) return this.#accounts;
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw);
      this.#accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
    } catch {
      this.#accounts = [];
    }
    this.#loaded = true;
    return this.#accounts;
  }
  list() {
    return [...this.#accounts];
  }
  /** 按 uid 找账号（同一账号重复登录时覆盖）。 */
  find(uid) {
    return this.#accounts.find((a) => a.uid === uid);
  }
  async upsert(account) {
    await this.load();
    const at = this.#accounts.findIndex((a) => a.uid === account.uid);
    if (at >= 0) this.#accounts[at] = { ...this.#accounts[at], ...account };
    else this.#accounts.push(account);
    await this.#flush();
  }
  async remove(uid) {
    await this.load();
    this.#accounts = this.#accounts.filter((a) => a.uid !== uid);
    await this.#flush();
  }
  /**
   * 向上游重新拉一次账号现状（额度/套餐/续期），落盘并返回最新列表。
   *
   * 这是设置页「刷新」按钮的后端：登录时只读一次 account-context，
   * 之后的额度变化必须主动同步，否则界面上的数字永远是登录那一刻的。
   *
   * 单个账号失败不影响其他账号，只把错误汇总返回，让界面能提示。
   *
   * @param gateway 网关地址
   */
  async sync(gateway) {
    await this.load();
    const errors = [];
    let dirty = false;
    for (const account of this.#accounts) {
      try {
        const ctx = await readAccountContext(gateway, account.access);
        if (ctx.plan !== void 0) account.plan = ctx.plan;
        if (ctx.balance !== void 0) account.balance = ctx.balance;
        if (ctx.quota !== void 0) account.quota = ctx.quota;
        if (ctx.renewsAt !== void 0) account.renewsAt = ctx.renewsAt;
        if (ctx.period !== void 0) account.period = ctx.period;
        if (ctx.name !== "") account.name = ctx.name;
        if (ctx.email !== "") account.email = ctx.email;
        account.syncedAt = Date.now();
        dirty = true;
      } catch (error) {
        errors.push(`${account.label ?? account.uid}\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (dirty) await this.#flush();
    return { accounts: this.list(), errors };
  }
  /** 原子写：先写临时文件再 rename，避免中断留下半个 JSON。 */
  async #flush() {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    const payload = { version: 1, accounts: this.#accounts };
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, this.#path);
  }
};

// src/adapter/qwenwork.ts
import { randomUUID as randomUUID4 } from "node:crypto";

// src/adapter/images.ts
var REQUEST_MAX_PIXELS = 2048 * 2048;
var REQUEST_MAX_BYTES = 1024 * 1024;
function requestImageTarget(ref) {
  const pixels = ref.width * ref.height;
  if (!(pixels > REQUEST_MAX_PIXELS) || !(ref.width > 0 && ref.height > 0)) {
    return { width: ref.width, height: ref.height, maxBytes: REQUEST_MAX_BYTES };
  }
  const scale = Math.sqrt(REQUEST_MAX_PIXELS / pixels);
  return {
    width: Math.max(1, Math.floor(ref.width * scale)),
    height: Math.max(1, Math.floor(ref.height * scale)),
    maxBytes: REQUEST_MAX_BYTES
  };
}
function imageHandleText(ref, image) {
  const name2 = ref.name ?? `attachment ${String(ref.attachmentId).slice(0, 12)}`;
  return `Image ${name2}; request preview ${image.width}x${image.height}px.`;
}
function offloadedImageText(ref) {
  const name2 = ref.name ?? `attachment ${String(ref.attachmentId).slice(0, 12)}`;
  return `[image omitted (offloaded); ${name2}]`;
}
function collectImageRefs(content) {
  const refs = [];
  const inlineUrls = [];
  const offloaded = [];
  if (!Array.isArray(content)) return { refs, inlineUrls, offloaded };
  for (const block of content) {
    const b = block;
    if (b?.type === "image" && b.attachment !== void 0) {
      const a = b.attachment;
      if (typeof a.attachmentId === "string" && a.attachmentId !== "") {
        const ref = {
          attachmentId: a.attachmentId,
          mediaType: typeof a.mediaType === "string" ? a.mediaType : "image/png",
          bytes: typeof a.bytes === "number" ? a.bytes : 0,
          width: typeof a.width === "number" ? a.width : 0,
          height: typeof a.height === "number" ? a.height : 0,
          ...typeof a.name === "string" ? { name: a.name } : {}
        };
        if (b.offloaded === true) offloaded.push(ref);
        else refs.push(ref);
      }
    } else if (b?.type === "image_url") {
      const url = typeof b.image_url === "string" ? b.image_url : b.image_url?.url;
      if (typeof url === "string" && url !== "") inlineUrls.push(url);
    }
  }
  return { refs, inlineUrls, offloaded };
}
async function resolveImages(refs, attachments, signal) {
  const images = /* @__PURE__ */ new Map();
  if (refs.length === 0) return { images, failed: 0 };
  if (attachments === void 0 || typeof attachments.readImageRequest !== "function") {
    return {
      images,
      failed: refs.length,
      reason: "\u5BBF\u4E3B\u9644\u4EF6\u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u56FE\u7247\u65E0\u6CD5\u8BFB\u53D6"
    };
  }
  let failed = 0;
  let reason;
  await Promise.all(
    refs.map(async (ref) => {
      try {
        const read = await attachments.readImageRequest(ref, requestImageTarget(ref), signal);
        if (read.bytes <= 0 || read.data.length === 0) {
          failed += 1;
          return;
        }
        const mediaType = read.mediaType !== "" ? read.mediaType : ref.mediaType;
        const base64 = Buffer.from(read.data.buffer, read.data.byteOffset, read.data.byteLength).toString("base64");
        images.set(ref.attachmentId, {
          base64,
          dataUrl: `data:${mediaType};base64,${base64}`,
          mediaType,
          bytes: read.bytes,
          width: read.width,
          height: read.height
        });
      } catch (error) {
        failed += 1;
        if (reason === void 0) reason = error instanceof Error ? error.message : String(error);
      }
    })
  );
  return { images, failed, ...reason !== void 0 ? { reason } : {} };
}
function imageFailureNote(failed, reason) {
  if (failed <= 0) return "";
  const what = failed === 1 ? "1 \u5F20\u56FE\u7247" : `${failed} \u5F20\u56FE\u7247`;
  const why = reason !== void 0 && reason !== "" ? `\uFF08${reason}\uFF09` : "";
  return `[${what}\u672A\u80FD\u8BFB\u53D6${why}\uFF0C\u8FD9\u6761\u6D88\u606F\u91CC\u6CA1\u6709\u56FE\u7247\u5185\u5BB9]`;
}

// src/adapter/body.ts
var QWENWORK_SYSTEM_PROMPT = "You are QwenWork (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.";
function rawBlocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => typeof b === "object" && b !== null);
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(
    (b) => b?.type === "text" && typeof b.text === "string"
  ).map((b) => b.text).join("");
}
function blocksOf(content, resolved) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    const part = p;
    if (part?.type === "text" && part.text != null) {
      out.push({ type: "text", text: String(part.text) });
      continue;
    }
    if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) out.push({ type: "image_url", image_url: { url } });
      continue;
    }
    if (part?.type === "image") {
      const ref = part.attachment;
      if (ref === void 0 || typeof ref.attachmentId !== "string") continue;
      if (part.offloaded === true) {
        out.push({ type: "text", text: offloadedImageText(ref) });
        continue;
      }
      const image = resolved?.get(ref.attachmentId);
      if (image === void 0) continue;
      out.push({ type: "text", text: imageHandleText(ref, image) });
      out.push({ type: "image_url", image_url: { url: image.dataUrl } });
    }
  }
  return out;
}
function qwenworkMessages(messages, resolved) {
  const out = [];
  const names = /* @__PURE__ */ new Map();
  let open = [];
  let loose = [];
  const flushLoose = () => {
    if (loose.length) {
      out.push({ role: "user", content: loose });
      loose = [];
    }
  };
  for (const [i, m] of messages.entries()) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "user") {
      if (!rawBlocksOf(m.content).some((b) => b?.type === "tool-result")) {
        open = [];
      }
      flushLoose();
    } else if (m.role !== "tool") {
      flushLoose();
    }
    if (m.role === "tool") {
      const text = textOf(m.content);
      const named = String(m.toolCallId ?? m.tool_call_id ?? "").trim();
      let at = named ? open.indexOf(named) : -1;
      if (at < 0) at = 0;
      if (open.length === 0) {
        const said = text.trim();
        if (said) loose.push({ type: "text", text: said });
        continue;
      }
      const answered = open.splice(at, 1)[0];
      const body = text.trim() === "" ? "(no output)" : text;
      const failed = m.isError === true;
      out.push({
        role: "tool",
        tool_call_id: answered,
        content: failed ? `${body}

[error] \u8BE5\u5DE5\u5177\u6267\u884C\u5931\u8D25` : body
      });
      continue;
    }
    if (m.role === "assistant") {
      const fromContent = rawBlocksOf(m.content).filter(
        (b) => b?.type === "tool-call"
      );
      const fromField = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (fromContent.length > 0 || fromField.length > 0) {
        open = [];
        const normalised = [];
        for (const [k, b] of fromContent.entries()) {
          const id = String(b.id ?? "").trim() || `call_${i}_${k}`;
          const name2 = String(b.name ?? "");
          if (name2) names.set(id, name2);
          open.push(id);
          const args = typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {});
          normalised.push({ id, type: "function", function: { name: name2, arguments: args } });
        }
        for (const [k, c] of fromField.entries()) {
          const id = String(c.id ?? "").trim() || `call_${i}_f${k}`;
          const name2 = String(c.function?.name ?? "");
          if (name2) names.set(id, name2);
          if (!open.includes(id)) open.push(id);
          const args = typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {});
          normalised.push({ id, type: "function", function: { name: name2, arguments: args } });
        }
        const said2 = textOf(m.content);
        const turn2 = { role: "assistant", tool_calls: normalised };
        if (said2) turn2.content = said2;
        const thinking2 = reasoningOf(m);
        if (thinking2) turn2.reasoning_content = thinking2;
        out.push(turn2);
        continue;
      }
      const said = textOf(m.content);
      const thinking = reasoningOf(m);
      if (!said && !thinking) continue;
      const turn = { role: "assistant", content: said };
      if (thinking) turn.reasoning_content = thinking;
      out.push(turn);
      continue;
    }
    const results = rawBlocksOf(m.content).filter(
      (b) => b?.type === "tool-result"
    );
    const blocks = blocksOf(m.content, resolved);
    if (blocks.length) out.push({ role: "user", content: blocks });
    for (const r of results) {
      const text = textOf(r.content);
      const named = String(r.toolCallId ?? "").trim();
      let at = named ? open.indexOf(named) : -1;
      if (at < 0) at = 0;
      if (open.length === 0) {
        const said = text.trim();
        if (said) out.push({ role: "user", content: [{ type: "text", text: said }] });
        continue;
      }
      const answered = open.splice(at, 1)[0];
      const body = text.trim() === "" ? "(no output)" : text;
      const failed = r.isError === true;
      out.push({
        role: "tool",
        tool_call_id: answered,
        content: failed ? `${body}

[error] \u8BE5\u5DE5\u5177\u6267\u884C\u5931\u8D25` : body
      });
    }
  }
  flushLoose();
  return out;
}
function reasoningOf(m) {
  const direct = [m.reasoning_content, m.reasoning].find((v) => typeof v === "string" && v.trim() !== "");
  if (typeof direct === "string") return direct;
  const details = m.reasoning_details;
  if (Array.isArray(details)) {
    const joined = details.map((d) => typeof d?.text === "string" ? d.text : typeof d?.summary === "string" ? d.summary : "").join("");
    if (joined.trim()) return joined;
  }
  return "";
}
var UNCACHED = /* @__PURE__ */ new Set(["thinking", "redacted_thinking", "tool_use", "tool_result", "image", "image_url"]);
function cacheMarked(messages) {
  const out = messages.map(
    (m) => m.role === "user" && Array.isArray(m.content) ? { ...m, contents: m.content } : m
  );
  const last = out[out.length - 1];
  if (last?.role !== "user" || !Array.isArray(last.content)) return out;
  const blocks = last.content;
  let at = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i]?.type;
    if (typeof type === "string" && type !== "" && !UNCACHED.has(type)) {
      at = i;
      break;
    }
  }
  if (at < 0) return out;
  const marked = blocks.slice();
  marked[at] = { ...marked[at], cache_control: { type: "ephemeral" } };
  out[out.length - 1] = { ...last, content: marked, contents: marked };
  return out;
}
function modelConfig(m, thinking) {
  const key = m.key.trim();
  if (!key || ["auto", "default"].includes(key)) {
    throw new Error(`qwenwork: \u6A21\u578B key \u4E0D\u53EF\u7528\uFF08${JSON.stringify(m.key)}\uFF09`);
  }
  return {
    key,
    display_name: m.displayName || key,
    model: "",
    format: m.format ?? "openai",
    is_vl: m.isVision === true,
    is_reasoning: m.isReasoning === true && thinking,
    api_key: "",
    url: "",
    source: m.source || "system",
    max_input_tokens: m.maxInputTokens && m.maxInputTokens > 0 ? m.maxInputTokens : 2e5
  };
}
var SMALL_BUDGET = 1024;
var EFFORT_OFF = /* @__PURE__ */ new Set(["off", "none", "disabled", "false"]);
var EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
function fitEffort(want, levels) {
  let target = want;
  if (target === "ultra" && !levels.includes(target)) target = "max";
  if (levels.length === 0 || levels.includes(target)) return target;
  const at = EFFORT_RANK.indexOf(target);
  if (at < 0) return target;
  let best = target;
  let distance = EFFORT_RANK.length;
  for (const level of levels) {
    const i = EFFORT_RANK.indexOf(level);
    if (i < 0 || level === "none") continue;
    const d = Math.abs(i - at);
    if (d < distance || d === distance && i > at) {
      best = level;
      distance = d;
    }
  }
  return best;
}
function decideThinking(asked, model, budget) {
  const levels = model.efforts ?? [];
  let want = String(asked ?? "").toLowerCase();
  if (EFFORT_OFF.has(want)) want = "none";
  if (want !== "none" && !EFFORT_RANK.includes(want)) want = "";
  if (want === "" && budget > 0 && budget <= SMALL_BUDGET) want = "none";
  if (model.isReasoning !== true) return { thinking: false, effort: "" };
  if (want === "none") return { thinking: false, effort: "" };
  if (levels.length === 0) return { thinking: true, effort: "" };
  if (want === "") return { thinking: true, effort: model.defaultEffort ?? "" };
  return { thinking: true, effort: fitEffort(want, levels) };
}
function windowFor(req, model, replyTokens = 0, fixedWindow = 0) {
  const windows = model.windows ?? [];
  const base = model.defaultWindow ?? model.maxInputTokens ?? 0;
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify({ m: req.messages ?? [], t: req.tools ?? [] }), "utf8");
  } catch {
    bytes = 0;
  }
  const need = Math.ceil(bytes / 3) + Math.max(0, replyTokens);
  if (fixedWindow > 0) {
    if (windows.length === 0) return fixedWindow;
    if (need <= fixedWindow) return fixedWindow;
    return windows.find((w) => w >= need) ?? windows[windows.length - 1] ?? fixedWindow;
  }
  if (windows.length === 0) return base;
  if (base > 0 && need <= base) return base;
  return windows.find((w) => w >= need) ?? windows[windows.length - 1] ?? base;
}
function buildBody(req, model, sessionId, requestId, task, fixedWindow = 0, resolved, imageFailure) {
  const declared = typeof req.system === "string" && req.system.trim() !== "" ? req.system : "";
  const systems = req.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).filter(Boolean);
  if (declared !== "") systems.unshift(declared);
  const base = QWENWORK_SYSTEM_PROMPT;
  const systemText = systems.length ? `${base}

${systems.join("\n\n")}` : base;
  const tools = ((req.tool_choice ?? req.toolChoice) !== "none" ? req.tools ?? [] : []).map((t) => normaliseTool(t)).filter((t) => t !== void 0);
  const budget = req.maxTokens ?? req.max_completion_tokens ?? req.max_tokens ?? 0;
  const maxTokens = req.maxTokens ?? req.max_completion_tokens ?? req.max_tokens ?? 32e3;
  const { thinking, effort } = decideThinking(req.reasoningEffort ?? req.reasoning_effort, model, budget);
  const parameters = {
    enable_thinking: thinking,
    max_tokens: maxTokens
  };
  if (effort !== "") parameters.reasoning_effort = effort;
  if (typeof req.temperature === "number") parameters.temperature = req.temperature;
  const contextWindow = windowFor(req, model, maxTokens, fixedWindow);
  if (contextWindow > 0) parameters.context_length = contextWindow;
  const sys = { type: "text", text: systemText };
  const body = {
    request_id: requestId,
    // 同一任务的所有调用共用 request_set_id 与 begin_at
    request_set_id: task.id,
    chat_record_id: requestId,
    session_id: sessionId,
    parameters,
    business: {
      product: "qoder_work",
      version: "1.1.59",
      type: "agent",
      id: task.id,
      name: task.name,
      begin_at: task.begin,
      // 任务被回答过一轮后就是 processing
      stage: task.answered ? "processing" : "start"
    },
    agent_id: "agent_common",
    task_id: "common",
    session_type: "qoder_work",
    model_config: modelConfig(model, thinking),
    system: [sys],
    messages: [{ role: "system", content: [sys] }, ...cacheMarked(qwenworkMessages(req.messages, resolved))]
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: normaliseSchema(t.parameters) ?? { type: "object", properties: {} }
      }
    }));
  }
  if ((req.tool_choice ?? req.toolChoice) === "required" && tools.length) {
    const s = body.system;
    s[0].text += "\nYou must call an available function in this response.";
    const first = body.messages[0];
    first.content = [s[0]];
  }
  if (imageFailure !== void 0 && imageFailure.failed > 0) {
    const note = imageFailureNote(imageFailure.failed, imageFailure.reason);
    if (note !== "") {
      const msgs = body.messages;
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (lastUser !== void 0) {
        if (Array.isArray(lastUser.content)) lastUser.content.push({ type: "text", text: note });
        else if (typeof lastUser.content === "string") lastUser.content = `${lastUser.content}

${note}`;
      }
    }
  }
  return body;
}
var SUB_ONE = [
  "items",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "additionalProperties",
  "unevaluatedProperties"
];
var SUB_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"];
var SUB_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
function normaliseTool(tool) {
  if (!tool || typeof tool !== "object") return void 0;
  const t = tool;
  const inner = t.function;
  if (inner && typeof inner === "object") {
    const f = inner;
    const name3 = typeof f.name === "string" ? f.name.trim() : "";
    if (name3 === "") return void 0;
    return {
      name: name3,
      description: typeof f.description === "string" ? f.description : "",
      parameters: f.parameters
    };
  }
  const name2 = typeof t.name === "string" ? t.name.trim() : "";
  if (name2 === "") return void 0;
  return {
    name: name2,
    description: typeof t.description === "string" ? t.description : "",
    parameters: t.parameters
  };
}
function normaliseSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const root = structuredClone(schema);
  const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  const target = (ref) => {
    if (!ref.startsWith("#/")) return void 0;
    let at = root;
    for (const k of ref.slice(2).split("/")) {
      if (!isObj(at)) return void 0;
      at = at[k.replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    return isObj(at) ? at : void 0;
  };
  const isObject = (branch, seen = []) => {
    if (!isObj(branch)) return false;
    if ("type" in branch) return branch.type === "object";
    if (typeof branch.$ref !== "string" || seen.includes(branch.$ref) || seen.length > 16) return false;
    return isObject(target(branch.$ref), [...seen, branch.$ref]);
  };
  const walk = (node, depth) => {
    if (!isObj(node) || depth > 64) return;
    if (!("type" in node) && Array.isArray(node.oneOf) && node.oneOf.length > 0 && node.oneOf.every((b) => isObject(b))) {
      node.type = "object";
    }
    for (const k of SUB_ONE) walk(node[k], depth + 1);
    for (const k of SUB_LIST) {
      const list = node[k];
      if (Array.isArray(list)) for (const v of list) walk(v, depth + 1);
    }
    for (const k of SUB_MAP) {
      const map = node[k];
      if (isObj(map)) for (const v of Object.values(map)) walk(v, depth + 1);
    }
  };
  walk(root, 0);
  return root;
}

// src/adapter/catalog.ts
var FALLBACK_MODELS = [
  {
    key: "flash",
    displayName: "\u6807\u51C6",
    description: "\u6781\u901F\u5168\u80FD\uFF0C\u79D2\u6740\u65E5\u5E38\u4EFB\u52A1",
    rate: 0.1,
    isVision: true,
    isReasoning: true,
    efforts: [],
    maxInputTokens: 1e6,
    windows: [2e5, 4e5, 1e6],
    defaultWindow: 1e6
  },
  {
    key: "pro",
    displayName: "\u9AD8\u7EA7",
    description: "\u6027\u80FD\u5747\u8861\uFF0C\u64C5\u957F\u590D\u6742\u4EFB\u52A1",
    rate: 1,
    isVision: true,
    isReasoning: true,
    efforts: [],
    maxInputTokens: 1e6,
    windows: [2e5, 4e5, 1e6],
    defaultWindow: 1e6
  },
  {
    key: "qwen3.8-max-preview",
    displayName: "Qwen3.8-Max",
    description: "\u5343\u95EE\u6700\u5F3A\u6A21\u578B",
    rate: 1.8,
    isVision: true,
    isReasoning: true,
    efforts: [],
    maxInputTokens: 1e6,
    windows: [2e5, 4e5, 1e6],
    defaultWindow: 1e6
  }
];
var EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
var numOf = (v, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
function rateOf(raw) {
  const price = raw.price_factor ?? raw.priceFactor;
  if (typeof price !== "number" || !Number.isFinite(price)) return { rate: 0, rateWas: 0 };
  const promotion = raw.promotion ?? {};
  const before = numOf(promotion.before_promotion_price_factor ?? promotion.beforePromotionPriceFactor);
  const discount = numOf(promotion.discount_factor ?? promotion.discountFactor);
  const active = promotion.active === true && before > 0;
  let rate = Math.max(price, 0);
  let rateWas = Math.max(numOf(raw.original_price_factor), numOf(raw.originalPriceFactor));
  if (active) {
    rateWas = before;
    if (rate === 0) rate = before * discount;
  }
  if (rateWas <= rate) rateWas = 0;
  return { rate, rateWas };
}
function windowsOf(raw) {
  const positive = (v) => Number.isInteger(v) && v > 0 ? v : 0;
  const windows = [];
  let def = 0;
  const config = raw.context_config ?? raw.contextConfig;
  if (config !== null && config !== void 0 && typeof config === "object" && !Array.isArray(config)) {
    for (const entry of Object.values(config)) {
      const e = entry;
      const tokens = positive(e?.token_count);
      if (tokens === 0) continue;
      if (!windows.includes(tokens)) windows.push(tokens);
      if (e?.is_default === true || e?.is_default === 1 || e?.is_default === "1") def = tokens;
    }
  }
  if (windows.length === 0) {
    const list = raw.available_context_windows;
    for (const v of Array.isArray(list) ? list : []) {
      const tokens = positive(v);
      if (tokens > 0 && !windows.includes(tokens)) windows.push(tokens);
    }
    def = positive(raw.default_context_window);
    if (!windows.includes(def)) def = 0;
  }
  windows.sort((a, b) => a - b);
  return { windows, defaultWindow: def };
}
function thinkingOf(raw) {
  const config = raw.thinking_config;
  if (config !== null && config !== void 0 && typeof config === "object") {
    const enabled = config.enabled;
    if (config.enabled == null) return { isReasoning: false, efforts: [], defaultEffort: "" };
    const efforts = [];
    let defaultEffort = "";
    const declared = enabled?.efforts;
    if (declared !== null && declared !== void 0 && typeof declared === "object") {
      for (const [name2, entry] of Object.entries(declared)) {
        efforts.push(name2);
        if (entry?.is_default === true) defaultEffort = name2;
      }
    }
    const rank = (s) => {
      const at = EFFORT_ORDER.indexOf(s);
      return at < 0 ? EFFORT_ORDER.length : at;
    };
    efforts.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    return { isReasoning: true, efforts, defaultEffort };
  }
  const fallbackEfforts = Array.isArray(raw.reasoning_efforts) ? raw.reasoning_efforts.filter((v) => typeof v === "string") : [];
  return { isReasoning: raw.is_reasoning === true, efforts: fallbackEfforts, defaultEffort: "" };
}
function toModelEntry(raw) {
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  if (key === "") return null;
  if (key === "auto" || key === "default") return null;
  if (raw.enable === false) return null;
  const { windows, defaultWindow } = windowsOf(raw);
  const { isReasoning, efforts, defaultEffort } = thinkingOf(raw);
  const { rate, rateWas } = rateOf(raw);
  const entry = {
    key,
    displayName: typeof raw.display_name === "string" && raw.display_name.trim() !== "" ? raw.display_name : key,
    rate,
    isVision: raw.is_vl === true,
    isReasoning,
    efforts,
    maxInputTokens: Number.isInteger(raw.max_input_tokens) && raw.max_input_tokens > 0 ? raw.max_input_tokens : windows.length > 0 ? windows[windows.length - 1] : 0,
    ...windows.length > 0 ? { windows } : {},
    ...defaultWindow > 0 ? { defaultWindow } : {}
  };
  if (typeof raw.description === "string" && raw.description.trim() !== "") entry.description = raw.description;
  if (rateWas > 0) entry.rateWas = rateWas;
  if (raw.is_free === true) entry.free = true;
  if (defaultEffort !== "") entry.defaultEffort = defaultEffort;
  if (typeof raw.format === "string") entry.format = raw.format;
  if (typeof raw.source === "string") entry.source = raw.source;
  return entry;
}
function parseModelListing(payload) {
  const root = payload;
  if (root === null || typeof root !== "object") return [];
  const scenes = ["qwork", "app", "chat"];
  for (const scene of scenes) {
    const list = root[scene];
    if (!Array.isArray(list)) continue;
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const item of list) {
      const entry = toModelEntry(item);
      if (entry === null || seen.has(entry.key)) continue;
      seen.add(entry.key);
      out.push(entry);
    }
    if (out.length > 0) return out;
  }
  return [];
}
function formatRate(rate) {
  if (rate === void 0 || !Number.isFinite(rate) || rate <= 0) return "";
  const text = Number(rate.toFixed(2)).toString();
  return `${text}\xD7`;
}

// src/adapter/session.ts
import { createHash as createHash3, randomUUID as randomUUID3 } from "node:crypto";
var TASK_MAX = 512;
var TASK_IDLE = 2 * 60 * 60 * 1e3;
var TASKS = /* @__PURE__ */ new Map();
function stableUUID(seed) {
  const h = createHash3("sha256").update(seed, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function sessionOf(named, chat) {
  const trimmedNamed = String(named ?? "").trim();
  let seed = "";
  if (trimmedNamed !== "") {
    seed = `session\0${trimmedNamed}`;
  } else {
    const cacheKey = String(chat.prompt_cache_key ?? "").trim();
    const user = String(chat.user ?? "").trim();
    if (cacheKey !== "") seed = `key\0${cacheKey}`;
    else if (user !== "") seed = `user\0${user}`;
  }
  if (seed === "") {
    const messages = chat.messages ?? [];
    const systems = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content));
    const firstUser = messages.find((m) => m.role === "user");
    seed = `chat\0${JSON.stringify([systems, firstUser?.content ?? ""])}`;
  }
  return stableUUID(seed);
}
function taskName(prompt) {
  return prompt.length > 10 ? prompt.slice(0, 10) : prompt;
}
function taskOf(sessionId, chat, now = Date.now()) {
  const messages = chat.messages ?? [];
  const at = messages.findLastIndex((m) => m?.role === "user");
  const prompt = at < 0 ? "" : textOf(messages[at].content);
  const key = createHash3("sha256").update(JSON.stringify([sessionId, at, at < 0 ? null : messages[at].content ?? null])).digest("hex");
  for (const [k, t] of TASKS) {
    if (now - t.used <= TASK_IDLE) break;
    TASKS.delete(k);
  }
  let task = TASKS.get(key);
  if (task !== void 0 && now - task.used > TASK_IDLE) task = void 0;
  TASKS.delete(key);
  if (task === void 0) {
    task = {
      id: randomUUID3(),
      begin: now,
      answered: false,
      name: taskName(prompt),
      used: now
    };
  } else {
    task.used = now;
  }
  TASKS.set(key, task);
  while (TASKS.size > TASK_MAX) {
    const oldest = TASKS.keys().next().value;
    if (oldest === void 0) break;
    TASKS.delete(oldest);
  }
  return task;
}
function markTaskAnswered(task) {
  task.answered = true;
}

// src/adapter/codec.ts
var ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
var PAD = "$";
function segmentEncode(bytes) {
  let s = "";
  let acc = 0;
  let nb = 0;
  for (const b of bytes) {
    acc = (acc << 8 | b) & 16777215;
    nb += 8;
    while (nb >= 6) {
      nb -= 6;
      s += ALPHABET[acc >> nb & 63];
    }
  }
  if (nb > 0) s += ALPHABET[acc << 6 - nb & 63];
  while (s.length % 4) s += PAD;
  return s;
}
function swapThirds(s) {
  const t = Math.floor(s.length / 3);
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s;
}
function encodeBody(text) {
  return swapThirds(segmentEncode(new TextEncoder().encode(text)));
}
function decodeBody(wire) {
  const s = swapThirds(wire);
  const out = [];
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== PAD).map((c) => ALPHABET.indexOf(c));
    if (vals.some((v) => v < 0)) throw new Error("qwenwork: body \u542B\u672A\u77E5\u5B57\u7B26\uFF0C\u4E0D\u662F QwenWork \u7684\u7F16\u7801");
    let x = 0;
    for (const v of vals) x = x * 64 + v;
    const n = Math.floor(6 * vals.length / 8);
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255);
  }
  return new TextDecoder().decode(new Uint8Array(out));
}
function looksEncoded(text) {
  const t = text.trim();
  if (t === "") return false;
  if (t.startsWith("{") || t.startsWith("[")) return false;
  return [...t].every((c) => c === PAD || ALPHABET.includes(c));
}

// src/adapter/stream.ts
var QUEUED = "10605";
var QUOTA_CODES = /* @__PURE__ */ new Set(["110", "112", "113", "114", "115", "116", "117", "118", "119", "122"]);
var REQUEST_CODES = /* @__PURE__ */ new Set(["406", "416", "430", "80411", "80412", "100400", "100401", "100403"]);
var UPSTREAM_FAILED = /\berror in upstream response\b/i;
var BUSY_WAIT = 30;
function failure(status, text) {
  if (status < 400 || status > 599) status = 502;
  let msg = String(text ?? "").trim();
  let code = "";
  let queue;
  try {
    let j = JSON.parse(msg);
    const outerCode = j?.code == null ? "" : String(j.code);
    if (["", "401", "403"].includes(outerCode) && typeof j?.message === "string") {
      try {
        const inner = JSON.parse(j.message.trim());
        if (inner && !Array.isArray(inner) && String(inner.code) === QUEUED) j = inner;
      } catch {
      }
    }
    code = j?.code == null ? "" : String(j.code);
    if (j?.message) msg = String(j.message);
    const rawDetails = j?.details;
    const d = typeof rawDetails === "string" ? JSON.parse(rawDetails.trim()) : rawDetails;
    if (d?.error?.message) msg += ": " + d.error.message;
    const q = j?.queue;
    if (q && typeof q === "object") queue = q;
    if (!queue && typeof j?.message === "string" && j.message.trim().startsWith("{")) {
      const parsed = JSON.parse(j.message.trim());
      if (parsed && typeof parsed === "object" && ("isQueued" in parsed || "serviceAvailable" in parsed || "retryAfterSeconds" in parsed)) {
        queue = parsed;
      }
    }
  } catch {
  }
  if (msg === "") msg = `HTTP ${status}`;
  if (code === QUEUED || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const n = Number(queue?.retryAfterSeconds);
    const wait = Number.isFinite(n) && n > 0 ? Math.ceil(n) : BUSY_WAIT;
    const model = queue?.modelKey ? ` for ${queue.modelKey}` : "";
    const aheadCount = Number(queue?.queueCount);
    const ahead = Number.isFinite(aheadCount) && aheadCount > 0 ? `, ${Math.floor(aheadCount)} ahead` : "";
    const what = queue?.isQueued === true ? "queued the request" : "is busy";
    return {
      status: 503,
      message: `\u5343\u95EE\u529E\u516C${what === "is busy" ? " \u6B63\u5FD9" : " \u5DF2\u6392\u961F"}${model}; \u7EA6 ${wait} \u79D2\u540E\u91CD\u8BD5`,
      code: "QUEUED",
      retryAfter: wait
    };
  }
  if (QUOTA_CODES.has(code)) {
    return { status: 429, message: `\u7528\u91CF\u5DF2\u7528\u5B8C\uFF1A${msg}`, code: "QUOTA_EXCEEDED" };
  }
  if (REQUEST_CODES.has(code)) {
    return { status: 400, message: `\u5343\u95EE\u529E\u516C\u62D2\u7EDD\u4E86\u8FD9\u6B21\u8BF7\u6C42\uFF08${code}\uFF09\uFF1A${msg}`, code: "INVALID_REQUEST" };
  }
  if (UPSTREAM_FAILED.test(msg)) {
    return { status: 502, message: msg, code: "SERVER" };
  }
  if (/all models failed/i.test(msg)) {
    return {
      status: 503,
      message: `\u5343\u95EE\u529E\u516C\u6A21\u578B\u6C60\u6682\u65F6\u4E0D\u53EF\u7528\uFF08${msg}\uFF09\uFF0C\u7A0D\u540E\u91CD\u8BD5`,
      code: "MODEL_POOL_BUSY",
      retryAfter: BUSY_WAIT
    };
  }
  if (status === 401 || status === 403) {
    const said = msg && msg !== `HTTP ${status}` ? `\uFF08\u4E0A\u6E38\u8BF4 ${status}\uFF1A${msg.slice(0, 300)}\uFF09` : "";
    return { status: 401, message: `\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55${said}`, code: "AUTH", lapsed: true };
  }
  if (/quota|credits?|usage limit|insufficient (?:balance|quota|credits?)|out of credits?|exceeded.*(?:quota|limit)|余额不足|额度/i.test(
    msg
  )) {
    return { status: 429, message: `\u7528\u91CF\u5DF2\u7528\u5B8C\uFF1A${msg}`, code: "QUOTA_EXCEEDED" };
  }
  if (status === 429) {
    return { status: 429, message: `\u4E0A\u6E38\u9650\u6D41\uFF1A${msg}`, code: "MODEL_POOL_BUSY", retryAfter: BUSY_WAIT };
  }
  return { status, message: msg, code: status >= 500 ? "SERVER" : "INVALID_REQUEST" };
}
var UpstreamError = class _UpstreamError extends Error {
  status;
  code;
  retryAfter;
  lapsed;
  constructor(f) {
    super(f.message);
    this.status = f.status;
    this.code = f.code;
    if (f.retryAfter !== void 0) this.retryAfter = f.retryAfter;
    if (f.lapsed !== void 0) this.lapsed = f.lapsed;
  }
  static from(status, text) {
    return new _UpstreamError(failure(status, text));
  }
};
async function* sseLines(body) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let n;
    while ((n = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, n).trim();
      buf = buf.slice(n + 1);
    }
  }
  if (buf.trim()) yield buf.trim();
}
async function* toStreamChunks(body, model) {
  let nextIndex = 0;
  let textIndex = -1;
  let reasoningIndex = -1;
  let textOpen = false;
  let reasoningOpen = false;
  const textBuffer = /* @__PURE__ */ new Map();
  const reasoningBuffer = /* @__PURE__ */ new Map();
  const toolCalls = /* @__PURE__ */ new Map();
  const toolIndexes = /* @__PURE__ */ new Map();
  let sawToolCall = false;
  let finishReason = "";
  let usage = null;
  for await (const raw of sseLines(body)) {
    if (!raw.startsWith("data:")) continue;
    const payload = raw.slice(5).trim();
    if (payload === "") continue;
    let envelope;
    try {
      envelope = JSON.parse(payload);
    } catch {
      continue;
    }
    const statusCode = Number(envelope.statusCodeValue ?? envelope.statusCode);
    if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 0) {
      const inner = typeof envelope.body === "string" ? envelope.body : payload;
      throw UpstreamError.from(statusCode >= 400 ? statusCode : 502, inner);
    }
    let innerText = typeof envelope.body === "string" ? envelope.body.trim() : "";
    if (innerText === "") innerText = payload;
    if (innerText === "[DONE]") break;
    if (looksEncoded(innerText)) {
      try {
        innerText = decodeBody(innerText).trim();
      } catch {
      }
    }
    if (innerText === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(innerText);
    } catch {
      continue;
    }
    if (!Array.isArray(chunk.choices) && (chunk.error !== void 0 || chunk.code != null && chunk.message != null)) {
      const raw2 = String(chunk.code ?? "");
      const status = Number.isFinite(Number(raw2)) && Number(raw2) >= 400 ? Number(raw2) : 502;
      throw UpstreamError.from(status, innerText);
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      if (!reasoningOpen) {
        reasoningIndex = nextIndex++;
        reasoningOpen = true;
        yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
      }
      reasoningBuffer.set(reasoningIndex, (reasoningBuffer.get(reasoningIndex) ?? "") + delta.reasoning_content);
      yield { type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning_content };
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      if (reasoningOpen) {
        reasoningOpen = false;
        yield {
          type: "block-end",
          index: reasoningIndex,
          block: { type: "reasoning", text: reasoningBuffer.get(reasoningIndex) ?? "" }
        };
      }
      if (!textOpen) {
        textIndex = nextIndex++;
        textOpen = true;
        yield { type: "block-start", index: textIndex, blockType: "text" };
      }
      textBuffer.set(textIndex, (textBuffer.get(textIndex) ?? "") + delta.content);
      yield { type: "text-delta", index: textIndex, text: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const upstreamIndex = Number(tc.index ?? 0);
      const name2 = String(tc.function?.name ?? "");
      const args = String(tc.function?.arguments ?? "");
      const id = String(tc.id ?? "");
      if (!id && !name2 && !args) continue;
      let slot = toolCalls.get(upstreamIndex);
      if (!slot) {
        slot = { id: id || `call_${upstreamIndex}_${toolCalls.size}`, name: "", args: "" };
        toolCalls.set(upstreamIndex, slot);
        toolIndexes.set(upstreamIndex, nextIndex++);
        sawToolCall = true;
        yield { type: "block-start", index: toolIndexes.get(upstreamIndex), blockType: "tool-call" };
      }
      if (id) slot.id = id;
      if (name2) slot.name = name2;
      if (args) slot.args += args;
      yield {
        type: "tool-call-delta",
        index: toolIndexes.get(upstreamIndex),
        id: slot.id,
        ...name2 ? { name: name2 } : {},
        argumentsDelta: args
      };
    }
    if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") {
      finishReason = choice.finish_reason;
    }
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        inputTokens: Number(chunk.usage.prompt_tokens ?? 0),
        outputTokens: Number(chunk.usage.completion_tokens ?? 0),
        ...typeof cached === "number" && cached > 0 ? { cacheReadTokens: cached } : {}
      };
    }
  }
  if (reasoningOpen) {
    yield {
      type: "block-end",
      index: reasoningIndex,
      block: { type: "reasoning", text: reasoningBuffer.get(reasoningIndex) ?? "" }
    };
  }
  if (textOpen) {
    yield {
      type: "block-end",
      index: textIndex,
      block: { type: "text", text: textBuffer.get(textIndex) ?? "" }
    };
  }
  const unnamed = [...toolCalls.values()].filter((slot) => slot.name.trim() === "").length;
  const said = [...textBuffer.values()].join("") + [...reasoningBuffer.values()].join("");
  for (const [upstreamIndex, slot] of toolCalls) {
    yield {
      type: "block-end",
      index: toolIndexes.get(upstreamIndex),
      block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args }
    };
  }
  if (unnamed > 0 && said.trim() === "") {
    throw UpstreamError.from(
      502,
      JSON.stringify({ code: 502, message: `${model}: \u4E0A\u6E38\u8FD4\u56DE\u4E86\u6CA1\u6709\u540D\u5B57\u7684\u5DE5\u5177\u8C03\u7528` })
    );
  }
  if (unnamed > 0) {
    yield { type: "usage", usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
    yield {
      type: "finish",
      reason: {
        kind: "error",
        failure: { message: `${model}: \u4E0A\u6E38\u8FD4\u56DE\u4E86\u6CA1\u6709\u540D\u5B57\u7684\u5DE5\u5177\u8C03\u7528\uFF0C\u5DF2\u4E22\u5F03`, code: "UNNAMED_TOOL_CALL" }
      }
    };
    return;
  }
  yield { type: "usage", usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
  if (sawToolCall && (finishReason === "" || finishReason === "tool_calls" || finishReason === "stop")) {
    yield { type: "finish", reason: { kind: "tool-calls" } };
    return;
  }
  switch (finishReason) {
    case "length":
      yield { type: "finish", reason: { kind: "max-tokens" } };
      return;
    case "tool_calls":
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    case "content_filter":
      yield { type: "finish", reason: { kind: "error", failure: { message: `${model}: \u5185\u5BB9\u88AB\u4E0A\u6E38\u8FC7\u6EE4`, code: "CONTENT_FILTERED" } } };
      return;
    default: {
      const said2 = [...textBuffer.values()].join("") + [...reasoningBuffer.values()].join("");
      if (said2.trim() === "" && !sawToolCall) {
        yield {
          type: "finish",
          reason: { kind: "error", failure: { message: `${model}: \u4E0A\u6E38\u8FD4\u56DE\u4E86\u7A7A\u56DE\u7B54`, code: "EMPTY_RESPONSE" } }
        };
        return;
      }
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
  }
}

// src/adapter/qwenwork.ts
var MODELS = FALLBACK_MODELS;
var LIST_PATH = "/algo/api/v2/model/list?Encode=1";
var CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
var DEFAULT_CONTEXT_WINDOW = 131072;
var DEFAULT_MAX_TOKENS = 32e3;
var LIST_TTL_MS = 5 * 60 * 1e3;
var POOL_RETRIES = 2;
var POOL_MAX_WAIT_MS = 2e4;
var TRANSIENT_WAIT = 3;
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var QwenWorkAdapter = class {
  #providerId;
  #displayName;
  #gateway;
  #store;
  #prefs;
  #attachments;
  #onModelsChanged;
  /** 轮转游标：上次成功的账号下标。 */
  #cursor = 0;
  /** 上游真实模型目录；拿不到时为兜底快照。 */
  #models = FALLBACK_MODELS;
  /** 上次拉目录的时间，用于 TTL。 */
  #modelsAt = 0;
  /** 正在进行的目录刷新，避免并发重复请求。 */
  #refreshing = null;
  constructor(opts) {
    this.#providerId = opts.providerId ?? "qwenwork";
    this.#displayName = opts.displayName ?? "\u5343\u95EE\u529E\u516C";
    this.#gateway = (opts.gateway ?? GATEWAY).replace(/\/+$/, "");
    this.#store = opts.store;
    this.#prefs = opts.prefs;
    this.#attachments = opts.attachments;
    this.#onModelsChanged = opts.onModelsChanged;
  }
  /** 某个模型当前固定的上下文档位；0 表示自动。 */
  windowPreference(model) {
    return this.#prefs?.windowFor(model) ?? 0;
  }
  /** 改某个模型的上下文档位偏好；0 恢复自动。 */
  async setWindowPreference(model, tokens) {
    if (this.#prefs === void 0) throw new Error("qwenwork: \u504F\u597D\u5B58\u50A8\u672A\u521D\u59CB\u5316");
    await this.#prefs.setWindow(model, tokens);
  }
  /** 当前模型目录（可能还没拉到真实值）。 */
  get models() {
    return this.#models;
  }
  /**
   * 上次成功从上游拉到目录的时刻；0 表示还没成功过。
   *
   * 用来区分「这次真的回源了」和「回源失败、沿用缓存」——
   * 只看目录非空是分不出来的，兜底快照本身就是非空的。
   */
  get modelsFetchedAt() {
    return this.#modelsAt;
  }
  // ── 契约方法 ──────────────────────────────────────────────────────────
  /** 分组名，模型选择器里显示。 */
  providerInfo(provider) {
    return { id: provider, name: this.#displayName };
  }
  /**
   * 重试策略。
   *
   * 不能返回 `undefined` 用宿主默认值：DSH 的默认 `retryableCodes` 只有
   * `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`
   * （dsh-llm/lib/types/retry-policy.js），**按 code 字符串匹配**，不看 HTTP 状态码。
   *
   * 而千问办公最常见的两种瞬时失败恰恰不在这张表里：
   *   - `MODEL_POOL_BUSY` —— 上游 429「All models failed」，多轮 agent 循环
   *     第 3~4 轮就会撞上，账号额度明明还很充足
   *   - `QUEUED` —— 上游排队，返回里有 retryAfterSeconds
   *
   * 不声明的话，插件自己重试两轮后抛出去，DSH 一看 code 不认识就当场判失败——
   * 表现就是「跑一会儿突然停」，父 agent 中断、子代理还在跑。
   */
  providerRetryPolicy(_provider) {
    return {
      mode: "normal",
      // 宿主侧再多试几轮。插件内部已经等过最多 2×20 秒，
      // 这里放宽到 4 次，把「池子忙一阵就恢复」的情况兜住。
      maxRetries: 4,
      retryableCodes: ["MODEL_POOL_BUSY", "QUEUED", "SERVER", "TIMEOUT", "TRANSPORT", "RATE_LIMIT"]
    };
  }
  /** 千问办公没有单独的视觉计费。 */
  imageRequestPricing(_provider, _model) {
    return void 0;
  }
  /**
   * 选择器里列出的模型。
   *
   * 倍率走 `badge`：宿主会把它渲染成名称旁一个按 tone 着色的 Tag
   * （触发按钮在名称前、菜单在名称后），这是除 name 之外唯一能显示
   * 自定义文字的槽位——`description` 只在部分位置露出，倍率放那里
   * 用户在选择器里根本看不到。
   *
   * 宿主契约里这个方法是 async，所以目录还没拉到上游时**先等一次**，
   * 别把兜底快照当答案交出去。启动时目录是后台异步拉的，宿主往往在
   * 拉完之前就来问，早先同步返回兜底值的结果就是：设置页明明已经有
   * 上游的新模型（比如 Qwen4），模型选择器里却还是原来那三个，
   * 非得手动点一次刷新才对齐。
   */
  async listModels(provider) {
    if (this.#modelsAt === 0) await this.refreshModels(false);
    return this.#models.map((m) => {
      const free = m.free === true || m.rate === void 0 || m.rate <= 0;
      const badge = free ? { text: "\u514D\u8D39", tone: "success" } : { text: formatRate(m.rate), tone: m.rate > 1 ? "info" : "neutral" };
      return {
        provider,
        id: m.key,
        name: m.displayName,
        inputModalities: m.isVision === true ? ["text", "image"] : ["text"],
        ...m.description !== void 0 ? { description: m.description } : {},
        badge
      };
    });
  }
  /**
   * 单个模型的元信息。
   *
   * 这里如实反映上游给的能力：视觉、思考档位、真实上下文窗口。
   * 少报一样，用户在选择器里就少一个能用的开关。
   */
  resolveModel(provider, model) {
    const entry = this.#models.find((m) => m.key === model);
    const levels = entry?.efforts ?? [];
    const reasoning = levels.length > 0 ? {
      efforts: levels.map((id) => ({ id, name: effortName(id) })),
      ...entry?.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}
    } : void 0;
    const chosen = this.#prefs?.windowFor(model) ?? 0;
    const contextWindow = chosen > 0 ? chosen : entry?.maxInputTokens ?? entry?.defaultWindow ?? DEFAULT_CONTEXT_WINDOW;
    return {
      provider,
      id: model,
      name: entry?.displayName ?? model,
      inputModalities: entry?.isVision === true ? ["text", "image"] : ["text"],
      context: {
        contextWindow
      },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      ...reasoning !== void 0 ? { reasoning } : {}
    };
  }
  /** DSH 在调用前拿模型信息与流函数。 */
  async prepareCall(provider, model, _signal) {
    if (this.#modelsAt === 0) await this.refreshModels(false);
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.stream(options)
    };
  }
  /**
   * 发起一次流式请求。
   *
   * 容错策略照 magpie：**插件只负责把失败如实分类上报，重试交给宿主**。
   * 唯一自己做的一件事是「换账号」——这是多账号场景特有的，且只在
   * 还没吐出内容时进行。
   */
  async *stream(options) {
    const accounts = this.#store.list();
    if (accounts.length === 0) {
      throw new Error("qwenwork: \u8FD8\u6CA1\u6709\u767B\u5F55\u8D26\u53F7\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u9875\u5B8C\u6210\u8BBE\u5907\u7801\u767B\u5F55");
    }
    if (this.#modelsAt === 0) await this.refreshModels(false);
    const entry = this.#models.find((m) => m.key === options.model);
    if (!entry) {
      const source = this.#modelsAt === 0 ? "\u5185\u7F6E\u5FEB\u7167" : "\u4E0A\u6E38\u76EE\u5F55";
      throw new Error(
        `qwenwork: \u672A\u77E5\u6A21\u578B "${options.model}"\uFF08\u5F53\u524D${source}\u91CC\u6CA1\u6709\uFF1B\u53EF\u7528\uFF1A${this.#models.map((m) => m.key).join(", ")}\uFF09`
      );
    }
    const order = [...accounts.keys()].map((k) => (this.#cursor + k) % accounts.length);
    let lastError = null;
    let lastAccount;
    for (const index of order) {
      const account = accounts[index];
      lastAccount = account;
      for (let attempt = 0; ; attempt++) {
        let touched = false;
        try {
          for await (const chunk of this.#streamOnce(account, entry, options)) {
            if (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") {
              touched = true;
            }
            yield chunk;
          }
          this.#cursor = index;
          return;
        } catch (error) {
          if (touched) throw this.#describe(error, account);
          if (error instanceof UpstreamError) {
            if ((error.code === "MODEL_POOL_BUSY" || error.code === "SERVER") && attempt < POOL_RETRIES) {
              const wait = (error.retryAfter ?? TRANSIENT_WAIT) * 1e3;
              await sleep2(Math.min(wait, POOL_MAX_WAIT_MS));
              continue;
            }
            if (isWorthAnotherAccount(error)) {
              lastError = error;
              break;
            }
          }
          throw this.#describe(error, account);
        }
      }
    }
    throw this.#describe(lastError, lastAccount);
  }
  // ── 内部 ──────────────────────────────────────────────────────────────
  /**
   * 拉一次上游真实模型目录。
   *
   * 失败不算致命：继续用当前目录（可能是兜底快照），下次再试。
   * 并发调用共享同一次请求。
   *
   * 返回刷新后的目录，供设置页直接把结果画出来。目录内容真的变了
   * （增删模型、改价、改上下文档位、开关视觉/思考）时触发
   * {@link QwenWorkAdapterOptions.onModelsChanged}，让宿主重载选择器——
   * 否则用户点了刷新、页面也说成功了，模型列表还是旧的。
   *
   * @param force 跳过 TTL，强制回源
   */
  async refreshModels(force = false) {
    if (!force && Date.now() - this.#modelsAt < LIST_TTL_MS) return this.#models;
    if (this.#refreshing !== null) return this.#refreshing;
    this.#refreshing = (async () => {
      try {
        const accounts = this.#store.list();
        const account = accounts[0];
        if (account === void 0) return this.#models;
        const url = this.#gateway + LIST_PATH;
        const headers = {
          ...cosyHeadersForList(url, account),
          Accept: "application/json"
        };
        const res = await fetch(url, { headers });
        if (!res.ok) return this.#models;
        const parsed = await res.json();
        const models = parseModelListing(parsed);
        if (models.length === 0) return this.#models;
        const changed = !sameCatalog(this.#models, models);
        this.#models = models;
        this.#modelsAt = Date.now();
        if (changed) this.#notifyModelsChanged();
        return this.#models;
      } catch {
        return this.#models;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }
  /** 通知宿主目录变了。回调抛错不能影响刷新本身。 */
  #notifyModelsChanged() {
    try {
      this.#onModelsChanged?.(this.#models);
    } catch {
    }
  }
  /** 用指定账号跑一次。 */
  async *#streamOnce(account, entry, options) {
    const sessionId = sessionOf(options.sessionId ?? "", options);
    const requestId = randomUUID4();
    const task = taskOf(sessionId, options);
    const refs = [];
    const inlineUrls = [];
    for (const message of options.messages) {
      const found = collectImageRefs(message.content);
      refs.push(...found.refs);
      inlineUrls.push(...found.inlineUrls);
    }
    const totalImages = refs.length + inlineUrls.length;
    if (totalImages > 0 && entry.isVision !== true) {
      throw new UpstreamError({
        status: 400,
        message: `\u6A21\u578B "${entry.displayName}" \u4E0D\u63A5\u53D7\u56FE\u7247\u8F93\u5165`,
        code: "INVALID_REQUEST"
      });
    }
    const read = await resolveImages(refs, this.#attachments, options.signal);
    let resolved = read.images;
    const withImages = totalImages > 0 && resolved.size > 0;
    let degraded = false;
    for (let round = 0; ; round++) {
      const body = buildBody(
        options,
        entry,
        sessionId,
        requestId,
        task,
        this.#prefs?.windowFor(entry.key) ?? 0,
        degraded ? void 0 : resolved,
        read.failed > 0 ? { failed: read.failed, ...read.reason !== void 0 ? { reason: read.reason } : {} } : void 0
      );
      try {
        yield* this.#post(account, entry, body, options.signal);
        markTaskAnswered(task);
        return;
      } catch (error) {
        if (!degraded && withImages && round === 0 && error instanceof UpstreamError && (error.code === "SERVER" || error.code === "INVALID_REQUEST")) {
          degraded = true;
          resolved = /* @__PURE__ */ new Map();
          continue;
        }
        throw error;
      }
    }
  }
  /** 发一次构造好的请求体，把流吐出来。 */
  async *#post(account, entry, body, signal) {
    const wire = encodeBody(JSON.stringify(body));
    const url = this.#gateway + CHAT_PATH;
    const headers = chatHeaders(url, account, wire, entry.key, entry.source ?? "system");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: wire,
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw UpstreamError.from(res.status, text.trim() || `HTTP ${res.status}`);
      }
      if (!res.body) throw UpstreamError.from(502, "qwenwork: \u54CD\u5E94\u6CA1\u6709 body");
      yield* toStreamChunks(res.body, entry.displayName);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  /** 给用户看的错误：带上账号标签，方便判断是哪个号出问题。 */
  #describe(error, account) {
    if (error instanceof UpstreamError) {
      const who = account?.label ? `\uFF08\u8D26\u53F7 ${account.label}\uFF09` : "";
      return new Error(`qwenwork${who}: ${error.message} [${error.code}]`);
    }
    if (error instanceof Error) {
      if (error.name === "AbortError") return error;
      return error;
    }
    return new Error(`qwenwork: ${String(error)}`);
  }
};
function isWorthAnotherAccount(e) {
  return e.code === "AUTH" || e.code === "QUOTA_EXCEEDED";
}
function sameCatalog(a, b) {
  if (a.length !== b.length) return false;
  const pick = (m) => JSON.stringify([
    m.key,
    m.displayName,
    m.description ?? "",
    m.rate ?? 0,
    m.rateWas ?? 0,
    m.free === true,
    m.isVision === true,
    m.isReasoning === true,
    m.efforts ?? [],
    m.defaultEffort ?? "",
    m.maxInputTokens ?? 0,
    m.windows ?? [],
    m.defaultWindow ?? 0
  ]);
  const left = a.map(pick).sort();
  const right = b.map(pick).sort();
  return left.every((v, i) => v === right[i]);
}
function effortName(id) {
  const names = {
    none: "\u4E0D\u601D\u8003",
    minimal: "\u6781\u7B80",
    low: "\u4F4E",
    medium: "\u4E2D",
    high: "\u9AD8",
    xhigh: "\u6781\u9AD8",
    max: "\u6700\u5927",
    ultra: "\u6781\u81F4"
  };
  return names[id] ?? id;
}
function cosyHeadersForList(url, account) {
  return {
    ...cosyHeaders(url, account, ""),
    ...clientHeaders(),
    "Cosy-Scene": "qwork"
  };
}

// src/adapter/prefs.ts
import { readFile as readFile2, writeFile as writeFile2, mkdir as mkdir2, rename as rename2 } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
var AUTO_WINDOW = 0;
var PrefsStore = class {
  #path;
  #windows = {};
  #loaded = false;
  constructor(dataDir) {
    this.#path = join2(dataDir, "prefs.json");
    this.#primeSync();
  }
  /** 同步读盘。失败（含首次运行无文件）一律当作空偏好。 */
  #primeSync() {
    try {
      const raw = readFileSync(this.#path, "utf8");
      this.#applyParsed(JSON.parse(raw));
    } catch {
    }
  }
  /** 把解析结果并进内存表（两边共用的校验逻辑）。 */
  #applyParsed(parsed) {
    const windows = parsed?.windows;
    if (windows !== null && windows !== void 0 && typeof windows === "object") {
      for (const [key, value] of Object.entries(windows)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          this.#windows[key] = Math.floor(value);
        }
      }
    }
  }
  get path() {
    return this.#path;
  }
  async load() {
    if (this.#loaded) return;
    try {
      const raw = await readFile2(this.#path, "utf8");
      this.#applyParsed(JSON.parse(raw));
    } catch {
    }
    this.#loaded = true;
  }
  /** 某模型固定的档位；0 表示自动。 */
  windowFor(model) {
    return this.#windows[model] ?? AUTO_WINDOW;
  }
  /** 全部偏好（给设置页读）。 */
  all() {
    return { ...this.#windows };
  }
  /** 设置某模型的档位；传 0 恢复自动。 */
  async setWindow(model, tokens) {
    await this.load();
    const key = model.trim();
    if (key === "") throw new Error("qwenwork: \u6A21\u578B key \u4E0D\u80FD\u4E3A\u7A7A");
    const value = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : AUTO_WINDOW;
    if (value === AUTO_WINDOW) delete this.#windows[key];
    else this.#windows[key] = value;
    await this.#flush();
  }
  /** 原子写。 */
  async #flush() {
    await mkdir2(dirname2(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    const payload = { version: 1, windows: this.#windows };
    await writeFile2(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename2(tmp, this.#path);
  }
};

// src/index.ts
var name = "dsh-qwenwork-connector";
var inject = ["llm"];
var API_PREFIX = "/api/qwenwork";
function resolveConfig(config = {}) {
  const explicit = config.dataDir?.trim();
  const dataDir = explicit && explicit !== "" ? explicit : join3(homedir(), ".dsh-qwenwork-connect");
  return {
    providerId: config.providerId?.trim() || "qwenwork",
    displayName: config.displayName?.trim() || "\u5343\u95EE\u529E\u516C",
    gateway: (config.gateway?.trim() || GATEWAY).replace(/\/+$/, ""),
    dataDir
  };
}
function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const ready = Promise.resolve({ version: "adapter" });
  try {
    return start(ctx, config, logger, ready);
  } catch (error) {
    logger.error(
      `dsh-qwenwork-connector: \u542F\u52A8\u5931\u8D25\uFF1A${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    return { ready };
  }
}
function start(ctx, config, logger, ready) {
  const cfg = resolveConfig(config);
  if (!ctx.llm || typeof ctx.llm.registerAdapter !== "function") {
    logger.error("dsh-qwenwork-connector: llm \u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u9002\u914D\u5668\u65E0\u6CD5\u6CE8\u518C");
    return { ready };
  }
  const store = new AccountStore(cfg.dataDir);
  const prefs = new PrefsStore(cfg.dataDir);
  const attachments = readAttachments(ctx);
  if (attachments === void 0) {
    logger.warn("dsh-qwenwork-connector: \u9644\u4EF6\u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u56FE\u7247\u6D88\u606F\u5C06\u65E0\u6CD5\u53D1\u9001");
  }
  const adapter = new QwenWorkAdapter({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    gateway: cfg.gateway,
    store,
    prefs,
    ...attachments !== void 0 ? { attachments } : {},
    // 上游目录变了就广播给宿主。
    //
    // 宿主按 `llm/models-updated(provider)` 约定重载模型选择器
    // （见 dsh-llm 的 provider 文档）；不发这个事件的话，插件内部
    // 拉到再新的目录，已打开的会话选择器也一直显示旧列表——
    // 表现就是「刷新了还是那几个模型」，跟上写死没区别。
    onModelsChanged: (models) => {
      const detail = { provider: cfg.providerId, count: models.length };
      emitSafe(ctx, "llm/models-updated", cfg.providerId, detail);
      emitSafe(ctx, "llm/adapters-updated", cfg.providerId, detail);
      logger.info(`dsh-qwenwork-connector: \u6A21\u578B\u76EE\u5F55\u5DF2\u66F4\u65B0\uFF0C${models.length} \u4E2A\u6A21\u578B`);
    }
  });
  try {
    ctx.llm.registerAdapter([cfg.providerId], adapter);
    logger.info(`dsh-qwenwork-connector: \u5DF2\u6CE8\u518C provider "${cfg.providerId}"\uFF08${MODELS.length} \u4E2A\u6A21\u578B\uFF09`);
  } catch (error) {
    logger.error(
      `dsh-qwenwork-connector: provider "${cfg.providerId}" \u6CE8\u518C\u5931\u8D25\uFF08\u53EF\u80FD\u4E0E\u5DF2\u88C5\u63D2\u4EF6\u540C\u540D\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
    return { ready };
  }
  void store.load().then(async (accounts) => {
    if (accounts.length === 0) {
      logger.info("dsh-qwenwork-connector: \u8FD8\u6CA1\u6709\u767B\u5F55\u8D26\u53F7\uFF0C\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 \u5343\u95EE\u529E\u516C\u300D\u5B8C\u6210\u8BBE\u5907\u7801\u767B\u5F55");
    } else {
      logger.info(`dsh-qwenwork-connector: \u5DF2\u52A0\u8F7D ${accounts.length} \u4E2A\u8D26\u53F7`);
      await adapter.refreshModels(true).catch(() => {
      });
      logger.info(`dsh-qwenwork-connector: \u6A21\u578B\u76EE\u5F55 ${adapter.models.length} \u9879\uFF08\u6765\u81EA\u4E0A\u6E38\u5B9E\u6D4B\uFF09`);
    }
  }).catch((error) => {
    logger.error(`dsh-qwenwork-connector: \u8D26\u53F7\u52A0\u8F7D\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  });
  installRoutes(ctx, cfg, store, prefs, adapter, logger);
  return { ready };
}
function emitSafe(ctx, event, ...args) {
  try {
    ctx.emit?.(event, ...args);
  } catch {
  }
}
function readAttachments(ctx) {
  try {
    const service = typeof ctx.get === "function" ? ctx.get("attachments") : void 0;
    const store = service;
    if (store !== void 0 && typeof store.readImageRequest === "function") return store;
    return void 0;
  } catch {
    return void 0;
  }
}
function installRoutes(ctx, cfg, store, prefs, adapter, logger) {
  if (typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["connection"], (cctx) => {
      const connection = cctx.connection;
      const register = connection?.fetch?.register;
      if (typeof register !== "function") {
        logger.warn("dsh-qwenwork-connector: connection fetch \u6CE8\u518C\u8868\u4E0D\u53EF\u7528\uFF0C\u8BBE\u7F6E\u9875 API \u5DF2\u7981\u7528");
        return;
      }
      const json = (status, payload) => new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
      const disposers = [];
      const registerRoute = (path, methods, handler) => {
        try {
          disposers.push(
            register({
              path,
              methods,
              requestBody: "buffered",
              fetch: handler
            })
          );
        } catch (error) {
          logger.warn(
            `dsh-qwenwork-connector: ${path} \u6CE8\u518C\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
          );
        }
      };
      registerRoute(`${API_PREFIX}/status`, ["GET"], async () => {
        await store.load();
        await prefs.load();
        const models = adapter.models.map((m) => ({
          id: m.key,
          name: m.displayName,
          description: m.description,
          rate: m.rate,
          rateWas: m.rateWas,
          free: m.free,
          vision: m.isVision === true,
          reasoning: m.isReasoning === true,
          efforts: m.efforts ?? [],
          maxInputTokens: m.maxInputTokens,
          windows: m.windows ?? [],
          defaultWindow: m.defaultWindow,
          // 用户当前选定的档位；0 = 自动
          window: prefs.windowFor(m.key)
        }));
        return json(200, {
          ok: true,
          providerId: cfg.providerId,
          displayName: cfg.displayName,
          models,
          accounts: store.list().map((a) => ({
            uid: a.uid,
            label: a.label ?? a.uid,
            plan: a.plan,
            balance: a.balance,
            expires: a.expires,
            quota: a.quota,
            renewsAt: a.renewsAt,
            period: a.period,
            syncedAt: a.syncedAt
          }))
        });
      });
      registerRoute(`${API_PREFIX}/account/sync`, ["POST"], async () => {
        await store.load();
        const { accounts, errors } = await store.sync(cfg.gateway);
        const lastFetch = adapter.modelsFetchedAt;
        let modelsRefreshed = false;
        try {
          await adapter.refreshModels(true);
          modelsRefreshed = adapter.modelsFetchedAt !== lastFetch;
        } catch (error) {
          errors.push(
            `\u6A21\u578B\u5217\u8868\u5237\u65B0\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
          );
        }
        logger.info(
          `dsh-qwenwork-connector: \u540C\u6B65\u8D26\u53F7 ${accounts.length} \u4E2A\uFF0C\u5931\u8D25 ${errors.length} \u4E2A\uFF0C\u6A21\u578B\u76EE\u5F55 ${adapter.models.length} \u9879\uFF08${modelsRefreshed ? "\u5DF2\u56DE\u6E90" : "\u672A\u56DE\u6E90\uFF0C\u6CBF\u7528\u7F13\u5B58"}\uFF09`
        );
        return json(200, {
          ok: errors.length === 0,
          accounts: accounts.map((a) => ({
            uid: a.uid,
            label: a.label ?? a.uid,
            plan: a.plan,
            balance: a.balance,
            expires: a.expires,
            quota: a.quota,
            renewsAt: a.renewsAt,
            period: a.period,
            syncedAt: a.syncedAt
          })),
          // 顺带把新目录带回去，界面不用再打一次 /status
          models: adapter.models.map((m) => ({
            id: m.key,
            name: m.displayName,
            description: m.description,
            rate: m.rate,
            rateWas: m.rateWas,
            free: m.free,
            vision: m.isVision === true,
            reasoning: m.isReasoning === true,
            efforts: m.efforts ?? [],
            maxInputTokens: m.maxInputTokens,
            windows: m.windows ?? [],
            defaultWindow: m.defaultWindow,
            window: prefs.windowFor(m.key)
          })),
          modelsRefreshed,
          errors
        });
      });
      registerRoute(`${API_PREFIX}/window`, ["POST"], async (request) => {
        try {
          const body = await request.json().catch(() => ({}));
          const model = String(body.model ?? "").trim();
          if (model === "") return json(400, { ok: false, error: "model \u5FC5\u586B" });
          const raw = Number(body.window);
          const window = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AUTO_WINDOW;
          await adapter.setWindowPreference(model, window);
          logger.info(`dsh-qwenwork-connector: ${model} \u4E0A\u4E0B\u6587\u6863\u4F4D\u8BBE\u4E3A ${window === 0 ? "\u81EA\u52A8" : window}`);
          return json(200, { ok: true, model, window });
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      registerRoute(`${API_PREFIX}/models/refresh`, ["POST"], async () => {
        try {
          await adapter.refreshModels(true);
          return json(200, {
            ok: true,
            models: adapter.models.map((m) => ({ id: m.key, name: m.displayName, rate: m.rate, vision: m.isVision === true, reasoning: m.isReasoning === true }))
          });
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      registerRoute(`${API_PREFIX}/login`, ["POST"], async () => {
        try {
          const signIn = startDeviceSignIn(cfg.gateway);
          void signIn.wait().then(async (account) => {
            await store.upsert(account);
            logger.info(`dsh-qwenwork-connector: \u8D26\u53F7\u5DF2\u767B\u5F55 ${account.label ?? account.uid}`);
            await adapter.refreshModels(true).catch(() => {
            });
          }).catch((error) => {
            logger.warn(
              `dsh-qwenwork-connector: \u767B\u5F55\u672A\u5B8C\u6210\uFF1A${error instanceof Error ? error.message : String(error)}`
            );
          });
          return json(200, { ok: true, url: signIn.url, instructions: signIn.instructions });
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      registerRoute(`${API_PREFIX}/logout`, ["POST"], async (request) => {
        try {
          const body = await request.json().catch(() => ({}));
          const uid = String(body.uid ?? "").trim();
          if (uid === "") return json(400, { ok: false, error: "uid \u5FC5\u586B" });
          await store.remove(uid);
          logger.info(`dsh-qwenwork-connector: \u8D26\u53F7\u5DF2\u79FB\u9664 ${uid}`);
          return json(200, { ok: true });
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
      logger.info(`dsh-qwenwork-connector: \u8BBE\u7F6E\u9875 API \u5DF2\u6302\u8F7D\u5728 ${API_PREFIX}`);
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
            }
          }
        });
      }
      return void 0;
    });
  } catch (error) {
    logger.warn(
      `dsh-qwenwork-connector: \u8BBE\u7F6E\u9875 API \u4E0D\u53EF\u7528\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
  }
}
export {
  AccountStore,
  GATEWAY,
  MODELS,
  QwenWorkAdapter,
  apply,
  inject,
  name,
  resolveConfig,
  startDeviceSignIn
};
//# sourceMappingURL=index.js.map

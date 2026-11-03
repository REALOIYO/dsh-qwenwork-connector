window.__ModuleLoader__.load({
  id: "dsh-qwenwork-connector",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  NS: () => NS,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/i18n.ts
var import_react = require("react");
var NS = "dsh-qwenwork-connector";
var ZH = {
  nav: "\u5343\u95EE\u529E\u516C",
  title: "\u5343\u95EE\u529E\u516C",
  intro: "\u7528\u4F60\u7684\u5343\u95EE\u529E\u516C\u8BA2\u9605\uFF0C\u5728 DSH \u91CC\u76F4\u63A5\u8C03\u7528\u5B83\u63D0\u4F9B\u7684\u6A21\u578B\u3002\u767B\u5F55\u4E00\u6B21\u5373\u53EF\uFF0C\u4E0D\u9700\u8981\u5B89\u88C5\u5343\u95EE\u529E\u516C\u5BA2\u6237\u7AEF\u3002",
  accountSection: "\u8D26\u53F7",
  login: "\u767B\u5F55",
  loggingIn: "\u7B49\u5F85\u6388\u6743\u2026",
  loginPending: "\u5DF2\u751F\u6210\u6388\u6743\u94FE\u63A5\uFF0C\u8BF7\u5728\u6D4F\u89C8\u5668\u91CC\u5B8C\u6210\u767B\u5F55\u5E76\u6388\u6743\u3002",
  openLink: "\u6253\u5F00\u6388\u6743\u9875\u9762",
  copyLink: "\u590D\u5236\u94FE\u63A5",
  copied: "\u5DF2\u590D\u5236",
  loginWaiting: "\u6B63\u5728\u7B49\u5F85\u6D4F\u89C8\u5668\u6388\u6743\uFF08\u6700\u591A 15 \u5206\u949F\uFF09\u2026",
  loginSuccess: "\u767B\u5F55\u6210\u529F",
  loginFailed: "\u767B\u5F55\u5931\u8D25",
  noAccount: "\u8FD8\u6CA1\u6709\u767B\u5F55\u8D26\u53F7\u3002",
  noAccountHint: "\u70B9\u300C\u767B\u5F55\u300D\u540E\u4F1A\u751F\u6210\u4E00\u4E2A\u6388\u6743\u94FE\u63A5\uFF0C\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00\u5E76\u6388\u6743\u5373\u53EF\u3002",
  logout: "\u79FB\u9664",
  logoutConfirm: "\u786E\u5B9A\u8981\u79FB\u9664\u8FD9\u4E2A\u8D26\u53F7\u5417\uFF1F",
  refresh: "\u5237\u65B0",
  expiresAt: "\u6709\u6548\u671F\u81F3",
  plan: "\u5957\u9910",
  balance: "\u4F59\u989D",
  renewsAt: "\u4E0B\u6B21\u7EED\u8D39",
  syncedAt: "\u540C\u6B65\u4E8E",
  refreshed: "\u5DF2\u540C\u6B65",
  exceeded: "\u989D\u5EA6\u5DF2\u7528\u5C3D",
  modelSection: "\u53EF\u7528\u6A21\u578B",
  modelHint: "\u8FD9\u4E9B\u662F\u5343\u95EE\u529E\u516C\u5F53\u524D\u63D0\u4F9B\u7684\u6A21\u578B\uFF0C\u767B\u5F55\u540E\u5373\u53EF\u5728\u6A21\u578B\u9009\u62E9\u5668\u91CC\u9009\u5230\u3002\u500D\u7387\u662F\u76F8\u5BF9\u6807\u51C6\u4EF7\u7684\u500D\u6570\uFF0C\u8D8A\u4F4E\u8D8A\u4FBF\u5B9C\u3002",
  free: "\u514D\u8D39",
  vision: "\u53EF\u770B\u56FE",
  thinking: "\u4F1A\u601D\u8003",
  maxInput: "\u6700\u5927\u8F93\u5165",
  contextWindow: "\u4E0A\u4E0B\u6587",
  contextAuto: "\u81EA\u52A8",
  cancel: "\u53D6\u6D88",
  error: "\u51FA\u9519\u4E86",
  retry: "\u91CD\u8BD5",
  loading: "\u52A0\u8F7D\u4E2D\u2026"
};
var EN = {
  nav: "QwenWork",
  title: "QwenWork",
  intro: "Use your QwenWork subscription to call its models from DSH. Sign in once \u2014 no QwenWork desktop app needed.",
  accountSection: "Account",
  login: "Sign in",
  loggingIn: "Waiting for authorization\u2026",
  loginPending: "Authorization link created. Finish signing in in your browser.",
  openLink: "Open authorization page",
  copyLink: "Copy link",
  copied: "Copied",
  loginWaiting: "Waiting for browser authorization (up to 15 minutes)\u2026",
  loginSuccess: "Signed in",
  loginFailed: "Sign-in failed",
  noAccount: "No account signed in yet.",
  noAccountHint: 'Press "Sign in" to get an authorization link, then open it in your browser.',
  logout: "Remove",
  logoutConfirm: "Remove this account?",
  refresh: "Refresh",
  expiresAt: "Expires",
  plan: "Plan",
  balance: "Balance",
  renewsAt: "Renews",
  syncedAt: "Synced",
  refreshed: "Synced at",
  exceeded: "Quota exhausted",
  modelSection: "Available models",
  modelHint: "Models QwenWork offers right now. The multiplier is relative to standard pricing \u2014 lower is cheaper.",
  free: "free",
  vision: "vision",
  thinking: "thinking",
  maxInput: "max input",
  contextWindow: "Context",
  contextAuto: "Auto",
  cancel: "Cancel",
  error: "Error",
  retry: "Retry",
  loading: "Loading\u2026"
};
var runtime;
function setLocaleRuntime(next) {
  runtime = next;
}
function isZh() {
  try {
    const active = runtime?.getSnapshot?.()?.active ?? "";
    if (active === "") return true;
    return /^zh/i.test(active);
  } catch {
    return true;
  }
}
function text(key, params) {
  const dict = isZh() ? ZH : EN;
  let value = dict[key] ?? ZH[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v));
  }
  return value;
}
function useLocaleRevision() {
  return (0, import_react.useSyncExternalStore)(
    (listener) => {
      try {
        return runtime?.subscribe?.(listener) ?? (() => {
        });
      } catch {
        return () => {
        };
      }
    },
    () => {
      try {
        return runtime?.getSnapshot?.()?.revision ?? 0;
      } catch {
        return 0;
      }
    },
    () => 0
  );
}

// src/client/nav-icon.ts
var NAV_ICON_MARKER = "data-dsh-qwenwork-nav-icon";
var NAV_ROW_SELECTOR = '[role="dialog"] nav button';
var QWEN_PATH = "M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z";
function qwenMaskSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#000"><path fill-rule="nonzero" d="${QWEN_PATH}"/></svg>`;
}
function qwenMaskUrl(svg = qwenMaskSvg()) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function isOwnNavRow(rowText, wantedLabel) {
  const wanted = String(wantedLabel ?? "").trim();
  if (wanted.length === 0) return false;
  return String(rowText ?? "").trim() === wanted;
}
function navIconCss(maskUrl) {
  return [
    `[${NAV_ICON_MARKER}] > svg { display: none; }`,
    `[${NAV_ICON_MARKER}]::before {`,
    `  content: '';`,
    `  flex: none;`,
    `  width: 18px;`,
    `  height: 18px;`,
    `  background-color: currentColor;`,
    `  -webkit-mask-image: url("${maskUrl}");`,
    `  mask-image: url("${maskUrl}");`,
    `  -webkit-mask-repeat: no-repeat;`,
    `  mask-repeat: no-repeat;`,
    `  -webkit-mask-position: center;`,
    `  mask-position: center;`,
    `  -webkit-mask-size: 18px 18px;`,
    `  mask-size: 18px 18px;`,
    `}`
  ].join("\n");
}
function installSettingsNavIcon(ctx, resolveLabel) {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-qwenwork-connector";
    tag.dataset.pluginCss = "dsh-qwenwork-connector/settings-nav-icon";
    tag.textContent = navIconCss(qwenMaskUrl());
    document.head.appendChild(tag);
    let disposed = false;
    let scheduled = false;
    const sync = () => {
      scheduled = false;
      if (disposed) return;
      const wanted = resolveLabel();
      for (const row of Array.from(document.querySelectorAll(NAV_ROW_SELECTOR))) {
        if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, "");
        else row.removeAttribute(NAV_ICON_MARKER);
      }
    };
    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(sync);
    };
    sync();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      disposed = true;
      observer.disconnect();
      for (const row of Array.from(document.querySelectorAll(`[${NAV_ICON_MARKER}]`))) {
        row.removeAttribute(NAV_ICON_MARKER);
      }
      tag.remove();
    };
  }, "dsh-qwenwork-connector: settings nav icon");
}

// src/client/page.tsx
var import_react2 = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var REQUEST_TIMEOUT_MS = 3e4;
var POLL_INTERVAL_MS = 2e3;
var LOGIN_WAIT_MS = 15 * 60 * 1e3;
function formatRate(rate) {
  if (rate === void 0 || !Number.isFinite(rate) || rate <= 0) return "";
  return `${Number(rate.toFixed(2))}\xD7`;
}
function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1e6) {
    const m = tokens / 1e6;
    return `${Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1e3) {
    const k = tokens / 1e3;
    return `${Number(k.toFixed(0))}K`;
  }
  return String(tokens);
}
var css = {
  section: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 780, paddingBottom: 32 },
  title: { margin: 0, fontSize: 22, lineHeight: "30px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
  intro: { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-secondary)" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 18,
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 12,
    background: "var(--dsw-alias-bg-layer-1)"
  },
  cardTitle: { margin: 0, fontSize: 15, lineHeight: "22px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  hint: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
  error: { margin: 0, whiteSpace: "pre-wrap", color: "var(--dsw-alias-state-danger-label, var(--dsw-alias-label-error))" },
  ok: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-state-success-label, var(--dsw-alias-label-primary))" },
  mono: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    wordBreak: "break-all",
    color: "var(--dsw-alias-label-secondary)"
  },
  account: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "12px 14px",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 10,
    background: "var(--dsw-alias-bg-layer-2, transparent)"
  },
  models: { display: "flex", flexWrap: "wrap", gap: 8 },
  modelRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "10px 12px",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: 10
  },
  select: {
    padding: "4px 8px",
    borderRadius: 6,
    fontSize: 12,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-2, transparent)",
    color: "var(--dsw-alias-label-primary)"
  },
  chip: {
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid var(--dsw-alias-border-l2)",
    color: "var(--dsw-alias-label-secondary)"
  }
};
async function request(path, method = "GET", body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      headers: body === void 0 ? void 0 : { "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: controller.signal,
      credentials: "same-origin"
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(raw?.error ?? `HTTP ${res.status}`);
    return raw;
  } finally {
    clearTimeout(timer);
  }
}
function Btn(props) {
  const { children, onClick, disabled, primary } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      onClick,
      disabled,
      style: {
        padding: "6px 14px",
        borderRadius: 8,
        fontSize: 13,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        border: primary ? "none" : "1px solid var(--dsw-alias-border-l2)",
        background: primary ? "var(--dsw-alias-label-primary)" : "transparent",
        color: primary ? "var(--dsw-alias-bg-layer-1)" : "var(--dsw-alias-label-primary)"
      },
      children
    }
  );
}
function QwenWorkSettings() {
  useLocaleRevision();
  const [status, setStatus] = (0, import_react2.useState)(null);
  const [error, setError] = (0, import_react2.useState)("");
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [loginUrl, setLoginUrl] = (0, import_react2.useState)("");
  const [waiting, setWaiting] = (0, import_react2.useState)(false);
  const [copied, setCopied] = (0, import_react2.useState)(false);
  const [syncedAt, setSyncedAt] = (0, import_react2.useState)("");
  const baseline = (0, import_react2.useRef)(0);
  const pollTimer = (0, import_react2.useRef)(null);
  const loginDeadline = (0, import_react2.useRef)(0);
  const load = (0, import_react2.useCallback)(async () => {
    try {
      const data = await request("/api/qwenwork/status");
      setStatus(data);
      setError("");
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);
  (0, import_react2.useEffect)(() => {
    void load();
  }, [load]);
  const stopPolling = (0, import_react2.useCallback)(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setWaiting(false);
  }, []);
  (0, import_react2.useEffect)(() => stopPolling, [stopPolling]);
  const startLogin = (0, import_react2.useCallback)(async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const current = await load();
      baseline.current = current?.accounts.length ?? 0;
      const data = await request("/api/qwenwork/login", "POST");
      if (!data.ok || !data.url) throw new Error(data.error ?? text("loginFailed"));
      setLoginUrl(data.url);
      setWaiting(true);
      loginDeadline.current = Date.now() + LOGIN_WAIT_MS;
      if (pollTimer.current !== null) clearInterval(pollTimer.current);
      pollTimer.current = setInterval(async () => {
        if (Date.now() > loginDeadline.current) {
          stopPolling();
          setError(text("loginFailed"));
          return;
        }
        const next = await load();
        if (next && next.accounts.length > baseline.current) {
          stopPolling();
          setLoginUrl("");
          setBusy(false);
        }
      }, POLL_INTERVAL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [load, stopPolling]);
  const copyUrl = (0, import_react2.useCallback)(async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2e3);
    } catch {
      setError("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u94FE\u63A5\u590D\u5236");
    }
  }, [loginUrl]);
  const removeAccount = (0, import_react2.useCallback)(
    async (uid) => {
      if (!window.confirm(text("logoutConfirm"))) return;
      setBusy(true);
      try {
        await request("/api/qwenwork/logout", "POST", { uid });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load]
  );
  const setWindow = (0, import_react2.useCallback)(
    async (model, tokens) => {
      setBusy(true);
      try {
        await request("/api/qwenwork/window", "POST", { model, window: tokens });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load]
  );
  const syncAccounts = (0, import_react2.useCallback)(async () => {
    setBusy(true);
    setSyncedAt("");
    try {
      const data = await request("/api/qwenwork/account/sync", "POST", {});
      setStatus((prev) => prev === null ? prev : { ...prev, accounts: data.accounts });
      if (data.errors.length > 0) setError(data.errors.join("\n"));
      else {
        setError("");
        setSyncedAt((/* @__PURE__ */ new Date()).toLocaleTimeString());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const accounts = status?.accounts ?? [];
  const models = status?.models ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.section, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: css.title, children: text("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.intro, children: text("intro") }),
    error !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.error, children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: css.cardTitle, children: text("accountSection") }),
      waiting ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.hint, children: text("loginPending") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.mono, children: loginUrl }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            Btn,
            {
              primary: true,
              onClick: () => {
                window.open(loginUrl, "_blank", "noopener,noreferrer");
              },
              children: text("openLink")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: copyUrl, children: copied ? text("copied") : text("copyLink") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: stopPolling, children: text("cancel") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.hint, children: text("loginWaiting") })
      ] }) : accounts.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.hint, children: text("noAccount") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.hint, children: text("noAccountHint") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.row, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { primary: true, onClick: startLogin, disabled: busy, children: busy ? text("loggingIn") : text("login") }) })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        accounts.map((a) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.account, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: a.label }),
            a.plan !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.chip, children: [
              text("plan"),
              ": ",
              a.plan
            ] }),
            a.balance !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.chip, children: [
              text("balance"),
              ": ",
              a.balance
            ] }),
            a.quota?.exceeded === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...css.chip, color: "var(--dsw-alias-label-error)" }, children: text("exceeded") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.hint, children: a.expires ? `${text("expiresAt")} ${new Date(a.expires).toLocaleString()}` : "" }),
            a.renewsAt !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.hint, children: [
              text("renewsAt"),
              " ",
              new Date(a.renewsAt).toLocaleDateString()
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: () => void removeAccount(a.uid), disabled: busy, children: text("logout") })
          ] }),
          a.syncedAt !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.mono, children: [
            text("syncedAt"),
            " ",
            new Date(a.syncedAt).toLocaleString()
          ] })
        ] }, a.uid)),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: startLogin, disabled: busy, children: busy ? text("loggingIn") : text("login") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: () => void syncAccounts(), disabled: busy, children: text("refresh") }),
          syncedAt !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.ok, children: [
            text("refreshed"),
            " ",
            syncedAt
          ] })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: css.cardTitle, children: text("modelSection") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.hint, children: text("modelHint") }),
      status === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: css.hint, children: text("loading") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", flexDirection: "column", gap: 10 }, children: models.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.modelRow, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: m.name }),
            m.rate !== void 0 && m.rate > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.chip, children: [
              m.rateWas !== void 0 && m.rateWas > m.rate && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("s", { style: { opacity: 0.6, marginRight: 4 }, children: formatRate(m.rateWas) }),
              formatRate(m.rate)
            ] }),
            m.free === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.chip, children: text("free") }),
            m.vision === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.chip, children: text("vision") }),
            m.reasoning === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.chip, children: text("thinking") })
          ] }),
          m.description !== void 0 && m.description !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.hint, children: m.description }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.hint, children: [
            m.id,
            m.maxInputTokens !== void 0 && m.maxInputTokens > 0 ? ` \xB7 ${text("maxInput")} ${formatTokens(m.maxInputTokens)}` : ""
          ] })
        ] }),
        (m.windows ?? []).length > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.hint, children: text("contextWindow") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              value: String(m.window ?? 0),
              disabled: busy,
              onChange: (e) => void setWindow(m.id, Number(e.target.value)),
              style: css.select,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "0", children: text("contextAuto") }),
                (m.windows ?? []).map((w) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: String(w), children: formatTokens(w) }, w))
              ]
            }
          )
        ] })
      ] }, m.id)) })
    ] })
  ] });
}

// src/client/index.ts
function registerDictionaries(ctx) {
  try {
    ctx.locale.register(NS, { zh: ZH, en: EN });
    return;
  } catch {
  }
  try {
    ctx.locale.register(NS, "zh", ZH);
    ctx.locale.register(NS, "en", EN);
  } catch {
  }
}
function apply(ctx) {
  setLocaleRuntime(ctx.locale);
  if (typeof ctx.effect === "function") {
    try {
      ctx.effect(
        () => {
          registerDictionaries(ctx);
          return () => {
            setLocaleRuntime(void 0);
          };
        },
        "dsh-qwenwork-connector: locale dictionaries"
      );
    } catch {
      registerDictionaries(ctx);
    }
  } else {
    registerDictionaries(ctx);
  }
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "dsh-qwenwork-connector",
        order: 13,
        locale: NS,
        label: () => text("nav")
      },
      QwenWorkSettings
    )
  );
  if (typeof ctx.effect === "function") {
    try {
      installSettingsNavIcon(
        ctx,
        () => text("nav")
      );
    } catch {
    }
  }
}
var inject = ["slots", "locale"];

    return module.exports;
  }
});
//# sourceMappingURL=client.js.map

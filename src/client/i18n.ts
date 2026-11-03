/**
 * 插件的文案表。
 *
 * 只做中英两套，key 用扁平命名。DSH 的 locale 服务会按 namespace 注册，
 * 页面里通过 `text()` 读。
 *
 * @module src/client/i18n.ts
 */

import { useSyncExternalStore } from 'react'

/** locale namespace，和插件 id 区分开（避免与其他插件撞）。 */
export const NS = 'qwenwork-connect'

type Dict = Record<string, string>

export const ZH: Dict = {
  nav: '千问办公',
  title: '千问办公',
  intro: '用你的千问办公订阅，在 DSH 里直接调用它提供的模型。登录一次即可，不需要安装千问办公客户端。',

  accountSection: '账号',
  login: '登录',
  loggingIn: '等待授权…',
  loginPending: '已生成授权链接，请在浏览器里完成登录并授权。',
  openLink: '打开授权页面',
  copyLink: '复制链接',
  copied: '已复制',
  loginWaiting: '正在等待浏览器授权（最多 15 分钟）…',
  loginSuccess: '登录成功',
  loginFailed: '登录失败',
  noAccount: '还没有登录账号。',
  noAccountHint: '点「登录」后会生成一个授权链接，在浏览器里打开并授权即可。',
  logout: '移除',
  logoutConfirm: '确定要移除这个账号吗？',
  refresh: '刷新',
  expiresAt: '有效期至',
  plan: '套餐',
  balance: '余额',

  modelSection: '可用模型',
  modelHint: '这些是千问办公当前提供的模型，登录后即可在模型选择器里选到。',

  cancel: '取消',
  error: '出错了',
  retry: '重试',
  loading: '加载中…',
}

export const EN: Dict = {
  nav: 'QwenWork',
  title: 'QwenWork',
  intro: 'Use your QwenWork subscription to call its models from DSH. Sign in once — no QwenWork desktop app needed.',

  accountSection: 'Account',
  login: 'Sign in',
  loggingIn: 'Waiting for authorization…',
  loginPending: 'Authorization link created. Finish signing in in your browser.',
  openLink: 'Open authorization page',
  copyLink: 'Copy link',
  copied: 'Copied',
  loginWaiting: 'Waiting for browser authorization (up to 15 minutes)…',
  loginSuccess: 'Signed in',
  loginFailed: 'Sign-in failed',
  noAccount: 'No account signed in yet.',
  noAccountHint: 'Press "Sign in" to get an authorization link, then open it in your browser.',
  logout: 'Remove',
  logoutConfirm: 'Remove this account?',
  refresh: 'Refresh',
  expiresAt: 'Expires',
  plan: 'Plan',
  balance: 'Balance',

  modelSection: 'Available models',
  modelHint: 'Models QwenWork offers right now. They appear in the model picker once signed in.',

  cancel: 'Cancel',
  error: 'Error',
  retry: 'Retry',
  loading: 'Loading…',
}

/** locale 服务的最小面（不 import 宿主包）。 */
export interface LocaleRuntime {
  register(ns: string, dicts: { zh: Dict; en: Dict }): unknown
  subscribe?(listener: () => void): () => void
  getSnapshot?(): { active?: string; revision?: number }
}

let runtime: LocaleRuntime | undefined

/** 记下 locale 服务，供 `text()` 判当前语言。 */
export function setLocaleRuntime(next: LocaleRuntime | undefined): void {
  runtime = next
}

/** 当前是否中文。判不出来就按中文（本插件主要面向中文用户）。 */
function isZh(): boolean {
  try {
    const active = runtime?.getSnapshot?.()?.active ?? ''
    if (active === '') return true
    return /^zh/i.test(active)
  } catch {
    return true
  }
}

/**
 * 取一条文案。
 * @param key 文案 key
 * @param params 替换 `{name}` 形式的占位
 */
export function text(key: string, params?: Record<string, string | number>): string {
  const dict = isZh() ? ZH : EN
  let value = dict[key] ?? ZH[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v))
  }
  return value
}

/** 语言变化时触发重渲染，避免切语言后页面还显示旧文案。 */
export function useLocaleRevision(): number {
  return useSyncExternalStore(
    (listener) => {
      try {
        return runtime?.subscribe?.(listener) ?? (() => {})
      } catch {
        return () => {}
      }
    },
    () => {
      try {
        return runtime?.getSnapshot?.()?.revision ?? 0
      } catch {
        return 0
      }
    },
    () => 0,
  )
}

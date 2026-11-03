/**
 * 千问办公设置页。
 *
 * 侧边栏入口由 `settings.section` 注册，这个组件就是那个入口打开的内容。
 * 三件事：登录（设备码）、看已登录账号、看可用模型。
 *
 * 不 import 宿主的 `@deepseek-ai/*` 组件库——只用一个受控的 button/div 组合，
 * 样式走 DSH 的 CSS 变量（`--dsw-alias-*`），这样不会因为宿主版本升级而崩。
 *
 * @module src/client/page.tsx
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { text, useLocaleRevision } from './i18n.ts'

/** 后端给的状态。 */
interface StatusPayload {
  ok: boolean
  providerId: string
  displayName: string
  models: Array<{ id: string; name: string }>
  accounts: Array<{
    uid: string
    label: string
    plan?: string
    balance?: string
    expires?: number
  }>
}

/** 后端返回的登录响应。 */
interface LoginPayload {
  ok: boolean
  url?: string
  instructions?: string
  error?: string
}

/** 一次请求的超时，避免卡死在「等待中」。 */
const REQUEST_TIMEOUT_MS = 30_000
/** 登录后轮询状态的间隔。 */
const POLL_INTERVAL_MS = 2000
/** 登录等待上限（与后端一致）。 */
const LOGIN_WAIT_MS = 15 * 60 * 1000

const css = {
  section: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 780, paddingBottom: 32 } as const,
  title: { margin: 0, fontSize: 22, lineHeight: '30px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as const,
  intro: { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' } as const,
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 18,
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)',
  } as const,
  cardTitle: { margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as const,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const,
  hint: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' } as const,
  error: { margin: 0, whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-state-danger-label, var(--dsw-alias-label-error))' } as const,
  ok: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-state-success-label, var(--dsw-alias-label-primary))' } as const,
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    wordBreak: 'break-all' as const,
    color: 'var(--dsw-alias-label-secondary)',
  },
  account: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    padding: '12px 14px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
  },
  models: { display: 'flex', flexWrap: 'wrap' as const, gap: 8 },
  chip: {
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 12,
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
  },
} as const

/** 带超时的 JSON 请求。 */
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
    })
    const raw = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(raw?.error ?? `HTTP ${res.status}`)
    return raw
  } finally {
    clearTimeout(timer)
  }
}

/** 一个简单的按钮（不依赖宿主组件库）。 */
function Btn(props: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  primary?: boolean
}): React.ReactElement {
  const { children, onClick, disabled, primary } = props
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 14px',
        borderRadius: 8,
        fontSize: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        background: primary ? 'var(--dsw-alias-label-primary)' : 'transparent',
        color: primary ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-label-primary)',
      }}
    >
      {children}
    </button>
  )
}

/** 设置页主体。 */
export function QwenWorkSettings(): React.ReactElement {
  useLocaleRevision()

  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loginUrl, setLoginUrl] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [copied, setCopied] = useState(false)
  /** 登录开始时的账号数：用来判断有没有新账号进来。 */
  const baseline = useRef(0)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const loginDeadline = useRef(0)

  const load = useCallback(async () => {
    try {
      const data = await request<StatusPayload>('/api/qwenwork/status')
      setStatus(data)
      setError('')
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 停掉轮询。 */
  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    setWaiting(false)
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  /** 开始登录：拿授权地址，然后轮询账号是否出现。 */
  const startLogin = useCallback(async () => {
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      const current = await load()
      baseline.current = current?.accounts.length ?? 0

      const data = await request<LoginPayload>('/api/qwenwork/login', 'POST')
      if (!data.ok || !data.url) throw new Error(data.error ?? text('loginFailed'))
      setLoginUrl(data.url)
      setWaiting(true)
      loginDeadline.current = Date.now() + LOGIN_WAIT_MS

      if (pollTimer.current !== null) clearInterval(pollTimer.current)
      pollTimer.current = setInterval(async () => {
        if (Date.now() > loginDeadline.current) {
          stopPolling()
          setError(text('loginFailed'))
          return
        }
        const next = await load()
        if (next && next.accounts.length > baseline.current) {
          stopPolling()
          setLoginUrl('')
          setBusy(false)
        }
      }, POLL_INTERVAL_MS)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }, [load, stopPolling])

  /** 复制授权链接。 */
  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(loginUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('复制失败，请手动选中链接复制')
    }
  }, [loginUrl])

  /** 移除一个账号。 */
  const removeAccount = useCallback(
    async (uid: string) => {
      if (!window.confirm(text('logoutConfirm'))) return
      setBusy(true)
      try {
        await request('/api/qwenwork/logout', 'POST', { uid })
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const accounts = status?.accounts ?? []
  const models = status?.models ?? []

  return (
    <div style={css.section}>
      <h2 style={css.title}>{text('title')}</h2>
      <p style={css.intro}>{text('intro')}</p>

      {error !== '' && <p style={css.error}>{error}</p>}

      {/* 登录卡片 */}
      <div style={css.card}>
        <h3 style={css.cardTitle}>{text('accountSection')}</h3>

        {waiting ? (
          <>
            <p style={css.hint}>{text('loginPending')}</p>
            <p style={css.mono}>{loginUrl}</p>
            <div style={css.row}>
              <Btn
                primary
                onClick={() => {
                  window.open(loginUrl, '_blank', 'noopener,noreferrer')
                }}
              >
                {text('openLink')}
              </Btn>
              <Btn onClick={copyUrl}>{copied ? text('copied') : text('copyLink')}</Btn>
              <Btn onClick={stopPolling}>{text('cancel')}</Btn>
            </div>
            <p style={css.hint}>{text('loginWaiting')}</p>
          </>
        ) : accounts.length === 0 ? (
          <>
            <p style={css.hint}>{text('noAccount')}</p>
            <p style={css.hint}>{text('noAccountHint')}</p>
            <div style={css.row}>
              <Btn primary onClick={startLogin} disabled={busy}>
                {busy ? text('loggingIn') : text('login')}
              </Btn>
            </div>
          </>
        ) : (
          <>
            {accounts.map(a => (
              <div key={a.uid} style={css.account}>
                <div style={css.row}>
                  <strong style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>{a.label}</strong>
                  {a.plan !== undefined && (
                    <span style={css.chip}>
                      {text('plan')}: {a.plan}
                    </span>
                  )}
                  {a.balance !== undefined && (
                    <span style={css.chip}>
                      {text('balance')}: {a.balance}
                    </span>
                  )}
                </div>
                <div style={css.row}>
                  <span style={css.hint}>
                    {a.expires ? `${text('expiresAt')} ${new Date(a.expires).toLocaleString()}` : ''}
                  </span>
                  <Btn onClick={() => void removeAccount(a.uid)} disabled={busy}>
                    {text('logout')}
                  </Btn>
                </div>
              </div>
            ))}
            <div style={css.row}>
              <Btn onClick={startLogin} disabled={busy}>
                {busy ? text('loggingIn') : text('login')}
              </Btn>
              <Btn onClick={() => void load()} disabled={busy}>
                {text('refresh')}
              </Btn>
            </div>
          </>
        )}
      </div>

      {/* 模型卡片 */}
      <div style={css.card}>
        <h3 style={css.cardTitle}>{text('modelSection')}</h3>
        <p style={css.hint}>{text('modelHint')}</p>
        {status === null ? (
          <p style={css.hint}>{text('loading')}</p>
        ) : (
          <div style={css.models}>
            {models.map(m => (
              <span key={m.id} style={css.chip}>
                {m.name} · {m.id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

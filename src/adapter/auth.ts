/**
 * QwenWork 的登录与账号持久化。
 *
 * 用客户端自己的 PKCE 设备码流程，不需要安装千问办公：
 *
 *   1. 生成 verifier 与 challenge（SHA-256 + base64url），以及一个 nonce
 *   2. 打开浏览器到 {web}/device/selectAccounts?...
 *   3. 每 2 秒问一次 /api/v1/deviceToken/poll，直到拿到 token
 *   4. 设备 token 本身就是 chat token（不走 jobToken 交换）
 *   5. 读 account-context 拿 uid / plan / quota
 *
 * 移植自 `@magpie-community/opencode-qoder-auth@0.2.59`（MIT），
 * 原实现 `deviceSignIn` / `openapi` / `deviceExpiry`。
 *
 * @module src/adapter/auth.ts
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { QWENWORK_CLIENT_ID, clientHeaders, newMachineId, type QwenWorkAccount } from './cosy.ts'

/** 千问办公网关，公开云固定这一个。 */
export const GATEWAY = 'https://gateway.qwenwork.cn'

/** 登录页所在站点（与网关同域，但路径不同）。 */
export const WEB = 'https://gateway.qwenwork.cn'

/** 桌面客户端注册的私有回调协议。只用于拼参数，不需要真的能唤起。 */
const REDIRECT = 'qwenwork-cn://'

/** 设备码有效期，超时即放弃。 */
const SIGN_IN_TIMEOUT = 15 * 60 * 1000
/** 轮询间隔（默认 2 秒，测试可调小）。 */
const DEFAULT_POLL_INTERVAL = 2000

/** 一个已登录的账号。 */
export interface StoredAccount extends QwenWorkAccount {
  /** 登录时记得的显示名便于分辨多个账号。 */
  label?: string
  /** 套餐名，来自 account-context。 */
  plan?: string
  /** 剩余额度文案，来自 account-context。 */
  balance?: string
  /** 结构化配额：总额度可能为 null（套餐按次计费），所以都允许缺省。 */
  quota?: AccountQuota
  /** 套餐下次扣费/续期时间（毫秒）。 */
  renewsAt?: number
  /** 套餐周期，如 monthly。 */
  period?: string
  /** 上次成功同步账号信息的时间（毫秒），0/缺省表示从未同步过。 */
  syncedAt?: number
}

/** account-context 里的 quota 段。 */
export interface AccountQuota {
  total?: number
  used?: number
  remaining?: number
  exceeded?: boolean
}

/** 从上游读回来的一份账号现状。 */
export interface AccountContext {
  uid: string
  name: string
  email: string
  plan?: string
  quota?: AccountQuota
  renewsAt?: number
  period?: string
  /** 展示用余额文案，如 `1234.57 credits`。 */
  balance?: string
}

/** 落盘格式。 */
interface StoredFile {
  version: 1
  accounts: StoredAccount[]
}

const b64url = (buf: Buffer): string => buf.toString('base64url')

/** 一次设备码登录的进度句柄。 */
export interface DeviceSignIn {
  /** 让用户打开并授权的地址。 */
  url: string
  /** 给用户看的说明。 */
  instructions: string
  /** 等到用户授权完成，返回账号；超时或失败则抛错。 */
  wait(): Promise<StoredAccount>
}

/**
 * 打开一次设备码登录。
 *
 * 返回后立刻可以拿到 `url` 给用户；`wait()` 会一直轮询到成功或超时。
 * 轮询期间的网络抖动不会中断流程（吞掉后重试），只有超时和明确的失败会抛。
 *
 * @param gateway      网关地址
 * @param pollInterval 轮询间隔毫秒，测试可调小
 */
export function startDeviceSignIn(gateway = GATEWAY, pollInterval = DEFAULT_POLL_INTERVAL): DeviceSignIn {
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const nonce = randomUUID()
  const machineId = newMachineId()

  const q = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: QWENWORK_CLIENT_ID,
    redirect_uri: REDIRECT,
  })

  const until = Date.now() + SIGN_IN_TIMEOUT

  return {
    url: `${WEB}/device/selectAccounts?${q}`,
    instructions: '在浏览器里登录千问办公并授权本设备',
    async wait(): Promise<StoredAccount> {
      let device: DeviceToken | null = null
      let lastError = ''

      while (device === null) {
        if (Date.now() > until) {
          throw new Error(`qwenwork: 登录超时，请重新开始${lastError ? `（最后错误：${lastError}）` : ''}`)
        }
        try {
          const r = await openapi(gateway, '/api/v1/deviceToken/poll', {
            query: { nonce, verifier, challenge_method: 'S256' },
          })
          const body = r.json as {
            token?: unknown
            errorCode?: unknown
            errorMessage?: unknown
          } | null
          if (r.status === 200 && String(body?.token ?? '').trim() !== '') {
            device = body as DeviceToken
            break
          }
          // 404 + 空 body 是「还没授权」的常态（实测如此），继续轮询。
          // 只有上游明确说这次设备流无效/过期才立刻失败——
          // 否则用户会一直干等到超时也拿不到原因。
          const errorCode = String(body?.errorCode ?? '')
          if (errorCode === 'INVALID_DEVICE_FLOW' || errorCode === 'EXPIRED' || errorCode === 'DENIED') {
            const said = String(body?.errorMessage ?? r.text).slice(0, 200)
            throw new Error(`qwenwork: 设备流无效（${errorCode}）：${said}`)
          }
          // 403 是明确的拒绝（不是「还没授权」）
          if (r.status === 403) {
            throw new Error(`qwenwork: 授权被拒绝（HTTP 403）：${r.text.trim().slice(0, 200)}`)
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('qwenwork:')) throw error
          lastError = error instanceof Error ? error.message : String(error)
        }
        await sleep(pollInterval)
      }

      const token = String(device.token).trim()
      let uid = String(device.user_id ?? '').trim()
      let email = ''
      let name = String(device.user_name ?? '')
      let plan: string | undefined
      let balance: string | undefined
      let quota: AccountQuota | undefined
      let renewsAt: number | undefined
      let period: string | undefined

      // account-context 是拿 uid 与额度的权威来源；拿不到不算致命，
      // 但 uid 是签名必需的（Cosy-User），没有就没法聊天
      try {
        const ctx = await readAccountContext(gateway, token)
        uid = ctx.uid || uid
        email = ctx.email
        name = ctx.name || name
        plan = ctx.plan
        balance = ctx.balance
        quota = ctx.quota
        renewsAt = ctx.renewsAt
        period = ctx.period
      } catch {
        // 读不到额度不影响登录本身
      }

      if (uid === '') {
        throw new Error('qwenwork: 登录没有返回用户 id，无法签名请求；请重试')
      }

      return {
        uid,
        access: token,
        refresh: String(device.refresh_token ?? ''),
        expires: deviceExpiry(device),
        name,
        email,
        machineId,
        ...(plan !== undefined ? { plan } : {}),
        ...(balance !== undefined ? { balance } : {}),
        ...(quota !== undefined ? { quota } : {}),
        ...(renewsAt !== undefined ? { renewsAt } : {}),
        ...(period !== undefined ? { period } : {}),
        syncedAt: Date.now(),
        label: email || name || uid,
      }
    },
  }
}

/**
 * 读一次 account-context，返回账号现状。
 *
 * 登录和「刷新额度」共用这一处，避免两套解析逻辑漂移。
 * 上游返回的 `quota.total` 对按次套餐常为 null，因此全部字段都按可选处理。
 *
 * @param gateway 网关地址
 * @param token   Bearer token
 */
export async function readAccountContext(gateway: string, token: string): Promise<AccountContext> {
  const r = await openapi(gateway, '/api/v1/adapter/user/account-context?include=user,plan,quota', { token })
  if (r.status < 200 || r.status >= 300) {
    // 401 是明确的「token 失效」，要让调用方知道得重新登录
    if (r.status === 401) throw new Error('qwenwork: 登录已失效，请重新登录')
    throw new Error(`qwenwork: 读取账号信息失败（HTTP ${r.status}）`)
  }

  const data = unwrap(r.json)
  const user = (data.user ?? data) as Record<string, unknown>
  const uid = String(user?.id ?? user?.user_id ?? user?.uid ?? '').trim()
  const email = String(user?.email ?? '')
  const name = String(user?.name ?? user?.username ?? '')

  const p = data.plan as Record<string, unknown> | undefined
  const plan = typeof p?.name === 'string' && p.name.trim() !== '' ? p.name : undefined
  const period = typeof p?.period === 'string' && p.period.trim() !== '' ? p.period : undefined
  const dueAt = Date.parse(String(p?.next_due_date ?? '').trim())
  const renewsAt = Number.isNaN(dueAt) ? undefined : dueAt

  const q = data.quota as Record<string, unknown> | undefined
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const quota: AccountQuota | undefined =
    q === undefined || q === null
      ? undefined
      : {
          ...(num(q.total) !== undefined ? { total: num(q.total) } : {}),
          ...(num(q.used) !== undefined ? { used: num(q.used) } : {}),
          ...(num(q.remaining) !== undefined ? { remaining: num(q.remaining) } : {}),
          ...(typeof q.exceeded === 'boolean' ? { exceeded: q.exceeded } : {}),
        }

  return {
    uid,
    name,
    email,
    ...(plan !== undefined ? { plan } : {}),
    ...(quota !== undefined ? { quota } : {}),
    ...(renewsAt !== undefined ? { renewsAt } : {}),
    ...(period !== undefined ? { period } : {}),
    // 保留两位小数就够了，900 位小数没意义
    ...(quota?.remaining !== undefined ? { balance: `${round2(quota.remaining)} credits` } : {}),
  }
}

/**
 * 额度数字转文案：整数不带小数位，其余保留两位。
 *
 * 上游返回的是浮点（实际见过 1234.5678），全按两位展示；但 900 这种整数
 * 写成 `900.00` 只是噪音。
 */
function round2(n: number): string {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toFixed(2)
}

/** poll 返回的 token 结构（只取用到的字段）。 */
interface DeviceToken {
  token?: string
  refresh_token?: string
  expires_at?: string
  expires_in?: number
  user_id?: string
  user_name?: string
  [key: string]: unknown
}

/** 过期时间：优先 expires_at，其次 expires_in，兜底一天。 */
function deviceExpiry(dt: DeviceToken): number {
  const at = Date.parse(String(dt?.expires_at ?? '').trim())
  if (!Number.isNaN(at)) return at
  const secs = Number(dt?.expires_in)
  if (Number.isFinite(secs) && secs > 0) return Date.now() + secs * 1000
  return Date.now() + 24 * 60 * 60 * 1000
}

/** 信封的 data 字段，没有就直接是自身。 */
function unwrap(v: unknown): Record<string, unknown> {
  const o = v as Record<string, unknown> | null
  if (o && typeof o.data === 'object' && o.data !== null && !Array.isArray(o.data)) {
    return o.data as Record<string, unknown>
  }
  return o ?? {}
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * 一次普通的网关调用（非聊天）：带上客户端身份头，可选 bearer。
 *
 * 不抛网络错误为异常，而是返回可判读的结果——登录取证过程里很多失败
 * 是可以忽略的。
 */
async function openapi(
  gateway: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const url = new URL(gateway + path)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...clientHeaders(),
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

/** 账号存储：一个 JSON 文件，原子写入。 */
export class AccountStore {
  readonly #path: string
  #accounts: StoredAccount[] = []
  #loaded = false

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'accounts.json')
  }

  get path(): string {
    return this.#path
  }

  async load(): Promise<StoredAccount[]> {
    if (this.#loaded) return this.#accounts
    try {
      const raw = await readFile(this.#path, 'utf8')
      const parsed = JSON.parse(raw) as StoredFile
      this.#accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    } catch {
      // 首次运行没有文件是正常的
      this.#accounts = []
    }
    this.#loaded = true
    return this.#accounts
  }

  list(): StoredAccount[] {
    return [...this.#accounts]
  }

  /** 按 uid 找账号（同一账号重复登录时覆盖）。 */
  find(uid: string): StoredAccount | undefined {
    return this.#accounts.find(a => a.uid === uid)
  }

  async upsert(account: StoredAccount): Promise<void> {
    await this.load()
    const at = this.#accounts.findIndex(a => a.uid === account.uid)
    if (at >= 0) this.#accounts[at] = { ...this.#accounts[at], ...account }
    else this.#accounts.push(account)
    await this.#flush()
  }

  async remove(uid: string): Promise<void> {
    await this.load()
    this.#accounts = this.#accounts.filter(a => a.uid !== uid)
    await this.#flush()
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
  async sync(gateway: string): Promise<{ accounts: StoredAccount[]; errors: string[] }> {
    await this.load()
    const errors: string[] = []
    let dirty = false

    for (const account of this.#accounts) {
      try {
        const ctx = await readAccountContext(gateway, account.access)
        // token 还在，但上游说 uid 变了属异常，保留原 uid 以免会话/缓存错乱
        if (ctx.plan !== undefined) account.plan = ctx.plan
        if (ctx.balance !== undefined) account.balance = ctx.balance
        if (ctx.quota !== undefined) account.quota = ctx.quota
        if (ctx.renewsAt !== undefined) account.renewsAt = ctx.renewsAt
        if (ctx.period !== undefined) account.period = ctx.period
        if (ctx.name !== '') account.name = ctx.name
        if (ctx.email !== '') account.email = ctx.email
        account.syncedAt = Date.now()
        dirty = true
      } catch (error) {
        errors.push(`${account.label ?? account.uid}：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (dirty) await this.#flush()
    return { accounts: this.list(), errors }
  }

  /** 原子写：先写临时文件再 rename，避免中断留下半个 JSON。 */
  async #flush(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${process.pid}.tmp`
    const payload: StoredFile = { version: 1, accounts: this.#accounts }
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.#path)
  }
}

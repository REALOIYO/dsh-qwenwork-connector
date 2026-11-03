/**
 * QwenWork 的 COSY 信封签名。
 *
 * 千问办公的每个聊天请求都带一个 `Authorization: Bearer COSY.<payload>.<sig>`，
 * 这是它桌面客户端自己的鉴权层（内部叫 cosy）。签名过程：
 *
 *   1. 把账号信息打包成明文，用一次性的 AES-128-CBC 加密（密钥即 IV）
 *      → blob.info；该密钥再用 RSA 公钥加密 → blob.key
 *   2. payload = base64(JSON{v1, requestId, info, cosyVersion, ideVersion:""})
 *   3. sig = md5(`${payload}\n${blob.key}\n${ts}\n${body}\n${path}`)
 *
 * 移植自 `@magpie-community/opencode-qoder-auth@0.2.59`（MIT），
 * 原实现 `userBlob` / `cosyHeaders` / `chatHeaders`。
 *
 * 这一层只依赖 `node:crypto` 与本机信息，不发网络请求，可以用伪造账号单测。
 *
 * @module src/adapter/cosy.ts
 */

import {
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  randomUUID,
  constants,
} from 'node:crypto'
import { hostname, platform, arch } from 'node:os'

/**
 * QwenWork 桌面客户端内置的 1024 位 RSA 公钥。
 *
 * 它只用来包裹每次请求的 AES 密钥，不参与内容加密，所以是公开常量。
 * 抄自客户端，服务端按这个验签——**这不是可配置项，改了就签不过**。
 */
export const QWENWORK_RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** 桌面客户端版本，请求头与信封里都要自称这个版本。 */
export const QWENWORK_APP = { version: '1.2.1', release: '1.2.1-26092107' } as const

/** 客户端自己的 client_id（设备码流程用）。 */
export const QWENWORK_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'

/**
 * 信封自称的 cosy 版本。
 *
 * QwenWork 复用了 Qoder 那套协议，这个值是协议层的版本号，不是 QwenWork
 * 客户端的版本。客户端升级时未必变，但服务端要求匹配。
 */
export const COSY_VERSION = '1.1.59'

/** 聊天时服务端为此账号签发的身份。 */
export interface QwenWorkAccount {
  /** 账号 uid，`Cosy-User` 用。 */
  uid: string
  /** 设备码换来的 access token（同时就是 chat token）。 */
  access: string
  /** 设备 token 的刷新令牌。 */
  refresh?: string
  /** 过期时间（毫秒时间戳）。 */
  expires?: number
  /** 名字，进信封明文。 */
  name?: string
  /** 邮箱，进信封明文。 */
  email?: string
  /**
   * 机器标识。客户端用自己的 machine id，服务端把它当设备指纹。
   * 首次登录时生成并持久化——**同账号必须稳定**，否则像是换了设备。
   */
  machineId: string
}

/** 一次请求的签名结果：Authorization 值与配套头。 */
export interface SignedHeaders {
  Authorization: string
  [key: string]: string
}

/**
 * 把账号信息打成客户端那样的信封明文：
 * AES-128-CBC 加密（密钥=IV），密钥再用 RSA 公钥包裹。
 */
function userBlob(account: QwenWorkAccount): { info: string; key: string } {
  const raw = JSON.stringify({
    uid: account.uid,
    aid: '',
    name: account.name ?? '',
    email: account.email ?? '',
    security_oauth_token: account.access,
  })
  const key = Buffer.from(randomBytes(8).toString('hex').slice(0, 16))
  const cipher = createCipheriv('aes-128-cbc', key, key)
  const info = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]).toString('base64')
  const wrapped = publicEncrypt({ key: QWENWORK_RSA_KEY, padding: constants.RSA_PKCS1_PADDING }, key).toString('base64')
  return { info, key: wrapped }
}

/**
 * 机器标识，客户端用 `Node 的 process.platform`，并只改写 x64/arm64。
 * 服务端把它记进 `Cosy-MachineOS`。
 */
export function machineOS(a: string = arch(), p: string = platform()): string {
  const renamed = ({ x64: 'x86_64', arm64: 'aarch64' } as Record<string, string>)[a] ?? a
  return `${renamed}_${p}`
}

/**
 * 聊天请求带的主机名（`Cosy-MachineHostname`）。
 *
 * 只发可打印 ASCII；不是的话转 punycode，再不行就清洗并带原文哈希，
 * 最长 96 字符。空名不发（返回空串）。
 */
export function machineHostname(name: string = hostname()): string {
  const trimmed = String(name ?? '').trim()
  if (trimmed === '') return ''
  const CAP = 96
  const hash = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 8)
  const cap = (v: string): string => {
    if (v.length <= CAP) return v
    const head = v.slice(0, CAP - 8 - 1).replace(/[-\s]+$/u, '')
    return head ? `${head}-${hash(v)}` : `unknown-${hash(v)}`
  }
  const HOST_SAFE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u
  if (HOST_SAFE.test(trimmed)) return cap(trimmed)

  // 非 ASCII：先试 punycode（域名式的主机名常见这种情况）
  try {
    const ascii = new URL(`http://${trimmed}`).hostname
    if (ascii !== '' && HOST_SAFE.test(ascii)) return cap(ascii)
  } catch {
    // 不是合法主机名，走下面的清洗
  }
  const safe = trimmed.replace(/[^\x21-\x7e]+/gu, '-').replace(/-{2,}/gu, '-').replace(/^-+|-+$/gu, '')
  return cap(safe ? `${safe}-${hash(trimmed)}` : `unknown-${hash(trimmed)}`)
}

/**
 * 生成一次请求的签名头（不含聊天专有的 `X-Model-*`）。
 *
 * @param url  请求的完整 URL；签名里的 path 会自动去掉 `/algo` 前缀
 * @param body 请求体在 wire 上的**最终形态**（编码后的字符串）——签名对的就是它
 * @param ts   秒级时间戳，默认当前时间
 */
export function cosyHeaders(
  url: string,
  account: QwenWorkAccount,
  body: string,
  ts: number = Math.floor(Date.now() / 1000),
): SignedHeaders {
  if (!account.machineId) throw new Error('qwenwork: 账号缺少 machineId，需要重新登录')
  const blob = userBlob(account)
  const payload = Buffer.from(
    JSON.stringify({
      version: 'v1',
      requestId: randomUUID(),
      info: blob.info,
      cosyVersion: COSY_VERSION,
      ideVersion: '',
    }),
  ).toString('base64')

  let path = new URL(url).pathname
  // 签名的 path 不带 /algo 前缀，客户端就是这么算的
  if (path.startsWith('/algo')) path = path.slice(5)

  const sig = createHash('md5').update(`${payload}\n${blob.key}\n${ts}\n${body}\n${path}`).digest('hex')
  const m = account.machineId

  return {
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/json',
    Authorization: `Bearer COSY.${payload}.${sig}`,
    'Cosy-Business-Product': 'qoder_work',
    'Cosy-Business-Type': 'agent',
    'Cosy-ClientIp': m,
    'Cosy-ClientType': '6',
    'Cosy-Data-Policy': 'disagree',
    'Cosy-Date': String(ts),
    'Cosy-Key': blob.key,
    'Cosy-MachineId': m,
    'Cosy-MachineToken': m,
    'Cosy-MachineType': '5',
    'Cosy-MachineOS': machineOS(),
    'Cosy-Scene': 'qwork',
    'Cosy-User': account.uid,
    'Cosy-Version': COSY_VERSION,
    'Login-Version': 'v2',
  }
}

/**
 * 聊天请求的头。
 *
 * 与普通调用有三处差异（客户端 `prepareInferRequest` 就是这么改的）：
 * 去掉 `Cosy-ClientIp`，`Cosy-MachineToken`/`Cosy-MachineType` 换成设备
 * 身份（没有就不发），并带上主机名。另外加 `X-Model-Key`。
 *
 * @param modelKey 请求的模型 key（如 `qwen3.8-max-preview`）
 * @param source   模型来源，客户端报 `system`
 */
export function chatHeaders(
  url: string,
  account: QwenWorkAccount,
  body: string,
  modelKey: string,
  source = 'system',
): SignedHeaders {
  const h = cosyHeaders(url, account, body)
  delete h['Cosy-ClientIp']
  delete h['Cosy-MachineToken']
  delete h['Cosy-MachineType']
  const host = machineHostname()
  if (host) h['Cosy-MachineHostname'] = host
  return {
    ...h,
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Model-Key': modelKey,
    'X-Model-Source': source,
  }
}

/**
 * 非聊天（登录取证 / 用量 / 模型列表）调用带的那组客户端身份头。
 *
 * 没有这些，服务端不认请求来自官方客户端。
 */
export function clientHeaders(): Record<string, string> {
  const { version, release } = QWENWORK_APP
  return {
    'User-Agent': `qoderwork/${version}`,
    'X-Request-Id': randomUUID(),
    'X-QwenWork-Version': version,
    'X-QwenWork-Release-Version': release,
    'X-QwenWork-Build': release.split('-')[1] ?? '',
    'X-QwenWork-Platform': platform(),
    'X-QwenWork-Arch': arch(),
    'X-QwenWork-Channel': 'stable',
  }
}

/** 生成一个新的机器标识（首次登录时用，之后必须持久化）。 */
export function newMachineId(): string {
  return randomUUID()
}

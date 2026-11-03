/**
 * dsh-qwenwork-connect — 插件入口。
 *
 * 把千问办公（QwenWork）的模型注册为 DSH 的 LlmAdapter。
 *
 * 设计取向：**不依赖任何宿主 `@deepseek-ai/*` 包**，只用结构化类型对接
 * `ctx.llm.registerAdapter`。这样插件不会被内核版本绑死，也让沙箱里
 * 可以脱离宿主单测（见 test/qwenwork.test.ts）。
 *
 * @module src/index.ts
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

import { AccountStore, startDeviceSignIn, GATEWAY, type StoredAccount } from './adapter/auth.ts'
import { QwenWorkAdapter, MODELS } from './adapter/qwenwork.ts'

/** 插件名，同时是 cordis 里的 id。 */
export const name = 'dsh-qwenwork-connect'

/** 唯一硬依赖：模型服务。没有它插件无法工作。 */
export const inject = ['llm'] as const

/** 结构化的宿主 ctx，避免 import 内核包。 */
export interface PluginContext {
  logger: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  /** 发布拓扑变更通知，让浏览器重读模型列表。 */
  emit?(event: string, ...args: unknown[]): unknown
  /** cordis 的依赖注入：等服务就绪后执行。 */
  inject?(deps: string[], fn: (ctx: Record<string, unknown>) => unknown): unknown
  effect?(fn: () => () => void): unknown
  get?(key: string): unknown
}

/** 插件配置。 */
export interface PluginConfig {
  /** 注册到 DSH 的 provider id。改名会让已有会话指向失效。 */
  providerId?: string
  /** 模型选择器里的分组名。 */
  displayName?: string
  /** 网关地址。 */
  gateway?: string
  /** 状态目录（账号、日志）。 */
  dataDir?: string
}

/** 设置页用的 REST 路由前缀。 */
const API_PREFIX = '/api/qwenwork'

/** 解析后的配置。 */
interface Resolved {
  providerId: string
  displayName: string
  gateway: string
  dataDir: string
}

/**
 * 解析配置。数据目录默认 `~/.dsh-qwenwork-connect`，**与 DSH 主体分开**：
 * 账号凭证不写进 profile，避免被 profile 的清理或迁移波及。
 */
export function resolveConfig(config: PluginConfig = {}): Resolved {
  const explicit = config.dataDir?.trim()
  const dataDir = explicit && explicit !== '' ? explicit : join(homedir(), '.dsh-qwenwork-connect')
  return {
    providerId: config.providerId?.trim() || 'qwenwork',
    displayName: config.displayName?.trim() || '千问办公',
    gateway: (config.gateway?.trim() || GATEWAY).replace(/\/+$/, ''),
    dataDir,
  }
}

/** 插件返回给宿主的句柄。 */
export interface PluginHandle {
  ready: Promise<{ version: string }>
}

/**
 * 插件加载入口。
 *
 * 启动顺序有讲究：
 *   1. 立刻注册适配器——模型选择器要马上能看到 provider，哪怕账号还没加载
 *   2. 后台加载账号
 *   3. 挂设置路由
 */
export function apply(ctx: PluginContext, config: PluginConfig = {}): PluginHandle {
  const logger = ctx.logger
  const cfg = resolveConfig(config)
  const ready = Promise.resolve({ version: 'adapter' })

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('dsh-qwenwork-connect: llm 服务不可用，适配器无法注册')
    return { ready }
  }

  const store = new AccountStore(cfg.dataDir)
  const adapter = new QwenWorkAdapter({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    gateway: cfg.gateway,
    store,
  })

  // 1. 先注册，选择器立刻可用
  ctx.llm.registerAdapter([cfg.providerId], adapter)
  logger.info(`dsh-qwenwork-connect: 已注册 provider "${cfg.providerId}"（${MODELS.length} 个模型）`)

  // 2. 后台加载账号
  void store.load().then((accounts: StoredAccount[]) => {
    if (accounts.length === 0) {
      logger.info('dsh-qwenwork-connect: 还没有登录账号，请在「设置 → 千问办公」完成设备码登录')
    } else {
      logger.info(`dsh-qwenwork-connect: 已加载 ${accounts.length} 个账号`)
    }
  }).catch((error: unknown) => {
    logger.error(`dsh-qwenwork-connect: 账号加载失败：${error instanceof Error ? error.message : String(error)}`)
  })

  // 3. 设置页路由（可选：没有 connection 服务就跳过，不影响聊天）
  installRoutes(ctx, cfg, store, logger)

  return { ready }
}

/**
 * 挂设置页用的 REST 路由。
 *
 * 用 `ctx.inject(['connection'])` 等连接注册表就绪。这套路由只做三件事：
 * 发起登录、查账号、删账号。**不需要重启就能生效**。
 */
function installRoutes(
  ctx: PluginContext,
  cfg: Resolved,
  store: AccountStore,
  logger: PluginContext['logger'],
): void {
  if (typeof ctx.inject !== 'function') return

  try {
    ctx.inject(['connection'], (cctx: Record<string, unknown>) => {
      const connection = cctx.connection as { fetch?: { register?: (route: unknown) => () => void } } | undefined
      const register = connection?.fetch?.register
      if (typeof register !== 'function') {
        logger.warn('dsh-qwenwork-connect: connection fetch 注册表不可用，设置页 API 已禁用')
        return
      }

      const json = (status: number, payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })

      const disposers: Array<() => void> = []

      const registerRoute = (
        path: string,
        methods: string[],
        handler: (request: Request) => Promise<Response>,
      ): void => {
        try {
          disposers.push(
            register({
              path,
              methods,
              requestBody: 'buffered',
              fetch: handler,
            }),
          )
        } catch (error) {
          logger.warn(
            `dsh-qwenwork-connect: ${path} 注册失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      // GET /api/qwenwork/status — 已登录账号与模型清单
      registerRoute(`${API_PREFIX}/status`, ['GET'], async () => {
        await store.load()
        return json(200, {
          ok: true,
          providerId: cfg.providerId,
          displayName: cfg.displayName,
          models: MODELS.map(m => ({ id: m.key, name: m.displayName })),
          accounts: store.list().map(a => ({
            uid: a.uid,
            label: a.label ?? a.uid,
            plan: a.plan,
            balance: a.balance,
            expires: a.expires,
          })),
        })
      })

      // POST /api/qwenwork/login — 发起设备码登录，返回待授权地址
      registerRoute(`${API_PREFIX}/login`, ['POST'], async () => {
        try {
          const signIn = startDeviceSignIn(cfg.gateway)
          // 不阻塞响应：先把地址给出去，后台等授权结果
          void signIn.wait()
            .then(async account => {
              await store.upsert(account)
              logger.info(`dsh-qwenwork-connect: 账号已登录 ${account.label ?? account.uid}`)
            })
            .catch((error: unknown) => {
              logger.warn(
                `dsh-qwenwork-connect: 登录未完成：${error instanceof Error ? error.message : String(error)}`,
              )
            })
          return json(200, { ok: true, url: signIn.url, instructions: signIn.instructions })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      // POST /api/qwenwork/logout — 删除一个账号
      registerRoute(`${API_PREFIX}/logout`, ['POST'], async (request: Request) => {
        try {
          const body = (await request.json().catch(() => ({}))) as { uid?: unknown }
          const uid = String(body.uid ?? '').trim()
          if (uid === '') return json(400, { ok: false, error: 'uid 必填' })
          await store.remove(uid)
          logger.info(`dsh-qwenwork-connect: 账号已移除 ${uid}`)
          return json(200, { ok: true })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      logger.info(`dsh-qwenwork-connect: 设置页 API 已挂载在 ${API_PREFIX}`)

      // 卸载时摘掉路由
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              // 尽力而为
            }
          }
        })
      }
      return undefined
    })
  } catch (error) {
    logger.warn(
      `dsh-qwenwork-connect: 设置页 API 不可用：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export { QwenWorkAdapter, MODELS } from './adapter/qwenwork.ts'
export { AccountStore, startDeviceSignIn, GATEWAY } from './adapter/auth.ts'

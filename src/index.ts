/**
 * dsh-qwenwork-connector — 插件入口。
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
import type { ModelEntry } from './adapter/catalog.ts'
import { PrefsStore, AUTO_WINDOW } from './adapter/prefs.ts'
import type { AttachmentStore } from './adapter/images.ts'

/** 插件名，同时是 cordis 里的 id。 */
export const name = 'dsh-qwenwork-connector'

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
  const ready = Promise.resolve({ version: 'adapter' })

  // 整段包起来：任何意外异常都只让本插件 FAILED（宿主会记一条
  // "1 entry did not activate" 警告并继续启动），绝不把异常抛回 Loader。
  try {
    return start(ctx, config, logger, ready)
  } catch (error) {
    logger.error(
      `dsh-qwenwork-connector: 启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    )
    return { ready }
  }
}

/** 真正的启动逻辑，由 {@link apply} 兜住异常。 */
function start(
  ctx: PluginContext,
  config: PluginConfig,
  logger: PluginContext['logger'],
  ready: Promise<{ version: string }>,
): PluginHandle {
  const cfg = resolveConfig(config)

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('dsh-qwenwork-connector: llm 服务不可用，适配器无法注册')
    return { ready }
  }

  const store = new AccountStore(cfg.dataDir)
  const prefs = new PrefsStore(cfg.dataDir)

  // 附件服务是可选依赖：没有它时图片无法上行（会明确告知，而不是静默丢）。
  // 这里取到的只当快照，另外把 `readAttachments` 交给适配器按请求重试——
  // 第三方 bundle 早于宿主 provision 加载，启动这一枪经常打空（issue #1）。
  const attachments = readAttachments(ctx)
  if (attachments === undefined) {
    logger.info('dsh-qwenwork-connector: 附件服务尚未就绪，改由每次请求时重试解析')
  }

  const adapter = new QwenWorkAdapter({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    gateway: cfg.gateway,
    store,
    prefs,
    ...(attachments !== undefined ? { attachments } : {}),
    attachmentsLookup: () => readAttachments(ctx),
    // 上游目录变了就广播给宿主。
    //
    // 宿主按 `llm/models-updated(provider)` 约定重载模型选择器
    // （见 dsh-llm 的 provider 文档）；不发这个事件的话，插件内部
    // 拉到再新的目录，已打开的会话选择器也一直显示旧列表——
    // 表现就是「刷新了还是那几个模型」，跟上写死没区别。
    onModelsChanged: (models: ModelEntry[]) => {
      const detail = { provider: cfg.providerId, count: models.length }
      emitSafe(ctx, 'llm/models-updated', cfg.providerId, detail)
      // 选择器通常订阅 adapters-updated 重读整个目录，两个都发上，
      // 免得不同版本的宿主只认其中一个。
      emitSafe(ctx, 'llm/adapters-updated', cfg.providerId, detail)
      logger.info(`dsh-qwenwork-connector: 模型目录已更新，${models.length} 个模型`)
    },
  })

  // 1. 先注册，选择器立刻可用。
  //    这一步没有 try/catch 之外的保护：provider id 若与其他插件撞车，
  //    registerAdapter 会抛错。宁可自己 FAILED，也不要把宿主启动拖下水。
  try {
    ctx.llm.registerAdapter([cfg.providerId], adapter)
    logger.info(`dsh-qwenwork-connector: 已注册 provider "${cfg.providerId}"（${MODELS.length} 个模型）`)
  } catch (error) {
    logger.error(
      `dsh-qwenwork-connector: provider "${cfg.providerId}" 注册失败（可能与已装插件同名）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return { ready }
  }

  // 2. 后台加载账号，同时拉一次真实模型目录
  void store.load().then(async (accounts: StoredAccount[]) => {
    if (accounts.length === 0) {
      logger.info('dsh-qwenwork-connector: 还没有登录账号，请在「设置 → 千问办公」完成设备码登录')
    } else {
      logger.info(`dsh-qwenwork-connector: 已加载 ${accounts.length} 个账号`)
      // 有账号才拉得动目录（接口要签名）
      await adapter.refreshModels(true).catch(() => {})
      logger.info(`dsh-qwenwork-connector: 模型目录 ${adapter.models.length} 项（来自上游实测）`)
    }
  }).catch((error: unknown) => {
    logger.error(`dsh-qwenwork-connector: 账号加载失败：${error instanceof Error ? error.message : String(error)}`)
  })

  // 3. 设置页路由（可选：没有 connection 服务就跳过，不影响聊天）
  installRoutes(ctx, cfg, store, prefs, adapter, logger)

  return { ready }
}

/**
 * 发事件，出错不影响调用方。
 *
 * 宿主对未注册的事件名一般是静默忽略，但按钮回调 / 刷新路径不该
 * 因为通知失败就整个失败。
 */
function emitSafe(ctx: PluginContext, event: string, ...args: unknown[]): void {
  try {
    ctx.emit?.(event, ...args)
  } catch {
    // 通知失败只是 UI 不重载，刷新本身已经成功了
  }
}

/**
 * 取宿主的附件服务。
 *
 * 拿不到不是错误——插件照样能跑文本。只是图片消息会明确失败，
 * 而不是静默丢成一句「[图片]」。
 */
function readAttachments(ctx: PluginContext): AttachmentStore | undefined {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    const store = service as AttachmentStore | undefined
    if (store !== undefined && typeof store.readImageRequest === 'function') return store
    return undefined
  } catch {
    return undefined
  }
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
  prefs: PrefsStore,
  adapter: QwenWorkAdapter,
  logger: PluginContext['logger'],
): void {
  if (typeof ctx.inject !== 'function') return

  try {
    ctx.inject(['connection'], (cctx: Record<string, unknown>) => {
      const connection = cctx.connection as { fetch?: { register?: (route: unknown) => () => void } } | undefined
      const register = connection?.fetch?.register
      if (typeof register !== 'function') {
        logger.warn('dsh-qwenwork-connector: connection fetch 注册表不可用，设置页 API 已禁用')
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
            `dsh-qwenwork-connector: ${path} 注册失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      // GET /api/qwenwork/status — 已登录账号与模型清单
      registerRoute(`${API_PREFIX}/status`, ['GET'], async () => {
        await store.load()
        await prefs.load()
        // 真实能力来自适配器当前的模型目录（登录后会拉到上游真值）
        const models = adapter.models.map(m => ({
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
          window: prefs.windowFor(m.key),
        }))
        return json(200, {
          ok: true,
          providerId: cfg.providerId,
          displayName: cfg.displayName,
          models,
          accounts: store.list().map(a => ({
            uid: a.uid,
            label: a.label ?? a.uid,
            plan: a.plan,
            balance: a.balance,
            expires: a.expires,
            quota: a.quota,
            renewsAt: a.renewsAt,
            period: a.period,
            syncedAt: a.syncedAt,
          })),
        })
      })

      // POST /api/qwenwork/account/sync — 向上游重拉额度与套餐，顺带重拉模型目录
      //
      // 设置页「刷新」按钮打这里。额度与模型目录都靠上游，用户点一次
      // 刷新，两样都该是新的：只刷额度会让「上游加了模型 / 改了价」
      // 这件事永远透着，用户看到的模型列表就跟写死的一样。
      //
      // 部分账号失败也返回 200，把原因放进 errors，界面可以逐账号显示。
      registerRoute(`${API_PREFIX}/account/sync`, ['POST'], async () => {
        await store.load()
        const { accounts, errors } = await store.sync(cfg.gateway)

        // 目录刷新失败不该算账号刷新失败：额度可能已经拿到了。
        // 记下原因，跟账号错误一起回给界面。
        //
        // 「回源成功」按时间戳判断，不能看目录非空——兜底快照本身非空，
        // 那样永远显示已回源，等于没判。
        const lastFetch = adapter.modelsFetchedAt
        let modelsRefreshed = false
        try {
          await adapter.refreshModels(true)
          modelsRefreshed = adapter.modelsFetchedAt !== lastFetch
        } catch (error) {
          errors.push(
            `模型列表刷新失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }

        logger.info(
          `dsh-qwenwork-connector: 同步账号 ${accounts.length} 个，失败 ${errors.length} 个，` +
            `模型目录 ${adapter.models.length} 项（${modelsRefreshed ? '已回源' : '未回源，沿用缓存'}）`,
        )
        return json(200, {
          ok: errors.length === 0,
          accounts: accounts.map(a => ({
            uid: a.uid,
            label: a.label ?? a.uid,
            plan: a.plan,
            balance: a.balance,
            expires: a.expires,
            quota: a.quota,
            renewsAt: a.renewsAt,
            period: a.period,
            syncedAt: a.syncedAt,
          })),
          // 顺带把新目录带回去，界面不用再打一次 /status
          models: adapter.models.map(m => ({
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
            window: prefs.windowFor(m.key),
          })),
          modelsRefreshed,
          errors,
        })
      })

      // POST /api/qwenwork/window — 设某个模型的上下文档位（0 = 自动）
      registerRoute(`${API_PREFIX}/window`, ['POST'], async (request: Request) => {
        try {
          const body = (await request.json().catch(() => ({}))) as { model?: unknown; window?: unknown }
          const model = String(body.model ?? '').trim()
          if (model === '') return json(400, { ok: false, error: 'model 必填' })
          const raw = Number(body.window)
          const window = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AUTO_WINDOW
          await adapter.setWindowPreference(model, window)
          logger.info(`dsh-qwenwork-connector: ${model} 上下文档位设为 ${window === 0 ? '自动' : window}`)
          return json(200, { ok: true, model, window })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      // POST /api/qwenwork/models/refresh — 强制重拉上游模型目录
      registerRoute(`${API_PREFIX}/models/refresh`, ['POST'], async () => {
        try {
          await adapter.refreshModels(true)
          return json(200, {
            ok: true,
            models: adapter.models.map(m => ({ id: m.key, name: m.displayName, rate: m.rate, vision: m.isVision === true, reasoning: m.isReasoning === true })),
          })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      // POST /api/qwenwork/login — 发起设备码登录，返回待授权地址
      registerRoute(`${API_PREFIX}/login`, ['POST'], async () => {
        try {
          const signIn = startDeviceSignIn(cfg.gateway)
          // 不阻塞响应：先把地址给出去，后台等授权结果
          void signIn.wait()
            .then(async account => {
              await store.upsert(account)
              logger.info(`dsh-qwenwork-connector: 账号已登录 ${account.label ?? account.uid}`)
              // 登录前拉不动目录（接口要签名），所以新账号的模型要在这里补拉。
              // 不补的话，登录后选择器里还是登录前的兜底快照，得重启才更新。
              await adapter.refreshModels(true).catch(() => {})
            })
            .catch((error: unknown) => {
              logger.warn(
                `dsh-qwenwork-connector: 登录未完成：${error instanceof Error ? error.message : String(error)}`,
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
          logger.info(`dsh-qwenwork-connector: 账号已移除 ${uid}`)
          return json(200, { ok: true })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      logger.info(`dsh-qwenwork-connector: 设置页 API 已挂载在 ${API_PREFIX}`)

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
      `dsh-qwenwork-connector: 设置页 API 不可用：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export { QwenWorkAdapter, MODELS } from './adapter/qwenwork.ts'
export { AccountStore, startDeviceSignIn, GATEWAY } from './adapter/auth.ts'

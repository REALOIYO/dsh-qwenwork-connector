/**
 * QwenWork 的 DSH LlmAdapter。
 *
 * 契约（dsh-llm）共 7 个方法，全部按结构化类型实现，**不 import 宿主的
 * `@deepseek-ai/*` 包**——这样插件不会被内核版本绑死。
 *
 * 调用链：
 *   DSH → prepareCall → stream
 *            ↓
 *        buildBody（明文）+ encodeBody（编码）+ chatHeaders（签名）
 *            ↓
 *        POST gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation
 *            ↓
 *        toStreamChunks → DSH chunk
 *
 * @module src/adapter/qwenwork.ts
 */

import { randomUUID } from 'node:crypto'

import { AccountStore, GATEWAY, type StoredAccount } from './auth.ts'
import { buildBody, type ChatRequest } from './body.ts'
import { FALLBACK_MODELS, parseModelListing, type ModelEntry } from './catalog.ts'
import { chatHeaders, clientHeaders, cosyHeaders } from './cosy.ts'
import { markTaskAnswered, sessionOf, taskOf } from './session.ts'
import { collectImageRefs, resolveImages, type AttachmentStore, type ImageAttachmentRef, type ResolvedImage } from './images.ts'
import type { PrefsStore } from './prefs.ts'
import { encodeBody } from './codec.ts'
import { toStreamChunks, UpstreamError, type StreamChunk, type FinishReason } from './stream.ts'

/**
 * 登录前/拿不到列表时用的模型快照。
 * 真实能力（倍率、视觉、思考、上下文）见 `catalog.ts` 的实测值。
 */
export const MODELS: ModelEntry[] = FALLBACK_MODELS

/** 模型列表端点。 */
const LIST_PATH = '/algo/api/v2/model/list?Encode=1'

/** 聊天端点。`Encode=1` 表示请求体要编码。 */
const CHAT_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

/** 拿不到模型信息时的兜底值。 */
const DEFAULT_CONTEXT_WINDOW = 131_072
/** 默认最大输出。 */
const DEFAULT_MAX_TOKENS = 32_000
/** 模型列表的缓存时长：上游加了模型、调了价，最多这么久能跟上。 */
const LIST_TTL_MS = 5 * 60 * 1000

/**
 * 模型池忙时的重试次数与最大等待。
 *
 * 上游的 "All models failed" 是池子里暂时没有可用实例，不是额度耗尽。
 * 实测多轮 agent 循环第 3~4 轮就会撞上，等几秒通常就好了。
 * 直接把这种状态抛给用户，表现就是「跑一会儿突然停」。
 */
const POOL_RETRIES = 2
/** 单次等待上限，避免卡太久。 */
const POOL_MAX_WAIT_MS = 20_000
/** 上游笼统失败（SERVER）时的默认等待秒数。 */
const TRANSIENT_WAIT = 3

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** DSH 传给 stream 的参数（只声明用到的）。 */
export interface GenerateOptions extends ChatRequest {
  model: string
  signal?: AbortSignal
  /** 会话标识，DSH 可能给；没有就自带一个。 */
  sessionId?: string
}

/** resolveModel 返回的形状。 */
export interface ResolvedModel {
  provider: string
  id: string
  name: string
  inputModalities: string[]
  context: { contextWindow: number }
  defaultMaxTokens: number
  reasoning?: {
    efforts: ReadonlyArray<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

/** 适配器构造参数。 */
export interface QwenWorkAdapterOptions {
  /** 注册到 DSH 的 provider id。 */
  providerId?: string
  /** 选择器里的分组名。 */
  displayName?: string
  /** 网关地址，默认官方。 */
  gateway?: string
  /** 账号存储。 */
  store: AccountStore
  /** 用户偏好（每个模型固定哪个上下文档位）。 */
  prefs?: PrefsStore
  /** 宿主的附件服务，用来把图片附件读成字节。 */
  attachments?: AttachmentStore
  /**
   * 上游目录真的换了一份时的回调。
   *
   * 适配器不直接碰宿主 ctx：拿到新目录只负责通知，由插件入口决定
   * 发什么事件。缺省时不通知。
   */
  onModelsChanged?: (models: ModelEntry[]) => void
}

/**
 * 千问办公适配器。
 *
 * 多账号：按顺序尝试，额度用完或鉴权失败的账号会被跳过。
 */
export class QwenWorkAdapter {
  readonly #providerId: string
  readonly #displayName: string
  readonly #gateway: string
  readonly #store: AccountStore
  readonly #prefs: PrefsStore | undefined
  readonly #attachments: AttachmentStore | undefined
  readonly #onModelsChanged: ((models: ModelEntry[]) => void) | undefined
  /** 轮转游标：上次成功的账号下标。 */
  #cursor = 0
  /** 上游真实模型目录；拿不到时为兜底快照。 */
  #models: ModelEntry[] = FALLBACK_MODELS
  /** 上次拉目录的时间，用于 TTL。 */
  #modelsAt = 0
  /** 正在进行的目录刷新，避免并发重复请求。 */
  #refreshing: Promise<ModelEntry[]> | null = null

  constructor(opts: QwenWorkAdapterOptions) {
    this.#providerId = opts.providerId ?? 'qwenwork'
    this.#displayName = opts.displayName ?? '千问办公'
    this.#gateway = (opts.gateway ?? GATEWAY).replace(/\/+$/, '')
    this.#store = opts.store
    this.#prefs = opts.prefs
    this.#attachments = opts.attachments
    this.#onModelsChanged = opts.onModelsChanged
  }

  /** 某个模型当前固定的上下文档位；0 表示自动。 */
  windowPreference(model: string): number {
    return this.#prefs?.windowFor(model) ?? 0
  }

  /** 改某个模型的上下文档位偏好；0 恢复自动。 */
  async setWindowPreference(model: string, tokens: number): Promise<void> {
    if (this.#prefs === undefined) throw new Error('qwenwork: 偏好存储未初始化')
    await this.#prefs.setWindow(model, tokens)
  }

  /** 当前模型目录（可能还没拉到真实值）。 */
  get models(): ModelEntry[] {
    return this.#models
  }

  /**
   * 上次成功从上游拉到目录的时刻；0 表示还没成功过。
   *
   * 用来区分「这次真的回源了」和「回源失败、沿用缓存」——
   * 只看目录非空是分不出来的，兜底快照本身就是非空的。
   */
  get modelsFetchedAt(): number {
    return this.#modelsAt
  }

  // ── 契约方法 ──────────────────────────────────────────────────────────

  /** 分组名，模型选择器里显示。 */
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.#displayName }
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
  providerRetryPolicy(_provider: string): {
    mode: 'normal'
    maxRetries: number
    retryableCodes: string[]
  } {
    return {
      mode: 'normal',
      // 宿主侧再多试几轮。插件内部已经等过最多 2×20 秒，
      // 这里放宽到 4 次，把「池子忙一阵就恢复」的情况兜住。
      maxRetries: 4,
      retryableCodes: ['MODEL_POOL_BUSY', 'QUEUED', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT'],
    }
  }

  /** 千问办公没有单独的视觉计费。 */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** 选择器里列出的模型。 */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    return this.#models.map(m => ({
      provider,
      id: m.key,
      name: m.displayName,
      inputModalities: m.isVision === true ? ['text', 'image'] : ['text'],
    }))
  }

  /**
   * 单个模型的元信息。
   *
   * 这里如实反映上游给的能力：视觉、思考档位、真实上下文窗口。
   * 少报一样，用户在选择器里就少一个能用的开关。
   */
  resolveModel(provider: string, model: string): ResolvedModel {
    const entry = this.#models.find(m => m.key === model)

    // 思考档位：上游没给阶梯时不给 reasoning 字段——
    // 带了空数组反而会让选择器显示一个空菜单
    const levels = entry?.efforts ?? []
    const reasoning =
      levels.length > 0
        ? {
            efforts: levels.map(id => ({ id, name: effortName(id) })),
            ...(entry?.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}),
          }
        : undefined

    // 上下文窗口要反映**用户当前选的档位**，不能恒取上游最大值。
    //
    // 否则用户在设置里选了 200K，DSH 这边仍按 1M 算：压缩时机、剩余
    // 上下文百分比全是假的，而实际请求只带 200K —— 两边对不上，
    // 长对话会在不该压缩的时候压缩、该提示的时候不提示。
    //
    // 用户选「自动」(0) 时才回落到上游给的最大值。
    const chosen = this.#prefs?.windowFor(model) ?? 0
    const contextWindow =
      chosen > 0 ? chosen : (entry?.maxInputTokens ?? entry?.defaultWindow ?? DEFAULT_CONTEXT_WINDOW)

    return {
      provider,
      id: model,
      name: entry?.displayName ?? model,
      inputModalities: entry?.isVision === true ? ['text', 'image'] : ['text'],
      context: {
        contextWindow,
      },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
  }

  /** DSH 在调用前拿模型信息与流函数。 */
  async prepareCall(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<{ model: ResolvedModel; stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk> }> {
    return {
      model: this.resolveModel(provider, model),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 发起一次流式请求。
   *
   * 容错策略照 magpie：**插件只负责把失败如实分类上报，重试交给宿主**。
   * 唯一自己做的一件事是「换账号」——这是多账号场景特有的，且只在
   * 还没吐出内容时进行。
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const accounts = this.#store.list()
    if (accounts.length === 0) {
      throw new Error('qwenwork: 还没有登录账号，请在设置页完成设备码登录')
    }

    const entry = this.#models.find(m => m.key === options.model)
    if (!entry) {
      throw new Error(
        `qwenwork: 未知模型 "${options.model}"（可用：${this.#models.map(m => m.key).join(', ')}）`,
      )
    }

    // 从上次成功的位置开始轮转，避免总撞同一个坏账号
    const order = [...accounts.keys()].map(k => (this.#cursor + k) % accounts.length)
    let lastError: unknown = null
    let lastAccount: StoredAccount | undefined

    for (const index of order) {
      const account = accounts[index]!
      lastAccount = account

      // 模型池忙（"All models failed"）时同一个账号退避重试：
      // 换号没用（池子是共享的），但直接失败会表现为「跑一会儿就停」。
      for (let attempt = 0; ; attempt++) {
        // 一旦这一轮吐过内容，就不能重来——用户已经看到了
        let touched = false
        try {
          for await (const chunk of this.#streamOnce(account, entry, options)) {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              touched = true
            }
            yield chunk
          }
          this.#cursor = index
          return
        } catch (error) {
          if (touched) throw this.#describe(error, account)

          if (error instanceof UpstreamError) {
            // 可重试的瞬时失败：模型池抖、上游笼统报错。
            // 换号无用（同一池子），等一会儿重试同一个账号。
            if ((error.code === 'MODEL_POOL_BUSY' || error.code === 'SERVER') && attempt < POOL_RETRIES) {
              const wait = (error.retryAfter ?? TRANSIENT_WAIT) * 1000
              await sleep(Math.min(wait, POOL_MAX_WAIT_MS))
              continue
            }
            // 只有「换个号可能就好」的失败才换号
            if (isWorthAnotherAccount(error)) {
              lastError = error
              break
            }
          }
          throw this.#describe(error, account)
        }
      }
    }

    throw this.#describe(lastError, lastAccount)
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
  async refreshModels(force = false): Promise<ModelEntry[]> {
    if (!force && Date.now() - this.#modelsAt < LIST_TTL_MS) return this.#models
    if (this.#refreshing !== null) return this.#refreshing

    this.#refreshing = (async (): Promise<ModelEntry[]> => {
      try {
        const accounts = this.#store.list()
        const account = accounts[0]
        if (account === undefined) return this.#models

        const url = this.#gateway + LIST_PATH
        const headers = {
          ...cosyHeadersForList(url, account),
          Accept: 'application/json',
        }
        const res = await fetch(url, { headers })
        if (!res.ok) return this.#models
        const parsed: unknown = await res.json()
        const models = parseModelListing(parsed)
        if (models.length === 0) return this.#models

        const changed = !sameCatalog(this.#models, models)
        this.#models = models
        this.#modelsAt = Date.now()
        if (changed) this.#notifyModelsChanged()
        return this.#models
      } catch {
        // 拉不到就继续用旧的
        return this.#models
      } finally {
        this.#refreshing = null
      }
    })()

    return this.#refreshing
  }

  /** 通知宿主目录变了。回调抛错不能影响刷新本身。 */
  #notifyModelsChanged(): void {
    try {
      this.#onModelsChanged?.(this.#models)
    } catch {
      // 通知失败只是选择器不重载，不该让刷新算失败
    }
  }

  /** 用指定账号跑一次。 */
  async *#streamOnce(account: StoredAccount, entry: ModelEntry, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    // 会话 id 必须是「同一对话稳定、不同对话不同」，不能拿账号 uid 顶替——
    // 那样所有对话会撞成一个会话，服务端缓存全串
    const sessionId = sessionOf(options.sessionId ?? '', options)
    const requestId = randomUUID()
    // 一次用户提问 = 一个任务；工具循环的各轮复用它
    const task = taskOf(sessionId, options)

    // ── 图片：DSH 传的是附件引用，必须先读成 data URL，否则会被静默丢弃
    const refs: ImageAttachmentRef[] = []
    const inlineUrls: string[] = []
    for (const message of options.messages) {
      const found = collectImageRefs(message.content)
      refs.push(...found.refs)
      inlineUrls.push(...found.inlineUrls)
    }
    const totalImages = refs.length + inlineUrls.length

    // 模型不支持视觉时明确失败，而不是悄悄把图丢掉
    if (totalImages > 0 && entry.isVision !== true) {
      throw new UpstreamError({
        status: 400,
        message: `模型 "${entry.displayName}" 不接受图片输入`,
        code: 'INVALID_REQUEST',
      })
    }

    const read = await resolveImages(refs, this.#attachments, options.signal)
    /** attachmentId → 读好的图片，供 body 构造时查。 */
    let resolved = read.images

    // 带图时先按原样发；上游用笼统的 "Error in upstream response" 打回
    // 时（实测带图请求会被这样拒），降级成纯文本再试一次——
    // 让用户至少拿到回答，而不是整轮失败。
    const withImages = totalImages > 0 && resolved.size > 0
    let degraded = false

    for (let round = 0; ; round++) {
      const body = buildBody(
        options,
        entry,
        sessionId,
        requestId,
        task,
        this.#prefs?.windowFor(entry.key) ?? 0,
        degraded ? undefined : resolved,
        read.failed > 0
          ? { failed: read.failed, ...(read.reason !== undefined ? { reason: read.reason } : {}) }
          : undefined,
      )
      try {
        yield* this.#post(account, entry, body, options.signal)
        // 这一轮被回答过了，后续轮次发 processing
        markTaskAnswered(task)
        return
      } catch (error) {
        // 只在「带图 + 上游笼统拒绝 + 还没吐过内容」时降级一次
        if (
          !degraded &&
          withImages &&
          round === 0 &&
          error instanceof UpstreamError &&
          (error.code === 'SERVER' || error.code === 'INVALID_REQUEST')
        ) {
          degraded = true
          resolved = new Map()
          continue
        }
        throw error
      }
    }
  }

  /** 发一次构造好的请求体，把流吐出来。 */
  async *#post(
    account: StoredAccount,
    entry: ModelEntry,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const wire = encodeBody(JSON.stringify(body))
    const url = this.#gateway + CHAT_PATH
    const headers = chatHeaders(url, account, wire, entry.key, entry.source ?? 'system')

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: wire,
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw UpstreamError.from(res.status, text.trim() || `HTTP ${res.status}`)
      }
      if (!res.body) throw UpstreamError.from(502, 'qwenwork: 响应没有 body')

      yield* toStreamChunks(res.body as unknown as AsyncIterable<Uint8Array>, entry.displayName)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 给用户看的错误：带上账号标签，方便判断是哪个号出问题。 */
  #describe(error: unknown, account: StoredAccount | undefined): Error {
    if (error instanceof UpstreamError) {
      const who = account?.label ? `（账号 ${account.label}）` : ''
      return new Error(`qwenwork${who}: ${error.message} [${error.code}]`)
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError') return error
      return error
    }
    return new Error(`qwenwork: ${String(error)}`)
  }
}

/**
 * 换个账号会不会好？
 *
 * 会：登录失效（这个号废了）、额度用尽（这个号没钱了）。
 * 不会：排队（同一个模型池）、请求本身被拒（换谁问都一样）、
 *       上游供应商挂了（不是账号的问题）。
 */
function isWorthAnotherAccount(e: UpstreamError): boolean {
  return e.code === 'AUTH' || e.code === 'QUOTA_EXCEEDED'
}

/**
 * 两份模型目录内容是否一致。
 *
 * 只比用户看得见、影响请求的字段：增删模型、改名、改价、改上下文档位、
 * 开关视觉/思考。一致时不必惊动宿主去重载选择器——刷新按钮会被反复点，
 * 每次都广播一次纯属噪音。
 */
function sameCatalog(a: ModelEntry[], b: ModelEntry[]): boolean {
  if (a.length !== b.length) return false
  const pick = (m: ModelEntry): string =>
    JSON.stringify([
      m.key,
      m.displayName,
      m.description ?? '',
      m.rate ?? 0,
      m.rateWas ?? 0,
      m.free === true,
      m.isVision === true,
      m.isReasoning === true,
      m.efforts ?? [],
      m.defaultEffort ?? '',
      m.maxInputTokens ?? 0,
      m.windows ?? [],
      m.defaultWindow ?? 0,
    ])
  const left = a.map(pick).sort()
  const right = b.map(pick).sort()
  return left.every((v, i) => v === right[i])
}

/** 思考档位的显示名。上游给的是 id，选择器里要人话。 */
function effortName(id: string): string {
  const names: Record<string, string> = {
    none: '不思考',
    minimal: '极简',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
    ultra: '极致',
  }
  return names[id] ?? id
}

/**
 * 拉模型列表用的头。
 *
 * 列表不像聊天那样走 SSE，所以用普通 COSY 头 + 客户端身份头，
 * 但场景要显式指定 qwork——不指定的话服务端按别的场景回，模型对不上。
 */
function cosyHeadersForList(url: string, account: StoredAccount): Record<string, string> {
  return {
    ...cosyHeaders(url, account, ''),
    ...clientHeaders(),
    'Cosy-Scene': 'qwork',
  }
}

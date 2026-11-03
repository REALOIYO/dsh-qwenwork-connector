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
import { buildBody, type ChatRequest, type ModelEntry } from './body.ts'
import { chatHeaders } from './cosy.ts'
import { encodeBody } from './codec.ts'
import { toStreamChunks, UpstreamError, type StreamChunk, type FinishReason } from './stream.ts'

/** 千问办公的模型列表。公开云当前就这三个。 */
export const MODELS: ModelEntry[] = [
  { key: 'flash', displayName: '标准', isReasoning: false, isVision: false, maxInputTokens: 131_072 },
  { key: 'pro', displayName: '高级', isReasoning: false, isVision: false, maxInputTokens: 131_072 },
  { key: 'qwen3.8-max-preview', displayName: 'Qwen3.8-Max', isReasoning: false, isVision: false, maxInputTokens: 131_072 },
]

/** 聊天端点。`Encode=1` 表示请求体要编码。 */
const CHAT_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

/** 默认上下文窗口，与客户端报的一致。 */
const DEFAULT_CONTEXT_WINDOW = 131_072
/** 默认最大输出。 */
const DEFAULT_MAX_TOKENS = 32_000

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
  /** 轮转游标：上次成功的账号下标。 */
  #cursor = 0

  constructor(opts: QwenWorkAdapterOptions) {
    this.#providerId = opts.providerId ?? 'qwenwork'
    this.#displayName = opts.displayName ?? '千问办公'
    this.#gateway = (opts.gateway ?? GATEWAY).replace(/\/+$/, '')
    this.#store = opts.store
  }

  // ── 契约方法 ──────────────────────────────────────────────────────────

  /** 分组名，模型选择器里显示。 */
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.#displayName }
  }

  /** 用宿主默认重试策略。 */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** 千问办公没有单独的视觉计费。 */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** 选择器里列出的模型。 */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    return MODELS.map(m => ({
      provider,
      id: m.key,
      name: m.displayName,
      inputModalities: m.isVision ? ['text', 'image'] : ['text'],
    }))
  }

  /** 单个模型的元信息。 */
  resolveModel(provider: string, model: string): ResolvedModel {
    const entry = MODELS.find(m => m.key === model)
    return {
      provider,
      id: model,
      name: entry?.displayName ?? model,
      inputModalities: entry?.isVision ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
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
   * 多账号时按游标轮转：某个账号鉴权/额度失败就换下一个，
   * 全试过都失败才把最后一个错误抛出去。
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const accounts = this.#store.list()
    if (accounts.length === 0) {
      throw new Error('qwenwork: 还没有登录账号，请在设置页完成设备码登录')
    }

    const entry = MODELS.find(m => m.key === options.model)
    if (!entry) {
      throw new Error(`qwenwork: 未知模型 "${options.model}"（可用：${MODELS.map(m => m.key).join(', ')}）`)
    }

    // 从上次成功的位置开始轮转，避免总撞同一个坏账号
    const order = [...accounts.keys()].map(k => (this.#cursor + k) % accounts.length)
    let lastError: unknown = null
    let lastAccount: StoredAccount | undefined

    for (const index of order) {
      const account = accounts[index]!
      lastAccount = account
      // 一旦这一轮吐过内容，就不能换账号重来——用户已经看到了
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
        // 出过字就原样抛出，不再换账号
        if (!touched && error instanceof UpstreamError && isRetryable(error)) {
          lastError = error
          continue
        }
        throw this.#describe(error, account)
      }
    }

    throw this.#describe(lastError, lastAccount)
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /** 用指定账号跑一次。 */
  async *#streamOnce(account: StoredAccount, entry: ModelEntry, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const sessionId = options.sessionId ?? `qwenwork_${account.uid}`
    const requestId = randomUUID()
    const taskId = requestId

    const body = buildBody(options, entry, sessionId, requestId, taskId)
    const wire = encodeBody(JSON.stringify(body))
    const url = this.#gateway + CHAT_PATH
    const headers = chatHeaders(url, account, wire, entry.key, entry.source ?? 'system')

    const controller = new AbortController()
    const signal = options.signal
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
        throw new UpstreamError(res.status, text.trim() || `HTTP ${res.status}`)
      }
      if (!res.body) throw new UpstreamError(502, 'qwenwork: 响应没有 body')

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

/** 该不该换账号重试：鉴权/额度/服务端问题值得换，请求本身的问题不值得。 */
function isRetryable(e: UpstreamError): boolean {
  return e.code === 'AUTH' || e.code === 'QUOTA_EXCEEDED' || e.code === 'SERVER' || e.code === 'UPSTREAM'
}

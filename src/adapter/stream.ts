/**
 * QwenWork 的 SSE → DSH StreamChunk，以及失败分类。
 *
 * 上游的流是两层信封：每个 `data:` 行是一个 JSON，真正的 OpenAI chunk
 * 在它的 `body` 字段里（字符串）。`Encode=1` 时 body 还是编码过的。
 *
 * 输出的 chunk 必须遵守 DSH 契约：
 *  - 文本/思考用 block-start → delta → block-end
 *  - 最后必须以 `usage` 然后 `finish` 结尾
 *
 * 失败分类严格照搬 `@magpie-community/opencode-qoder-auth@0.2.59` 的
 * `failure()`（MIT）：**按上游自己的错误码判读，不按 HTTP 状态猜**。
 * 这一点很重要——同一封 HTTP 429 既可能是额度用尽，也可能是模型池打满，
 * 靠状态码区分不了。
 *
 * @module src/adapter/stream.ts
 */

import { decodeBody, looksEncoded } from './codec.ts'

/** DSH 的流式块。 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string } }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: FinishReason }

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'tool-calls' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } }

// ── 失败分类（照搬 magpie 的 failure） ────────────────────────────────────

/** 模型池排队中：上游说"忙"，等一下再来，不是账号问题。 */
const QUEUED = '10605'

/**
 * 上游判为「额度 / 用量耗尽」的错误码。
 * 这套码来自 Qoder 系的客户端协议，QwenWork 复用。
 */
const QUOTA_CODES = new Set(['110', '112', '113', '114', '115', '116', '117', '118', '119', '122'])

/**
 * 上游判为「这次请求本身不行」的错误码：
 * 敏感内容、不支持、输入过长、媒体过多、自定义模型服务异常。
 * 这些**不该换账号重试**——换谁问都是一样的结果。
 */
const REQUEST_CODES = new Set(['406', '416', '430', '80411', '80412', '100400', '100401', '100403'])

/** 模型自己的上游供应商挂了（不是我们的请求或账号问题）。 */
const UPSTREAM_FAILED = /\berror in upstream response\b/i

/** 排队时没说等多久，默认 30 秒。 */
const BUSY_WAIT = 30

/** 失败分类的结果。 */
export interface Failure {
  /** 对 DSH 报的状态码。 */
  status: number
  /** 给用户看的话。 */
  message: string
  /** 归类，用于决定是否值得换账号重试。 */
  code: string
  /** 建议等待秒数（仅排队/限流时有）。 */
  retryAfter?: number
  /** 是否说明登录已失效。 */
  lapsed?: boolean
}

/**
 * 把上游的失败读成我们认识的东西。
 *
 * 顺序就是 magpie 的顺序，每一步都有理由：
 *  1. 排队码 → 忙，503 + Retry-After（换号无用，池子是同一个）
 *  2. 额度码 → 429（换号有意义）
 *  3. 请求码 → 400（换号无用，请求本身不行）
 *  4. 上游供应商挂 → 502（值得重试）
 *  5. 401/403 → 登录问题
 *  6. 其余 429 / 含 quota 字样 → 额度
 *  7. 兜底原样回
 */
export function failure(status: number, text: string): Failure {
  if (status < 400 || status > 599) status = 502
  let msg = String(text ?? '').trim()
  let code = ''
  let queue: Record<string, unknown> | undefined

  try {
    let j = JSON.parse(msg) as Record<string, unknown>
    // 外层可能是 HTTP 包装，真正的排队体藏在 message 里
    const outerCode = j?.code == null ? '' : String(j.code)
    if (['', '401', '403'].includes(outerCode) && typeof j?.message === 'string') {
      try {
        const inner = JSON.parse(j.message.trim()) as Record<string, unknown>
        if (inner && !Array.isArray(inner) && String(inner.code) === QUEUED) j = inner
      } catch {
        // message 不是 JSON，忽略
      }
    }
    code = j?.code == null ? '' : String(j.code)
    if (j?.message) msg = String(j.message)

    const rawDetails = j?.details
    const d = (typeof rawDetails === 'string' ? JSON.parse(rawDetails.trim()) : rawDetails) as
      | { error?: { message?: string } }
      | undefined
    if (d?.error?.message) msg += ': ' + d.error.message

    // 排队状态：可能是对象，也可能是 message 里的 JSON 字符串
    const q = j?.queue
    if (q && typeof q === 'object') queue = q as Record<string, unknown>
    if (!queue && typeof j?.message === 'string' && j.message.trim().startsWith('{')) {
      const parsed = JSON.parse(j.message.trim()) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && ('isQueued' in parsed || 'serviceAvailable' in parsed || 'retryAfterSeconds' in parsed)) {
        queue = parsed
      }
    }
  } catch {
    // 不是 JSON，按纯文本处理
  }

  if (msg === '') msg = `HTTP ${status}`

  // 1. 模型池排队
  if (code === QUEUED || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const n = Number(queue?.retryAfterSeconds)
    const wait = Number.isFinite(n) && n > 0 ? Math.ceil(n) : BUSY_WAIT
    const model = queue?.modelKey ? ` for ${queue.modelKey}` : ''
    const aheadCount = Number(queue?.queueCount)
    const ahead = Number.isFinite(aheadCount) && aheadCount > 0 ? `, ${Math.floor(aheadCount)} ahead` : ''
    const what = queue?.isQueued === true ? 'queued the request' : 'is busy'
    return {
      status: 503,
      message: `千问办公${what === 'is busy' ? ' 正忙' : ' 已排队'}${model}; 约 ${wait} 秒后重试`,
      code: 'QUEUED',
      retryAfter: wait,
    }
  }

  // 2. 额度用尽
  if (QUOTA_CODES.has(code)) {
    return { status: 429, message: `用量已用完：${msg}`, code: 'QUOTA_EXCEEDED' }
  }

  // 3. 请求本身被拒（换号无用）
  if (REQUEST_CODES.has(code)) {
    return { status: 400, message: `千问办公拒绝了这次请求（${code}）：${msg}`, code: 'INVALID_REQUEST' }
  }

  // 4. 模型背后的供应商挂了
  if (UPSTREAM_FAILED.test(msg)) {
    return { status: 502, message: msg, code: 'SERVER' }
  }

  /**
   * 上游 429「All models failed」是**模型池暂时没有可用实例**，不是额度耗尽。
   *
   * 这个必须放在额度判断之前：实测多轮循环第 4 轮就会撞上，账号明明还有
   * 899 credits。误判成额度会导致插件直接放弃，表现就是「跑一会儿就停」。
   * 归为可重试的服务端错误，让调用方等一会儿再来。
   */
  if (/all models failed/i.test(msg)) {
    return {
      status: 503,
      message: `千问办公模型池暂时不可用（${msg}），稍后重试`,
      code: 'MODEL_POOL_BUSY',
      retryAfter: BUSY_WAIT,
    }
  }

  // 5. 登录失效
  if (status === 401 || status === 403) {
    const said = msg && msg !== `HTTP ${status}` ? `（上游说 ${status}：${msg.slice(0, 300)}）` : ''
    return { status: 401, message: `登录已失效，请重新登录${said}`, code: 'AUTH', lapsed: true }
  }

  // 6. 明确说额度（必须是额度字眼，不能只看 429）
  if (/quota|credits?|usage limit|insufficient|balance/i.test(msg)) {
    return { status: 429, message: `用量已用完：${msg}`, code: 'QUOTA_EXCEEDED' }
  }
  // 429 但没有额度字眼：按限流处理，等一会儿再来
  if (status === 429) {
    return { status: 429, message: `上游限流：${msg}`, code: 'MODEL_POOL_BUSY', retryAfter: BUSY_WAIT }
  }

  // 7. 兜底
  return { status, message: msg, code: status >= 500 ? 'SERVER' : 'INVALID_REQUEST' }
}

/** 上游的一个错误。 */
export class UpstreamError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter?: number
  readonly lapsed?: boolean

  constructor(f: Failure) {
    super(f.message)
    this.status = f.status
    this.code = f.code
    if (f.retryAfter !== undefined) this.retryAfter = f.retryAfter
    if (f.lapsed !== undefined) this.lapsed = f.lapsed
  }

  static from(status: number, text: string): UpstreamError {
    return new UpstreamError(failure(status, text))
  }
}

// ── SSE 解析 ──────────────────────────────────────────────────────────────

/** 逐行切 SSE。 */
async function* sseLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let n: number
    while ((n = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, n).trim()
      buf = buf.slice(n + 1)
    }
  }
  if (buf.trim()) yield buf.trim()
}

/** 上游一个 chunk 的形状（只声明用到的）。 */
interface UpstreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; code?: number | string }
  code?: number | string
  message?: string
}

/**
 * 把 QwenWork 的 SSE 流转成 DSH chunk。
 *
 * @param body  fetch 的 response.body
 * @param model 模型显示名，仅用于错误信息
 */
export async function* toStreamChunks(
  body: AsyncIterable<Uint8Array>,
  model: string,
): AsyncGenerator<StreamChunk> {
  let textIndex = -1
  let reasoningIndex = -1
  let textOpen = false
  let reasoningOpen = false
  const textBuffer = new Map<number, string>()
  const reasoningBuffer = new Map<number, string>()

  /** 上游 tool call 累积：index -> {id, name, args} */
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  const toolIndexes = new Map<number, number>()
  /** 工具块的下标从 1000 起，和文本/思考块分开，避免撞号。 */
  let nextToolIndex = 1000
  let sawToolCall = false
  let finishReason = ''
  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null = null

  for await (const raw of sseLines(body)) {
    if (!raw.startsWith('data:')) continue
    const payload = raw.slice(5).trim()
    if (payload === '') continue

    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }

    // 外层状态码：非 200 时 body 里是错误信息
    const statusCode = Number(envelope.statusCodeValue ?? envelope.statusCode)
    if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 0) {
      const inner = typeof envelope.body === 'string' ? envelope.body : payload
      throw UpstreamError.from(statusCode >= 400 ? statusCode : 502, inner)
    }

    // 真正的 chunk 在 body 字段里
    let innerText = typeof envelope.body === 'string' ? envelope.body.trim() : ''
    if (innerText === '') innerText = payload
    if (innerText === '[DONE]') break

    // Encode=1 时 body 还是编码过的
    if (looksEncoded(innerText)) {
      try {
        innerText = decodeBody(innerText).trim()
      } catch {
        // 解不开就按原文试
      }
    }
    if (innerText === '[DONE]') break

    let chunk: UpstreamChunk
    try {
      chunk = JSON.parse(innerText) as UpstreamChunk
    } catch {
      continue
    }

    // 帧内报错（有时是 200 里夹错误）
    if (!Array.isArray(chunk.choices) && (chunk.error !== undefined || (chunk.code != null && chunk.message != null))) {
      const raw = String(chunk.code ?? '')
      const status = Number.isFinite(Number(raw)) && Number(raw) >= 400 ? Number(raw) : 502
      throw UpstreamError.from(status, innerText)
    }

    const choice = chunk.choices?.[0]
    const delta = choice?.delta ?? {}

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      if (!reasoningOpen) {
        reasoningIndex += 1
        reasoningOpen = true
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
      }
      reasoningBuffer.set(reasoningIndex, (reasoningBuffer.get(reasoningIndex) ?? '') + delta.reasoning_content)
      yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
    }

    if (typeof delta.content === 'string' && delta.content !== '') {
      // 文本开始时，把还开着的思考块收口
      if (reasoningOpen) {
        reasoningOpen = false
        yield {
          type: 'block-end',
          index: reasoningIndex,
          block: { type: 'reasoning', text: reasoningBuffer.get(reasoningIndex) ?? '' },
        }
      }
      if (!textOpen) {
        textIndex += 1
        textOpen = true
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
      }
      textBuffer.set(textIndex, (textBuffer.get(textIndex) ?? '') + delta.content)
      yield { type: 'text-delta', index: textIndex, text: delta.content }
    }

    for (const tc of delta.tool_calls ?? []) {
      const upstreamIndex = Number(tc.index ?? 0)
      const name = String(tc.function?.name ?? '')
      const args = String(tc.function?.arguments ?? '')
      const id = String(tc.id ?? '')
      if (!id && !name && !args) continue

      let slot = toolCalls.get(upstreamIndex)
      if (!slot) {
        slot = { id: id || `call_${upstreamIndex}_${toolCalls.size}`, name: '', args: '' }
        toolCalls.set(upstreamIndex, slot)
        toolIndexes.set(upstreamIndex, nextToolIndex++)
        sawToolCall = true
        yield { type: 'block-start', index: toolIndexes.get(upstreamIndex)!, blockType: 'tool-call' }
      }
      if (id && !slot.id.startsWith('call_')) slot.id = id
      if (name) slot.name = name
      if (args) slot.args += args
      yield {
        type: 'tool-call-delta',
        index: toolIndexes.get(upstreamIndex)!,
        id: slot.id,
        ...(name ? { name } : {}),
        argumentsDelta: args,
      }
    }

    if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
      finishReason = choice.finish_reason
    }

    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens
      usage = {
        inputTokens: Number(chunk.usage.prompt_tokens ?? 0),
        outputTokens: Number(chunk.usage.completion_tokens ?? 0),
        ...(typeof cached === 'number' && cached > 0 ? { cacheReadTokens: cached } : {}),
      }
    }
  }

  // 收口所有还开着的块
  if (reasoningOpen) {
    yield {
      type: 'block-end',
      index: reasoningIndex,
      block: { type: 'reasoning', text: reasoningBuffer.get(reasoningIndex) ?? '' },
    }
  }
  if (textOpen) {
    yield {
      type: 'block-end',
      index: textIndex,
      block: { type: 'text', text: textBuffer.get(textIndex) ?? '' },
    }
  }
  for (const [upstreamIndex, slot] of toolCalls) {
    yield {
      type: 'block-end',
      index: toolIndexes.get(upstreamIndex)!,
      block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args },
    }
  }

  // 契约：先 usage 再 finish
  yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0 } }

  if (sawToolCall && (finishReason === '' || finishReason === 'tool_calls' || finishReason === 'stop')) {
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  switch (finishReason) {
    case 'length':
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    case 'tool_calls':
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    case 'content_filter':
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `${model}: 内容被上游过滤`, code: 'CONTENT_FILTERED' } } }
      return
    default: {
      // 一个字都没出的 stop 视为异常，避免静默的空回答
      const said = [...textBuffer.values()].join('') + [...reasoningBuffer.values()].join('')
      if (said.trim() === '' && !sawToolCall) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: `${model}: 上游返回了空回答`, code: 'EMPTY_RESPONSE' } },
        }
        return
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
  }
}

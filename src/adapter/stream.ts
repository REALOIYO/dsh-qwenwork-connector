/**
 * QwenWork 的 SSE → DSH StreamChunk。
 *
 * 上游的流是两层信封：每个 `data:` 行是一个 JSON，真正的 OpenAI chunk
 * 在它的 `body` 字段里（字符串）。有时 body 还是 `Encode=1` 编码过的。
 *
 * 输出的 chunk 必须遵守 DSH 契约：
 *  - 文本/思考用 block-start → delta → block-end
 *  - 最后必须以 `usage` 然后 `finish` 结尾
 *
 * 移植自 `@magpie-community/opencode-qoder-auth@0.2.59`（MIT），
 * 原实现 `events` / `sseLines` / `failure`。
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

/** 把上游失败归类成 DSH 认识的 code。 */
function classify(status: number, message: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429 || /quota|credits?|usage limit/i.test(message)) return 'QUOTA_EXCEEDED'
  if (status === 413) return 'INVALID_REQUEST'
  if (/context|too long|length/i.test(message) && /exceed|window|maximum/i.test(message)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status >= 500) return 'SERVER'
  if (status >= 400) return 'INVALID_REQUEST'
  return 'UPSTREAM'
}

/** 上游的一个错误。 */
export class UpstreamError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.code = classify(status, message)
  }
}

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
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; code?: number }
  code?: number | string
  message?: string
}

/**
 * 把 QwenWork 的 SSE 流转成 DSH chunk。
 *
 * @param body     fetch 的 response.body
 * @param model    模型显示名，仅用于错误信息
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

  /** 上游 tool call 的累积：index -> {id, name, args} */
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  const toolIndexes = new Map<number, number>()
  let nextToolIndex = 1000
  let sawToolCall = false
  let finishReason = ''
  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null = null

  const ok = (): void => {
    /* noop */
  }
  void ok

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

    // 外层可能直接报错
    const statusCode = Number(envelope.statusCodeValue ?? envelope.statusCode)
    if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 0) {
      const inner = typeof envelope.body === 'string' ? envelope.body : payload
      throw new UpstreamError(statusCode >= 400 ? statusCode : 502, messageOf(inner))
    }

    // 真正的 chunk 在 body 字段里
    let innerText = typeof envelope.body === 'string' ? envelope.body.trim() : ''
    if (innerText === '') {
      // 有些响应直接把 chunk 放在顶层
      innerText = payload
    }
    if (innerText === '[DONE]') break

    // Encode=1 时 body 还是编码过的
    if (looksEncoded(innerText)) {
      try {
        innerText = decodeBody(innerText).trim()
      } catch {
        // 解不开就按原文试一次
      }
    }
    if (innerText === '[DONE]') break

    let chunk: UpstreamChunk
    try {
      chunk = JSON.parse(innerText) as UpstreamChunk
    } catch {
      continue
    }

    // 帧内报错
    if (!Array.isArray(chunk.choices) && (chunk.error !== undefined || (chunk.code != null && chunk.message != null))) {
      throw new UpstreamError(502, chunk.error?.message ?? chunk.message ?? 'upstream error')
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
      // 文本开始前，先把还开着的思考块收口
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
    const index = toolIndexes.get(upstreamIndex)!
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args },
    }
  }

  // 契约要求：先 usage 再 finish
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

/** 从各种错误外形里挖出可读信息。 */
function messageOf(raw: string): string {
  const text = raw.trim()
  if (text === '') return '上游返回了空错误'
  try {
    const j = JSON.parse(text) as { message?: string; error?: { message?: string }; details?: string }
    const base = j.error?.message ?? j.message ?? text
    if (typeof j.details === 'string') {
      try {
        const d = JSON.parse(j.details) as { error?: { message?: string } }
        if (d.error?.message) return `${base}: ${d.error.message}`
      } catch {
        // details 不是 JSON 就忽略
      }
    }
    return base
  } catch {
    return text.slice(0, 500)
  }
}

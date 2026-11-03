/**
 * 流解析测试。
 *
 * 用构造的 SSE 字节流验证：
 * - 文本 / 思考 / 工具调用的 chunk 序列正确
 * - 最后一定是 usage 然后 finish
 * - 错误帧正确归类
 * - Encode=1 的编码 body 也能解
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toStreamChunks, type StreamChunk } from '../src/adapter/stream.ts'
import { encodeBody } from '../src/adapter/codec.ts'

/** 把若干 SSE 帧拼成可消费的字节流。 */
function streamOf(...frames: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  const text = frames.join('\n\n') + '\n\n'
  return {
    async *[Symbol.asyncIterator]() {
      // 故意切成小块，验证跨 chunk 的行缓冲
      const bytes = enc.encode(text)
      const step = 7
      for (let i = 0; i < bytes.length; i += step) yield bytes.slice(i, i + step)
    },
  }
}

/** 一帧：外层信封包住一个 OpenAI chunk。 */
function frame(chunk: unknown): string {
  return `data: ${JSON.stringify({ body: JSON.stringify(chunk) })}`
}

/** 收集所有 chunk。 */
async function collect(frames: string[], model = 'test-model'): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of toStreamChunks(streamOf(...frames), model)) out.push(c)
  return out
}

test('纯文本流：block-start → delta → block-end → usage → finish', async () => {
  const chunks = await collect([
    frame({ choices: [{ delta: { content: '你好' } }] }),
    frame({ choices: [{ delta: { content: '，世界' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])

  const types = chunks.map(c => c.type)
  assert.equal(types[0], 'block-start')
  assert.equal(types[types.length - 1], 'finish')
  assert.equal(types[types.length - 2], 'usage', '必须以 usage 倒数第二、finish 结尾')

  const text = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')
  assert.equal(text, '你好，世界')

  const end = chunks.find(c => c.type === 'block-end') as { block: { text: string } }
  assert.equal(end.block.text, '你好，世界', 'block-end 要带完整文本')

  const fin = chunks[chunks.length - 1] as { reason: { kind: string } }
  assert.equal(fin.reason.kind, 'stop')
})

test('思考流：先 reasoning 块，文字来临时自动收口', async () => {
  const chunks = await collect([
    frame({ choices: [{ delta: { reasoning_content: '让我想想' } }] }),
    frame({ choices: [{ delta: { reasoning_content: '……' } }] }),
    frame({ choices: [{ delta: { content: '答案是 42' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])

  const kinds = chunks.map(c => (c.type === 'block-start' ? `start:${c.blockType}` : c.type))
  const reasoningEnd = kinds.indexOf('block-end')
  const textStart = kinds.indexOf('start:text')
  assert.ok(reasoningEnd < textStart, '思考块必须在文字块之前收口')

  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => (c as { text: string }).text).join('')
  assert.equal(reasoning, '让我想想……')
})

test('工具调用流：累积参数并以 tool-calls 结束', async () => {
  const chunks = await collect([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ])

  const deltas = chunks.filter(c => c.type === 'tool-call-delta') as Array<{ id: string; name?: string; argumentsDelta: string }>
  assert.equal(deltas.length, 2)
  assert.equal(deltas[0]!.name, 'read_file')
  const args = deltas.map(d => d.argumentsDelta).join('')
  assert.equal(args, '{"path":"a.txt"}', '参数要能跨帧拼接完整')

  const end = chunks.find(c => c.type === 'block-end') as { block: { type: string; name: string; arguments: string } }
  assert.equal(end.block.type, 'tool-call')
  assert.equal(end.block.name, 'read_file')
  assert.equal(end.block.arguments, '{"path":"a.txt"}')

  const fin = chunks[chunks.length - 1] as { reason: { kind: string } }
  assert.equal(fin.reason.kind, 'tool-calls')
})

test('usage 被读出来', async () => {
  const chunks = await collect([
    frame({ choices: [{ delta: { content: 'hi' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } }),
  ])
  const usage = chunks.find(c => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } }
  assert.equal(usage.usage.inputTokens, 100)
  assert.equal(usage.usage.outputTokens, 20)
  assert.equal(usage.usage.cacheReadTokens, 60)
})

test('[DONE] 结束不报错', async () => {
  const chunks = await collect([
    frame({ choices: [{ delta: { content: 'ok' } }] }),
    'data: [DONE]',
  ])
  const fin = chunks[chunks.length - 1] as { reason: { kind: string } }
  assert.equal(fin.reason.kind, 'stop')
})

test('Encode=1 的编码 body 也能解', async () => {
  const inner = JSON.stringify({ choices: [{ delta: { content: '编码内容' } }] })
  const wire = encodeBody(inner)
  const chunks = await collect([
    `data: ${JSON.stringify({ body: wire })}`,
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])
  const text = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')
  assert.equal(text, '编码内容')
})

test('max-tokens 结束映射正确', async () => {
  const chunks = await collect([
    frame({ choices: [{ delta: { content: 'x' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ])
  const fin = chunks[chunks.length - 1] as { reason: { kind: string } }
  assert.equal(fin.reason.kind, 'max-tokens')
})

test('帧内错误抛 UpstreamError 并带 code', async () => {
  const frames = [`data: ${JSON.stringify({ body: JSON.stringify({ error: { message: 'usage limit reached', code: 429 } }) })}`]
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(...frames), 'm')) void _
  }, (e: unknown) => {
    const err = e as { code?: string; message: string }
    assert.equal(err.code, 'QUOTA_EXCEEDED')
    return true
  })
})

test('空回答报 EMPTY_RESPONSE 而非静默 stop', async () => {
  const chunks = await collect([
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])
  const fin = chunks[chunks.length - 1] as { reason: { kind: string; failure?: { code: string } } }
  assert.equal(fin.reason.kind, 'error')
  assert.equal(fin.reason.failure?.code, 'EMPTY_RESPONSE')
})

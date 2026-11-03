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

test('帧内额度错误归类为 QUOTA_EXCEEDED', async () => {
  const frames = [`data: ${JSON.stringify({ body: JSON.stringify({ error: { message: 'usage limit reached', code: 429 } }) })}`]
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(...frames), 'm')) void _
  }, (e: unknown) => {
    const err = e as { code?: string; message: string }
    assert.equal(err.code, 'QUOTA_EXCEEDED')
    return true
  })
})

test('上游 429「All models failed」能读出原始信息', async () => {
  // 实测上游模型池打满时返回这个，message 原样保留给用户排查
  const frame429 = `data: ${JSON.stringify({ body: JSON.stringify({ code: '429', message: 'All models failed' }), statusCodeValue: 429, statusCode: 'Too Many Requests' })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame429), 'm')) void _
  }, (e: unknown) => {
    const err = e as { code?: string; message: string }
    assert.ok(err.message.includes('All models failed'), `应保留上游原话，得到 ${err.message}`)
    return true
  })
})

test('额度码 110-122 判为 QUOTA_EXCEEDED', async () => {
  const frame = `data: ${JSON.stringify({ body: JSON.stringify({ code: '110', message: 'credit exhausted' }) })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame), 'm')) void _
  }, (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'QUOTA_EXCEEDED')
    return true
  })
})

test('请求码 100400 判为 INVALID_REQUEST（换号无用）', async () => {
  const frame = `data: ${JSON.stringify({ body: JSON.stringify({ code: '100400', message: 'content not supported' }) })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame), 'm')) void _
  }, (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'INVALID_REQUEST')
    return true
  })
})

test('排队码 10605 判为 QUEUED 并带 Retry-After', async () => {
  const frame = `data: ${JSON.stringify({ body: JSON.stringify({ code: '10605', message: 'busy', queue: { isQueued: true, retryAfterSeconds: 12 } }) })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame), 'm')) void _
  }, (e: unknown) => {
    const err = e as { code?: string; retryAfter?: number }
    assert.equal(err.code, 'QUEUED')
    assert.equal(err.retryAfter, 12)
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

test('"All models failed" 是模型池忙，不是额度耗尽（这是「跑一会儿就停」的根因）', async () => {
  const frame = `data: ${JSON.stringify({ body: JSON.stringify({ code: '429', message: 'All models failed' }), statusCodeValue: 429 })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame), 'm')) void _
  }, (e: unknown) => {
    const err = e as { code?: string; message: string; retryAfter?: number }
    assert.equal(err.code, 'MODEL_POOL_BUSY', `不该判成额度，得到 ${err.code}: ${err.message}`)
    assert.ok((err.retryAfter ?? 0) > 0, '应带 Retry-After 让调用方退避')
    return true
  })
})

test('真额度耗尽仍然判 QUOTA_EXCEEDED', async () => {
  const frame = `data: ${JSON.stringify({ body: JSON.stringify({ code: '429', message: 'usage limit reached: no credits' }), statusCodeValue: 429 })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame), 'm')) void _
  }, (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'QUOTA_EXCEEDED')
    return true
  })
})

test('泛词 balance 不应误判为额度耗尽（429 但没额度语义 = 池子忙）', async () => {
  const frame = `data: ${JSON.stringify({
    body: JSON.stringify({ code: '429', message: 'load balance failed, please retry' }),
    statusCodeValue: 429,
  })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame), 'm')) void _
  }, (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'MODEL_POOL_BUSY', '不该判成 QUOTA_EXCEEDED')
    return true
  })
})

test('「额度/余额」中文提示也要认成额度用完', async () => {
  const frame = `data: ${JSON.stringify({
    body: JSON.stringify({ code: '429', message: '当前套餐额度已用尽' }),
    statusCodeValue: 429,
  })}`
  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frame), 'm')) void _
  }, (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'QUOTA_EXCEEDED')
    return true
  })
})

test('回归：思考块与正文块的 index 必须不同（曾经都从 0 开始撞号）', async () => {
  // 模型「先想再答」：reasoning 用 index 0，随后 text 又从 0 开始。
  // DSH 的 BlockAssembler 按 index 认块，撞号会让正文 delta 灌进
  // 已关闭的 reasoning 块、整段丢失 —— 表现为「只有思维链没有正文」。
  const frames = [
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' } }] }) })}`,
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { content: '答案是' } }] }) })}`,
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { content: '42' } }] }) })}`,
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) })}`,
    'data: [DONE]',
  ].join('\n\n')

  const seen = new Set<number>()
  const starts: Array<{ index: number; blockType: string }> = []
  for await (const c of toStreamChunks(streamOf(frames), 'm')) {
    if (c.type === 'block-start') {
      starts.push({ index: c.index, blockType: c.blockType })
      assert.ok(!seen.has(c.index), `index ${c.index} 被重复使用（${c.blockType}）`)
      seen.add(c.index)
    }
  }
  assert.equal(starts.length, 2, '应有思考与正文两个块')
  assert.deepEqual(starts.map(s => s.blockType), ['reasoning', 'text'])
  assert.notEqual(starts[0]!.index, starts[1]!.index, '两个块的 index 必须不同')
})

test('回归：正文内容完整，不因翻块丢失', async () => {
  const frames = [
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) })}`,
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) })}`,
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { content: ' world' } }] }) })}`,
    'data: [DONE]',
  ].join('\n\n')

  let text = ''
  const ends: Array<{ type: string; text: string }> = []
  for await (const c of toStreamChunks(streamOf(frames), 'm')) {
    if (c.type === 'text-delta') text += c.text
    if (c.type === 'block-end' && (c.block.type === 'text' || c.block.type === 'reasoning')) {
      ends.push({ type: c.block.type, text: c.block.text })
    }
  }
  assert.equal(text, 'Hello world', '正文一个字都不能少')
  const textBlock = ends.find(e => e.type === 'text')
  assert.equal(textBlock?.text, 'Hello world', 'block-end 里的正文也要完整')
})

test('回归：无名工具调用时 block-start 必须有配对的 block-end', async () => {
  // 曾经在收尾时把坏块从 map 里删掉，导致已经发出的 block-start 配不到
  // block-end，DSH 的 assembler 会一直等那个块收口。
  const frames = [
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { content: '我先看看' } }] }) })}`,
    // 只有 id 没有 name：坏调用
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { arguments: '{}' } }] } }] }) })}`,
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) })}`,
    'data: [DONE]',
  ].join('\n\n')

  const starts = new Set<number>()
  const ends = new Set<number>()
  let finish: unknown = null
  try {
    for await (const c of toStreamChunks(streamOf(frames), 'm')) {
      if (c.type === 'block-start') starts.add(c.index)
      if (c.type === 'block-end') ends.add(c.index)
      if (c.type === 'finish') finish = c.reason
    }
  } catch (e) {
    // 有正文时不该抛，应该用 finish reason 表达
    assert.fail(`不该抛错，应通过 finish 表达：${(e as Error).message}`)
  }

  assert.deepEqual([...starts].sort(), [...ends].sort(), '每个 block-start 都要有 block-end')
  const reason = finish as { kind: string; failure?: { code: string } }
  assert.equal(reason.kind, 'error', '坏调用要标成错误')
  assert.equal(reason.failure?.code, 'UNNAMED_TOOL_CALL')
})

test('无名工具调用且无正文时，明确报错而不是静默结束', async () => {
  const frames = [
    `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { arguments: '{}' } }] } }] }) })}`,
    'data: [DONE]',
  ].join('\n\n')

  await assert.rejects(async () => {
    for await (const _ of toStreamChunks(streamOf(frames), 'm')) void _
  }, (e: unknown) => {
    assert.match(String((e as Error).message), /没有名字|UNNAMED/, '要说清是无名调用')
    return true
  })
})

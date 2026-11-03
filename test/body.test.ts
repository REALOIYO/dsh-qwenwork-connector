/**
 * 请求体构造测试。
 *
 * 重点验证几个容易出错的地方：
 * - tool 结果必须严格配对到 tool_call（id 丢了要按顺序补）
 * - system 提示要有两份（system 字段 + messages 首条）
 * - 小额度请求不思考
 * - 无 type 的 oneOf 补成 object
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildBody, qwenworkMessages, textOf, QWENWORK_SYSTEM_PROMPT, type ModelEntry } from '../src/adapter/body.ts'

const model: ModelEntry = {
  key: 'qwen3.8-max-preview',
  displayName: 'Qwen3.8-Max',
  isReasoning: true,
  maxInputTokens: 131072,
}

test('基础请求：system 有两份，用户消息在', () => {
  const body = buildBody(
    {
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
      max_tokens: 32000,
    },
    model,
    'sess-1',
    'req-1',
    'task-1',
  )

  // system 字段
  const sys = body.system as Array<{ text: string }>
  assert.ok(sys[0]!.text.startsWith(QWENWORK_SYSTEM_PROMPT), 'system 应以客户端固定提示开头')
  assert.ok(sys[0]!.text.includes('你是助手'), '用户的 system 应被拼进去')

  // messages 首条也是 system
  const msgs = body.messages as Array<{ role: string }>
  assert.equal(msgs[0]!.role, 'system')

  assert.equal(body.session_id, 'sess-1')
  assert.equal(body.request_id, 'req-1')
  const cfg = body.model_config as Record<string, unknown>
  assert.equal(cfg.key, 'qwen3.8-max-preview')
  assert.equal(cfg.is_reasoning, true)
  // 客户端字段
  assert.equal(body.agent_id, 'agent_common')
  assert.equal(body.session_type, 'qoder_work')
  const biz = body.business as Record<string, unknown>
  assert.equal(biz.product, 'qoder_work')
})

test('模型 key 为 auto/default 要抛错', () => {
  const bad: ModelEntry = { key: 'auto', displayName: 'x' }
  assert.throws(
    () => buildBody({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }, bad, 's', 'r', 't'),
    /模型 key 不可用/,
  )
})

test('tool 结果按 id 配对到 call', () => {
  const turns = qwenworkMessages([
    { role: 'user', content: '读一下文件' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } }],
    },
    { role: 'tool', content: '文件内容', tool_call_id: 'call_a' },
  ])

  assert.equal(turns.length, 3)
  assert.equal(turns[0]!.role, 'user')
  assert.equal(turns[1]!.role, 'assistant')
  assert.equal(turns[2]!.role, 'tool')
  assert.equal(turns[2]!.tool_call_id, 'call_a')
  assert.equal(turns[2]!.content, '文件内容')
})

test('tool 结果丢了 id 时按顺序认领最早的 call', () => {
  const turns = qwenworkMessages([
    { role: 'user', content: '并行读两个' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', function: { name: 'read', arguments: '{}' } },
        { id: 'c2', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: '结果一' }, // 没有 tool_call_id
    { role: 'tool', content: '结果二' },
  ])

  const tools = turns.filter(t => t.role === 'tool')
  assert.equal(tools.length, 2)
  assert.equal(tools[0]!.tool_call_id, 'c1', '第一个结果应认领第一个 call')
  assert.equal(tools[1]!.tool_call_id, 'c2')
})

test('没有可答 call 的 tool 结果并回用户轮，不丢字', () => {
  const turns = qwenworkMessages([
    { role: 'user', content: '问题' },
    { role: 'tool', content: '孤立的结果' },
  ])
  const userTurns = turns.filter(t => t.role === 'user')
  const joined = JSON.stringify(userTurns)
  assert.ok(joined.includes('孤立的结果'), '孤立结果不应丢失')
})

test('assistant 的思考内容回传', () => {
  const turns = qwenworkMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '答', reasoning_content: '想过' },
  ])
  const a = turns.find(t => t.role === 'assistant') as Record<string, unknown>
  assert.equal(a.reasoning_content, '想过')
})

test('最后一条用户消息的末块打 prompt cache 标记', () => {
  const body = buildBody(
    {
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: [{ type: 'text', text: '第二问' }] },
      ],
      max_tokens: 1000,
    },
    model,
    's', 'r', 't',
  )

  const msgs = body.messages as Array<{ role: string; content: unknown }>
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')!
  const blocks = lastUser.content as Array<Record<string, unknown>>
  assert.deepEqual(blocks[blocks.length - 1]!.cache_control, { type: 'ephemeral' })
})

test('小额度请求不思考（标题/分类这类调用）', () => {
  const body = buildBody(
    { messages: [{ role: 'user', content: '起个标题' }], max_tokens: 64 },
    model, 's', 'r', 't',
  )
  const params = body.parameters as Record<string, unknown>
  assert.equal(params.enable_thinking, false, '预算 ≤1024 不应思考')
})

test('reasoning_effort=none 不思考', () => {
  const body = buildBody(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 32000, reasoning_effort: 'none' },
    model, 's', 'r', 't',
  )
  assert.equal((body.parameters as Record<string, unknown>).enable_thinking, false)
})

test('非思考模型始终不思考', () => {
  const plain: ModelEntry = { key: 'flash', displayName: '标准', isReasoning: false }
  const body = buildBody(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 32000, reasoning_effort: 'high' },
    plain, 's', 'r', 't',
  )
  assert.equal((body.parameters as Record<string, unknown>).enable_thinking, false)
  assert.equal((body.model_config as Record<string, unknown>).is_reasoning, false)
})

test('工具声明被带上，无 type 的 oneOf 补 object', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tools: [{
        type: 'function',
        function: {
          name: 'do_it',
          description: '做事',
          parameters: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
      }],
    },
    model, 's', 'r', 't',
  )

  const tools = body.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>
  assert.equal(tools.length, 1)
  assert.equal(tools[0]!.function.name, 'do_it')
  assert.equal(tools[0]!.function.parameters.type, 'object', '无 type 的 oneOf 应补成 object')
  assert.ok(Array.isArray(tools[0]!.function.parameters.oneOf))
})

test('tool_choice=none 时不带工具', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'do_it' } }],
    },
    model, 's', 'r', 't',
  )
  assert.equal(body.tools, undefined)
})

test('textOf 处理字符串与块数组', () => {
  assert.equal(textOf('abc'), 'abc')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOf([{ type: 'image_url', image_url: { url: 'x' } }]), '')
  assert.equal(textOf(null), '')
})

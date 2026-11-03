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
import type { Task } from '../src/adapter/session.ts'

/** 造一个测试用任务。 */
const aTask = (id = 'task-1'): Task => ({ id, begin: 1700000000000, answered: false, name: 'test', used: Date.now() })

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
    aTask('task-1'),
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
    () => buildBody({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }, bad, 's', 'r', aTask()),
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
    's', 'r', aTask(),
  )

  const msgs = body.messages as Array<{ role: string; content: unknown }>
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')!
  const blocks = lastUser.content as Array<Record<string, unknown>>
  assert.deepEqual(blocks[blocks.length - 1]!.cache_control, { type: 'ephemeral' })
})

test('小额度请求不思考（标题/分类这类调用）', () => {
  const body = buildBody(
    { messages: [{ role: 'user', content: '起个标题' }], max_tokens: 64 },
    model, 's', 'r', aTask(),
  )
  const params = body.parameters as Record<string, unknown>
  assert.equal(params.enable_thinking, false, '预算 ≤1024 不应思考')
})

test('reasoning_effort=none 不思考', () => {
  const body = buildBody(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 32000, reasoning_effort: 'none' },
    model, 's', 'r', aTask(),
  )
  assert.equal((body.parameters as Record<string, unknown>).enable_thinking, false)
})

test('非思考模型始终不思考', () => {
  const plain: ModelEntry = { key: 'flash', displayName: '标准', isReasoning: false }
  const body = buildBody(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 32000, reasoning_effort: 'high' },
    plain, 's', 'r', aTask(),
  )
  assert.equal((body.parameters as Record<string, unknown>).enable_thinking, false)
  assert.equal((body.model_config as Record<string, unknown>).is_reasoning, false)
})

test('工具声明被带上；every 分支都是 object 的 oneOf 补 type', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tools: [{
        type: 'function',
        function: {
          name: 'do_it',
          description: '做事',
          parameters: { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] },
        },
      }],
    },
    model, 's', 'r', aTask(),
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
    model, 's', 'r', aTask(),
  )
  assert.equal(body.tools, undefined)
})

test('textOf 处理字符串与块数组', () => {
  assert.equal(textOf('abc'), 'abc')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOf([{ type: 'image_url', image_url: { url: 'x' } }]), '')
  assert.equal(textOf(null), '')
})

test('嵌套在 properties 里的 oneOf 也要补 type（只补顶层不够）', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tools: [{
        type: 'function',
        function: {
          name: 'nested',
          parameters: {
            type: 'object',
            properties: {
              // 深层节点：没有 type，但两个分支都是 object
              payload: { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object' }] },
            },
          },
        },
      }],
    },
    model, 's', 'r', aTask(),
  )
  const tools = body.tools as Array<{ function: { parameters: Record<string, any> } }>
  const payload = tools[0]!.function.parameters.properties.payload
  assert.equal(payload.type, 'object', '深层 oneOf 也要补 type')
})

test('分支不是 object 的 oneOf 不动（string|number 保持原样）', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tools: [{
        type: 'function',
        function: { name: 'mix', parameters: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      }],
    },
    model, 's', 'r', aTask(),
  )
  const tools = body.tools as Array<{ function: { parameters: Record<string, any> } }>
  assert.equal(tools[0]!.function.parameters.type, undefined, '混合类型不该被强改成 object')
})

test('宿主给的扁平工具定义必须透传（回归：曾经全被过滤掉）', () => {
  // DSH 实际传下来的形状是 { name, description, parameters }，
  // 没有 type:'function' 也没有 function 包装。曾经只认包装形状，
  // 结果 23 个工具全部被丢弃，模型无工具可调，只吐思考就结束。
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tools: [
        { name: 'list_agents', description: '列出队友', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'ops_bash', description: '跑命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['description'] } },
      ],
    },
    model, 's', 'r', aTask(),
  )

  const tools = body.tools as Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>
  assert.equal(tools.length, 2, '两个扁平工具都要保留')
  assert.equal(tools[0]!.function.name, 'list_agents')
  assert.equal(tools[0]!.function.description, '列出队友')
  assert.equal(tools[1]!.function.name, 'ops_bash')
})

test('两种工具形状混着传，一个都不能丢', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tools: [
        { name: 'flat_one', description: '扁平', parameters: { type: 'object', properties: {} } },
        { type: 'function', function: { name: 'wrapped_one', description: '包装', parameters: { type: 'object', properties: {} } } },
      ],
    },
    model, 's', 'r', aTask(),
  )
  const tools = body.tools as Array<{ function: { name: string } }>
  assert.equal(tools.length, 2)
  assert.deepEqual(tools.map(t => t.function.name).sort(), ['flat_one', 'wrapped_one'])
})

test('没有名字的工具被丢弃，但不会连累其他工具', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1000,
      tools: [
        { name: 'good', description: '正常', parameters: { type: 'object', properties: {} } },
        { description: '没有名字', parameters: { type: 'object' } },
        undefined as never,
        { type: 'function', function: {} },
      ],
    },
    model, 's', 'r', aTask(),
  )
  const tools = body.tools as Array<{ function: { name: string } }>
  assert.equal(tools.length, 1, '只留下有名有姓的')
  assert.equal(tools[0]!.function.name, 'good')
})

test('回归：options.system 字段必须并进系统提示（DSH 真正传的是它）', () => {
  // 曾经只读 messages 里的 system 角色消息，DSH 的 options.system 被
  // 整个忽略 —— 实测传「你叫小白」过去，模型照样自称 QwenWork。
  const body = buildBody(
    {
      system: '你的名字叫小白',
      messages: [{ role: 'user', content: '你是谁' }],
      maxTokens: 100,
    },
    model, 's', 'r', aTask(),
  )
  const sys = JSON.stringify(body.system) + JSON.stringify(body.messages)
  assert.ok(sys.includes('你的名字叫小白'), '宿主给的 system 必须出现在提示里')
})

test('回归：system 与消息体 system 同时存在时都要保留', () => {
  const body = buildBody(
    {
      system: '来自字段',
      messages: [
        { role: 'system', content: '来自消息' },
        { role: 'user', content: '嗨' },
      ],
      maxTokens: 100,
    },
    model, 's', 'r', aTask(),
  )
  const sys = JSON.stringify(body.system)
  assert.ok(sys.includes('来自字段'), '字段来源要在')
  assert.ok(sys.includes('来自消息'), '消息来源也要在')
  // 字段来源排在前
  assert.ok(sys.indexOf('来自字段') < sys.indexOf('来自消息'), '宿主字段应在前')
})

test('回归：驼峰 maxTokens 生效（此前只认 max_tokens，上限永远默认值）', () => {
  const withCamel = buildBody(
    { messages: [{ role: 'user', content: 'x' }], maxTokens: 1234 },
    model, 's', 'r', aTask(),
  )
  const withSnake = buildBody(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 1234 },
    model, 's', 'r', aTask(),
  )
  assert.equal((withCamel.parameters as Record<string, unknown>).max_tokens, 1234, '驼峰要认')
  assert.equal((withSnake.parameters as Record<string, unknown>).max_tokens, 1234, '下划线也要认')
})

test('回归：驼峰 reasoningEffort 生效', () => {
  // 模型没有档位阶梯时只发 enable_thinking；关掉思考要能让它变 false
  const off = buildBody(
    { messages: [{ role: 'user', content: 'x' }], maxTokens: 8000, reasoningEffort: 'off' },
    model, 's', 'r', aTask(),
  )
  const on = buildBody(
    { messages: [{ role: 'user', content: 'x' }], maxTokens: 8000 },
    model, 's', 'r', aTask(),
  )
  assert.equal((off.parameters as Record<string, unknown>).enable_thinking, false, 'off 应关思考')
  assert.equal((on.parameters as Record<string, unknown>).enable_thinking, true, '默认应开思考')
})

test('回归：toolChoice 驼峰也认', () => {
  const body = buildBody(
    {
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 100,
      toolChoice: 'none',
      tools: [{ name: 'foo', description: 'd', parameters: { type: 'object', properties: {} } }],
    },
    model, 's', 'r', aTask(),
  )
  assert.equal(body.tools, undefined, 'toolChoice=none 时不该带工具')
})

// ── DSH 真实形状（这是宿主实际传的，OpenAI 形状只是兼容） ──────────────

test('回归：DSH 形状的工具调用（content 里的 tool-call 块）不能被丢掉', () => {
  // 曾经只读 message.tool_calls，DSH 的 tool-call 块被当普通内容，
  // 整轮 assistant 因为「没有文本」被 continue 丢弃。
  const turns = qwenworkMessages([
    { role: 'user', content: [{ type: 'text', text: '读一下 a.txt' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '要读文件' },
        { type: 'tool-call', id: 'call_x', name: 'read_file', arguments: { path: 'a.txt' } },
      ],
    },
    { role: 'tool', toolCallId: 'call_x', content: [{ type: 'text', text: '文件内容' }] },
  ])

  const assistant = turns.find(t => t.role === 'assistant')
  assert.ok(assistant, 'assistant 轮不能消失')
  const calls = assistant.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>
  assert.equal(calls.length, 1, '要认出那个工具调用')
  assert.equal(calls[0]!.id, 'call_x')
  assert.equal(calls[0]!.function.name, 'read_file')
  assert.equal(calls[0]!.function.arguments, '{"path":"a.txt"}', '对象参数要序列化成字符串')

  const tool = turns.find(t => t.role === 'tool')
  assert.ok(tool, '工具结果不能丢')
  assert.equal(tool.tool_call_id, 'call_x', '驼峰 toolCallId 要能对上')
  assert.equal(tool.content, '文件内容')
})

test('回归：DSH 形状的 toolCallId 用于配对，不能并回 user 轮', () => {
  const turns = qwenworkMessages([
    { role: 'user', content: [{ type: 'text', text: '跑两个命令' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c-a', name: 'ops_bash', arguments: { command: 'echo a' } },
        { type: 'tool-call', id: 'c-b', name: 'ops_bash', arguments: { command: 'echo b' } },
      ],
    },
    { role: 'tool', toolCallId: 'c-b', content: [{ type: 'text', text: '结果B' }] },
    { role: 'tool', toolCallId: 'c-a', content: [{ type: 'text', text: '结果A' }] },
  ])

  const tools = turns.filter(t => t.role === 'tool')
  assert.equal(tools.length, 2, '两个结果都要是 tool 轮')
  // 按 id 配对，不是按顺序
  const byId = new Map(tools.map(t => [t.tool_call_id as string, t.content]))
  assert.equal(byId.get('c-a'), '结果A')
  assert.equal(byId.get('c-b'), '结果B')
})

test('DSH 与 OpenAI 两种工具形状混用也能处理', () => {
  const turns = qwenworkMessages([
    { role: 'user', content: 'x' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'ds-call', name: 'aa', arguments: '{}' }],
      tool_calls: [{ id: 'oa-call', function: { name: 'bb', arguments: '{}' } }],
    },
    { role: 'tool', toolCallId: 'ds-call', content: 'A' },
    { role: 'tool', tool_call_id: 'oa-call', content: 'B' },
  ])
  const assistant = turns.find(t => t.role === 'assistant')
  const calls = assistant!.tool_calls as Array<{ id: string }>
  assert.equal(calls.length, 2, '两种来源的调用都要保留')
  const tools = turns.filter(t => t.role === 'tool')
  assert.equal(tools.length, 2, '两种 id 写法都要能配对')
})

test('回归：user 消息里内嵌的 tool-result 块要拆成独立 tool 轮', () => {
  // DSH 有时不把工具结果发成 role:'tool' 消息，而是塞在 user content 里
  // 当 { type:'tool-result', toolCallId, content } 块。曾经把这些块当普通
  // 内容丢掉，模型看不到工具返回值。
  const turns = qwenworkMessages([
    { role: 'user', content: [{ type: 'text', text: '读文件' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-1', name: 'read_file', arguments: { path: 'a' } }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'tc-1', content: [{ type: 'text', text: 'AAAA' }] },
      ],
    },
  ])

  const tool = turns.find(t => t.role === 'tool')
  assert.ok(tool, '内嵌的 tool-result 要被拆出来')
  assert.equal(tool.tool_call_id, 'tc-1', 'id 要能从驼峰 toolCallId 对上')
  assert.equal(tool.content, 'AAAA', '内容不能丢')
})

test('内嵌 tool-result 与正文同时存在时都要保留', () => {
  const turns = qwenworkMessages([
    { role: 'user', content: [{ type: 'text', text: 'x' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-1', name: 'f', arguments: {} }],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '顺便说一句' },
        { type: 'tool-result', toolCallId: 'tc-1', content: [{ type: 'text', text: 'R' }] },
      ],
    },
  ])
  const texts = turns.filter(t => t.role === 'user').flatMap(t =>
    Array.isArray(t.content) ? t.content.filter((b: { type?: string }) => b.type === 'text').map((b: { text: string }) => b.text) : [],
  )
  assert.ok(texts.includes('顺便说一句'), '正文要留')
  const tool = turns.find(t => t.role === 'tool')
  assert.equal(tool?.content, 'R', '工具结果也要留')
})

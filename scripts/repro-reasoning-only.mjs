/**
 * 复现「只有思维链、没有正文」。
 *
 * 场景取自真实会话 session-e1d0b23d（用户提示「使用多个子代理来自检
 * dsh 和本机环境，注意速度」）。逐项加变量，看哪一项让它不出正文：
 *
 *   1. 纯文本、短提示            → 基线
 *   2. 带工具定义（DSH 那样的）   → 看工具是否吃掉正文
 *   3. 带长 system prompt        → 看长上下文是否影响
 *   4. 三者叠加                  → 尽量贴近真实
 *
 * 用法：node scripts/repro-reasoning-only.mjs [model]
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

const DATA_DIR = join(homedir(), '.dsh-qwenwork-connect')
const mod = await import('../lib/index.js')
const { QwenWorkAdapter, AccountStore } = mod

const store = new AccountStore(DATA_DIR)
await store.load()
const adapter = new QwenWorkAdapter({
  providerId: 'qwenwork',
  displayName: '千问办公',
  gateway: 'https://gateway.qwenwork.cn',
  store,
})
await adapter.refreshModels(true)

const model = process.argv[2] ?? 'qwen3.8-max-preview'

/** DSH 风格的工具定义（截了几个真实工具，schema 有嵌套）。 */
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'list_agents({}) — show your teammates and their names.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent',
      description: 'Start one subagent with a task. Runs to completion and returns its final answer.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task for the subagent.' },
          name: { type: 'string', description: 'Optional short name.' },
          model: {
            oneOf: [
              { type: 'string' },
              { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } },
            ],
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ops_bash',
      description: 'Execute a Bash command in a fresh shell using the host sandbox.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Short bash command or pipeline.' },
          description: { type: 'string', description: 'Clear active-voice description, 5-10 words.' },
          timeoutMs: { type: 'number', description: 'Defaults to 120000 ms.' },
        },
        required: ['description'],
        additionalProperties: false,
      },
    },
  },
]

/** 模仿 DSH 的 system prompt 体量。 */
const systemPrompt = `You are a coding agent powered by the deepseek-v4.1-flash model.

Current mode: multi. Enabled engines: exa, tavily, keenable, firecrawl, parallel, perplexity.

You are the Team Lead named "lead".
Use list_agents({}) to find your teammates and their names.

Start independent delegations with \`subagent\` or \`subagent_fork\` together in one assistant message
and continue useful work while they run.

Read an existing file before overwriting it with write (the default fs-observation-policy
requires it) and prefer edit for targeted changes.

Track every background job id you start. You are notified in-session when a job finishes —
do not busy-poll or sleep on one, keep working on independent steps.

Use a terminal session only when work needs persistent terminal state or interactive stdin;
prefer shell/read/write/edit for bounded one-shot operations.

The runtime context names the DSH implementation checkout. The checkout location and current
working directory are separate values and may differ; never infer the working directory from
the checkout path.

Progress reporting convention:
当执行任务时，每完成一个阶段（读完一批文件、跑完一次测试、改完一处代码），
用一句话说明你刚做了什么、发现了什么。

这些进度说明会被上层看到，用于判断你是否卡住或跑偏。
不要在批量操作中连续沉默太多步。`

const userPrompt = '使用多个子代理来自检dsh和本机环境，注意速度'

/** 跑一次，统计正文/思考体量。 */
async function run(label, opts) {
  let text = ''
  let reason = ''
  let finish = null
  let usage = null
  let blocks = []
  const t0 = Date.now()
  try {
    for await (const c of adapter.stream(opts)) {
      if (c.type === 'text-delta') text += c.text
      if (c.type === 'reasoning-delta') reason += c.text
      if (c.type === 'block-end') blocks.push(`${c.block.type}:${(c.block.text ?? '').length}`)
      if (c.type === 'finish') finish = c.reason
      if (c.type === 'usage') usage = c.usage
    }
  } catch (e) {
    console.log(`${label.padEnd(28)} ✖ 抛错 ${e.message}`)
    return
  }
  const ms = Date.now() - t0
  const bad = text.trim() === ''
  const mark = bad ? '✖ 无正文' : '✔ 有正文'
  console.log(
    `${label.padEnd(28)} ${mark}  正文=${String(text.length).padStart(4)} 思考=${String(reason.length).padStart(5)}  ` +
      `${ms}ms  in=${usage?.inputTokens ?? '?'} out=${usage?.outputTokens ?? '?'} finish=${finish?.kind ?? '?'}`,
  )
  if (bad) {
    console.log(`   思考开头: ${JSON.stringify(reason.slice(0, 120))}`)
    console.log(`   blocks: ${blocks.join(', ')}`)
  }
}

console.log(`\n模型: ${model}\n` + '='.repeat(100))

await run('1. 短提示', {
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  max_tokens: 2000,
})

await run('2. 真实提示词', {
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
  max_tokens: 32000,
})

await run('3. 提示词 + 工具', {
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
  max_tokens: 32000,
  tools,
})

await run('4. 提示词 + system + 工具', {
  model,
  messages: [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    { role: 'user', content: [{ type: 'text', text: userPrompt }] },
  ],
  max_tokens: 32000,
  tools,
})

console.log()

/**
 * 真实链路验证：用本机已登录的账号实际打一次上游。
 *
 * 这是**唯一**能证明协议实现正确的测试——其余单测都用构造的假网关。
 * 它会花掉一点额度（一次请求几分钱），所以不放进 `npm test`。
 *
 * 用法：
 *   node scripts/verify-real.mjs            # 三个模型各问一句
 *   node scripts/verify-real.mjs flash      # 只测指定模型
 *   node scripts/verify-real.mjs --tools    # 额外验证工具调用与多轮循环
 *
 * 需要先完成登录（见 README）。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

import { AccountStore, QwenWorkAdapter } from '../lib/index.js'

const DATA_DIR = join(homedir(), '.dsh-qwenwork-connect')
const ALL_MODELS = ['flash', 'pro', 'qwen3.8-max-preview']

const args = process.argv.slice(2)
const wantTools = args.includes('--tools')
const only = args.find(a => !a.startsWith('--'))

const green = (s) => `\u001b[32m${s}\u001b[0m`
const red = (s) => `\u001b[31m${s}\u001b[0m`
const dim = (s) => `\u001b[2m${s}\u001b[0m`

const store = new AccountStore(DATA_DIR)
await store.load()
const accounts = store.list()

if (accounts.length === 0) {
  console.error(red('没有已登录账号。先按 README 完成设备码登录。'))
  process.exit(1)
}
console.log(`账号: ${accounts.map(a => a.label ?? a.uid).join(', ')}`)

const adapter = new QwenWorkAdapter({ store })

/** 跑一次纯文本对话。 */
async function ask(model, prompt) {
  const started = Date.now()
  let text = ''
  let finish = null
  let usage = null
  for await (const c of adapter.stream({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000,
  })) {
    if (c.type === 'text-delta') text += c.text
    if (c.type === 'finish') finish = c.reason
    if (c.type === 'usage') usage = c.usage
  }
  return { text, finish, usage, ms: Date.now() - started }
}

/** 跑一次带工具的对话，返回调用列表。 */
async function askWithTools(model, prompt, tools, history = null) {
  const messages = history ?? [{ role: 'user', content: prompt }]
  const calls = []
  let text = ''
  let finish = null
  for await (const c of adapter.stream({ model, messages, max_tokens: 3000, tools })) {
    if (c.type === 'text-delta') text += c.text
    if (c.type === 'block-end' && c.block.type === 'tool-call') calls.push(c.block)
    if (c.type === 'finish') finish = c.reason
  }
  return { text, calls, finish }
}

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取一个文件的内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
}]

let failed = 0
const models = only ? [only] : ALL_MODELS

for (const model of models) {
  process.stdout.write(`${model.padEnd(22)} `)
  try {
    const r = await ask(model, '用一个词回答：你好')
    if (r.text.trim() === '') {
      console.log(red(`✖ 空回答 (finish=${JSON.stringify(r.finish)})`))
      failed += 1
      continue
    }
    const kind = r.finish?.kind ?? '?'
    console.log(green(`✔ ${kind}`) + dim(` ${r.ms}ms  in=${r.usage?.inputTokens} out=${r.usage?.outputTokens}  «${r.text.trim().slice(0, 30)}»`))
  } catch (error) {
    console.log(red(`✖ ${error instanceof Error ? error.message : String(error)}`))
    failed += 1
  }
}

if (wantTools) {
  const model = only ?? 'flash'
  console.log('')
  console.log(dim('— 工具调用 —'))
  process.stdout.write('发起调用                 ')
  try {
    const t = await askWithTools(model, '读一下 /etc/hosts', tools)
    if (t.calls.length === 0) {
      console.log(red('✖ 模型没有发起工具调用'))
      failed += 1
    } else {
      const c0 = t.calls[0]
      console.log(green(`✔ ${c0.name} ${c0.arguments}`) + dim(` finish=${t.finish?.kind}`))

      console.log(dim('— 多轮循环 —'))
      process.stdout.write('带工具结果再问           ')
      const history = [
        { role: 'user', content: '请读一下 /etc/hostname，然后告诉我内容' },
        { role: 'assistant', content: t.text || null, tool_calls: t.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) },
        { role: 'tool', tool_call_id: c0.id, content: 'my-machine' },
      ]
      const t2 = await askWithTools(model, '', tools, history)
      if (t2.text.trim() === '') {
        console.log(red('✖ 第二轮没有文字'))
        failed += 1
      } else {
        console.log(green(`✔ ${t2.text.trim().slice(0, 40).replace(/\n/g, ' ')}`))
      }
    }
  } catch (error) {
    console.log(red(`✖ ${error instanceof Error ? error.message : String(error)}`))
    failed += 1
  }
}

console.log('')
if (failed === 0) {
  console.log(green('全部通过'))
  process.exit(0)
}
console.log(red(`${failed} 项失败`))
process.exit(1)

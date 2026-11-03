/**
 * 抓包：把上游 SSE 的每一帧原样打出来。
 *
 * 用来查「只有思维链没有正文」这类问题——看上游到底把内容放在
 * 哪个字段里，是 delta.content 还是别的名字。
 *
 * 用法：
 *   node scripts/dump-stream.mjs [model] [prompt]
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

const DATA_DIR = join(homedir(), '.dsh-qwenwork-connect')
const accounts = JSON.parse(readFileSync(join(DATA_DIR, 'accounts.json'), 'utf8')).accounts
const account = accounts[0]
if (!account) {
  console.error('没有账号')
  process.exit(1)
}

const model = process.argv[2] ?? 'qwen3.8-max-preview'
const prompt = process.argv[3] ?? '用一句话介绍你自己'

const mod = await import('../lib/index.js')
const { QwenWorkAdapter } = mod
const { AccountStore } = mod

const store = new AccountStore(DATA_DIR)
await store.load()

const adapter = new QwenWorkAdapter({
  providerId: 'qwenwork',
  displayName: '千问办公',
  gateway: 'https://gateway.qwenwork.cn',
  store,
})
await adapter.refreshModels(true)

const options = {
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
}

console.log(`\n=== 模型 ${model} 提问：${prompt} ===\n`)

const t0 = Date.now()
let textLen = 0
let reasonLen = 0

try {
  for await (const chunk of adapter.stream(options)) {
    const ms = Date.now() - t0
    if (chunk.type === 'text-delta') {
      textLen += chunk.text.length
      console.log(`[${ms}ms] TEXT     ${JSON.stringify(chunk.text)}`)
    } else if (chunk.type === 'reasoning-delta') {
      reasonLen += chunk.text.length
      console.log(`[${ms}ms] REASON   ${JSON.stringify(chunk.text.slice(0, 80))}`)
    } else if (chunk.type === 'block-start') {
      console.log(`[${ms}ms] START    index=${chunk.index} type=${chunk.blockType}`)
    } else if (chunk.type === 'block-end') {
      console.log(`[${ms}ms] END      index=${chunk.index} type=${chunk.block.type} len=${(chunk.block.text ?? '').length}`)
    } else if (chunk.type === 'finish') {
      console.log(`[${ms}ms] FINISH   ${JSON.stringify(chunk.reason)}`)
    } else if (chunk.type === 'usage') {
      console.log(`[${ms}ms] USAGE    ${JSON.stringify(chunk.usage)}`)
    } else if (chunk.type === 'tool-call-delta') {
      console.log(`[${ms}ms] TOOL     ${chunk.name ?? ''} ${JSON.stringify(chunk.argumentsDelta ?? '')}`)
    }
  }
} catch (e) {
  console.log(`\n!!! 抛错：${e.message}`)
}

console.log(`\n=== 汇总：正文 ${textLen} 字 / 思考 ${reasonLen} 字 ===`)
if (textLen === 0 && reasonLen > 0) {
  console.log('!!! 复现了：只有思考没有正文')
}

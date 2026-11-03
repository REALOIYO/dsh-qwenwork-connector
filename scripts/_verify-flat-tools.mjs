import { join } from 'node:path'
import { homedir } from 'node:os'
const DATA_DIR = join(homedir(), '.dsh-qwenwork-connect')
const mod = await import('../lib/index.js')
const { QwenWorkAdapter, AccountStore } = mod
const store = new AccountStore(DATA_DIR); await store.load()
const adapter = new QwenWorkAdapter({ providerId:'qwenwork', displayName:'千问办公', gateway:'https://gateway.qwenwork.cn', store })
await adapter.refreshModels(true)

// 完全仿照 DSH 传下来的扁平结构
const tools = [
  { name:'list_agents', description:'list_agents({}) — show your teammates and their names.', parameters:{ type:'object', properties:{}, additionalProperties:false } },
  { name:'ops_bash', description:'Execute a Bash command.', parameters:{ type:'object', properties:{ command:{type:'string'}, description:{type:'string'} }, required:['description'], additionalProperties:false } },
]

const model = process.argv[2] ?? 'qwen3.8-max-preview'
console.log(`\n模型 ${model}，扁平工具定义，问「使用多个子代理来自检dsh和本机环境，注意速度」\n`)
let text='', reason='', calls=[]
for await (const c of adapter.stream({
  model,
  messages:[{role:'user',content:[{type:'text',text:'使用多个子代理来自检dsh和本机环境，注意速度'}]}],
  max_tokens:32000,
  tools,
})) {
  if (c.type==='text-delta') text+=c.text
  if (c.type==='reasoning-delta') reason+=c.text
  if (c.type==='block-end' && c.block.type==='tool-call') calls.push(c.block)
  if (c.type==='finish') console.log('FINISH:', JSON.stringify(c.reason))
}
console.log(`正文 ${text.length} 字 / 思考 ${reason.length} 字 / 工具调用 ${calls.length} 次`)
for (const c of calls) console.log('  →', c.name, c.arguments)
if (calls.length>0) console.log('\n✅ 工具透传成功')
else if (text.trim()) console.log('\n✔ 有正文但没调工具（可能正常）')
else console.log('\n❌ 仍然只有思考')

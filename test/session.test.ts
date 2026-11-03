/**
 * 会话与任务标识测试。
 *
 * 这两块决定服务端的缓存与隔离，弄错的表现是「越聊越慢」或
 * 「模型记不住上下文」，所以按语义逐条断言。
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { stableUUID, sessionOf, taskOf, markTaskAnswered, __resetTasks } from '../src/adapter/session.ts'

beforeEach(() => __resetTasks())

test('stableUUID 对同一输入永远给同一个 UUID 形状结果', () => {
  const a = stableUUID('hello')
  const b = stableUUID('hello')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('stableUUID 对不同输入给不同结果', () => {
  assert.notEqual(stableUUID('a'), stableUUID('b'))
})

test('sessionOf：DSH 给的会话名优先，且稳定', () => {
  const chat = { messages: [{ role: 'user', content: 'hi' }] }
  const a = sessionOf('sess-abc', chat)
  const b = sessionOf('sess-abc', chat)
  assert.equal(a, b, '同一会话名必须得到同一 id')
  assert.notEqual(a, sessionOf('sess-xyz', chat), '不同会话名要不同')
})

test('sessionOf：不同对话内容得到不同会话（不能拿账号 uid 顶替）', () => {
  const a = sessionOf('', { messages: [{ role: 'user', content: '问题一' }] })
  const b = sessionOf('', { messages: [{ role: 'user', content: '问题二' }] })
  assert.notEqual(a, b, '不同内容必须是不同会话，否则缓存全串')
})

test('sessionOf：prompt_cache_key 参与种子', () => {
  const a = sessionOf('', { messages: [], prompt_cache_key: 'k1' })
  const b = sessionOf('', { messages: [], prompt_cache_key: 'k2' })
  assert.notEqual(a, b)
  assert.equal(a, sessionOf('', { messages: [], prompt_cache_key: 'k1' }), '同一 key 要稳定')
})

test('sessionOf：什么都没有也能算出一个 id', () => {
  const id = sessionOf('', { messages: [] })
  assert.match(id, /^[0-9a-f-]{36}$/)
})

test('taskOf：同一提示的多轮调用落同一个任务', () => {
  const messages = [
    { role: 'user', content: '帮我读文件' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
  ]
  const t1 = taskOf('sess-1', { messages })
  const t2 = taskOf('sess-1', { messages })
  assert.equal(t1.id, t2.id, '工具循环的各轮必须共用 request_set_id')
  assert.equal(t1.begin, t2.begin, 'begin_at 整个任务期间不变')
})

test('taskOf：用户提新问题是新任务', () => {
  const t1 = taskOf('sess-1', { messages: [{ role: 'user', content: '第一个问题' }] })
  const t2 = taskOf('sess-1', { messages: [{ role: 'user', content: '第二个问题' }] })
  assert.notEqual(t1.id, t2.id, '新提示应产生新任务')
})

test('taskOf：不同会话的同名提示是不同任务', () => {
  const messages = [{ role: 'user', content: '同样的话' }]
  const a = taskOf('sess-a', { messages })
  const b = taskOf('sess-b', { messages })
  assert.notEqual(a.id, b.id)
})

test('任务名取提示词前十字', () => {
  const long = taskOf('s', { messages: [{ role: 'user', content: '一二三四五六七八九十十一十二' }] })
  assert.equal(long.name, '一二三四五六七八九十')
  const short = taskOf('s2', { messages: [{ role: 'user', content: '短' }] })
  assert.equal(short.name, '短')
})

test('任务初始 start，回答后变 processing', () => {
  const t = taskOf('s', { messages: [{ role: 'user', content: 'x' }] })
  assert.equal(t.answered, false, '初始应为 start')
  markTaskAnswered(t)
  assert.equal(t.answered, true, '回答过应为 processing')
  // 同提示再取，应拿到同一个已标记的任务
  const again = taskOf('s', { messages: [{ role: 'user', content: 'x' }] })
  assert.equal(again.answered, true)
})

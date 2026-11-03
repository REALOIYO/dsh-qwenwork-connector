/**
 * codec 往返测试。
 *
 * 这一层是纯函数，没有 IO，所以能完全离线验证：编码后解码必须还原原文。
 * 重点覆盖边界——空串、恰好 3 的倍数、含中文/emoji 的多字节、含会与字母表
 * 混淆的字符。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { encodeBody, decodeBody, looksEncoded } from '../src/adapter/codec.ts'

test('空串往返', () => {
  assert.equal(encodeBody(''), '')
  assert.equal(decodeBody(''), '')
})

test('纯 ASCII 往返', () => {
  for (const s of ['a', 'ab', 'abc', 'hello world', '{"model":"flash"}']) {
    assert.equal(decodeBody(encodeBody(s)), s, `往返失败: ${JSON.stringify(s)}`)
  }
})

test('多字节中文往返', () => {
  for (const s of ['千问办公', '你好，世界', '标准/高级/Qwen3.8-Max']) {
    assert.equal(decodeBody(encodeBody(s)), s, `往返失败: ${JSON.stringify(s)}`)
  }
})

test('emoji 往返（代理对）', () => {
  for (const s of ['🐦', 'a🐦b', '🎉🎊✨']) {
    assert.equal(decodeBody(encodeBody(s)), s, `往返失败: ${JSON.stringify(s)}`)
  }
})

test('长度取各余数类，覆盖补位分支', () => {
  // base64 变体按 4 字符补齐，字节数 mod 3 = 0/1/2 三种分支都要走到
  for (let n = 0; n <= 24; n++) {
    const s = 'x'.repeat(n)
    assert.equal(decodeBody(encodeBody(s)), s, `长度 ${n} 往返失败`)
  }
})

test('较长的真实 JSON 往返', () => {
  const body = {
    request_id: 'd3adbeef-0000-4000-8000-000000000000',
    parameters: { enable_thinking: false, max_tokens: 32000 },
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我看看这个函数的复杂度' }] }],
  }
  const s = JSON.stringify(body)
  const wire = encodeBody(s)
  assert.notEqual(wire, s, '编码应改变内容')
  assert.equal(decodeBody(wire), s)
})

test('编码结果只用字母表内字符', () => {
  const alphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const wire = encodeBody(JSON.stringify({ hello: '千问办公 🐦' }))
  for (const c of wire) {
    assert.ok(c === '$' || alphabet.includes(c), `出现字母表外字符: ${JSON.stringify(c)}`)
  }
})

test('解码遇到表外字符要抛错，不静默产脏数据', () => {
  assert.throws(() => decodeBody('这不是编码###'), /qwenwork/)
})

test('looksEncoded 区分明文与编码', () => {
  assert.equal(looksEncoded('{"a":1}'), false, '明文 JSON 不是编码')
  assert.equal(looksEncoded('[1,2]'), false, '明文数组不是编码')
  assert.equal(looksEncoded(''), false)
  assert.equal(looksEncoded(encodeBody('{"a":1}')), true, '编码结果应被认出')
})

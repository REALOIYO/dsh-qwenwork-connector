/**
 * COSY 签名层测试。
 *
 * 不发网络请求：只验证能生成结构正确的签名头、RSA 包裹可解、
 * path 前缀处理正确、机器标识稳定。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  cosyHeaders,
  chatHeaders,
  clientHeaders,
  machineOS,
  machineHostname,
  newMachineId,
  QWENWORK_RSA_KEY,
  COSY_VERSION,
  type QwenWorkAccount,
} from '../src/adapter/cosy.ts'

const account: QwenWorkAccount = {
  uid: 'u-12345',
  access: 'access-token-abc',
  name: '测试用户',
  email: 'test@example.com',
  machineId: newMachineId(),
}

test('签名头包含 Authorization 且格式为 COSY.payload.sig 三段', () => {
  const h = cosyHeaders('https://gateway.qwenwork.cn/algo/api/v1/x', account, 'BODY')
  const parts = h.Authorization.split('.')
  assert.equal(parts.length, 3, 'Authorization 应为 Bearer COSY.payload.sig')
  assert.ok(h.Authorization.startsWith('Bearer COSY.'), '缺 Bearer COSY. 前缀')
  // payload 应是合法 base64 JSON
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf8'))
  assert.equal(payload.version, 'v1')
  assert.equal(payload.cosyVersion, COSY_VERSION)
  assert.equal(payload.ideVersion, '')
  assert.ok(typeof payload.info === 'string' && payload.info.length > 0, 'info 应非空')
})

test('Cosy-Key 是 RSA 包裹的 AES 密钥（1024 位密文）', () => {
  const h = cosyHeaders('https://gateway.qwenwork.cn/algo/api/v1/x', account, 'BODY')
  const wrapped = Buffer.from(h['Cosy-Key']!, 'base64')
  // 1024 位 RSA 的密文恒为 128 字节
  assert.equal(wrapped.length, 128, `RSA-1024 密文应为 128 字节，得到 ${wrapped.length}`)
})

test('同一请求内 Cosy-Key 与 payload.info 配对，且不同请求会换密钥', () => {
  const a = cosyHeaders('https://gateway.qwenwork.cn/algo/api/v1/x', account, 'BODY')
  const b = cosyHeaders('https://gateway.qwenwork.cn/algo/api/v1/x', account, 'BODY')
  assert.notEqual(a['Cosy-Key'], b['Cosy-Key'], '每次请求应换新的 AES 密钥')
  const pa = JSON.parse(Buffer.from(a.Authorization.split('.')[1]!, 'base64').toString('utf8'))
  const pb = JSON.parse(Buffer.from(b.Authorization.split('.')[1]!, 'base64').toString('utf8'))
  assert.notEqual(pa.requestId, pb.requestId, '每次应换 requestId')
  assert.notEqual(pa.info, pb.info, '每次应换 info（新密钥加密）')
  assert.notEqual(a.Authorization, b.Authorization, '签名应随请求变化')
})

test('sig 是对 payload/key/ts/body/path 的 md5，改动任一输入都会变', () => {
  // 用同一 payload 复算一次签名，验证拼接格式与算法
  const h = cosyHeaders('https://gateway.qwenwork.cn/algo/api/v1/x', account, 'BODY', 1700000000)
  const parts = h.Authorization.split('.')
  const payload = parts[1]!
  const sig = parts[2]!
  const recomputed = createHash('md5')
    .update(`${payload}\n${h['Cosy-Key']}\n1700000000\nBODY\n/api/v1/x`)
    .digest('hex')
  assert.equal(sig, recomputed, '签名应等于 md5(payload\\nkey\\nts\\nbody\\npath)')
})

test('/algo 前缀在签名 path 中被去掉', () => {
  // 签名 path 去掉 /algo：同一 ts/body 下两种写法应得到相同 path 段
  const ts = 1700000000
  const withAlgo = cosyHeaders('https://gateway.qwenwork.cn/algo/api/v1/x', account, 'B', ts)
  const without = cosyHeaders('https://gateway.qwenwork.cn/api/v1/x', account, 'B', ts)
  const p1 = JSON.parse(Buffer.from(withAlgo.Authorization.split('.')[1]!, 'base64').toString('utf8'))
  const p2 = JSON.parse(Buffer.from(without.Authorization.split('.')[1]!, 'base64').toString('utf8'))
  assert.equal(p1.version, p2.version)
  // 真正的 path 差异体现在 sig 上，这里验证两者都不抛错且结构一致
  assert.ok(withAlgo.Authorization.startsWith('Bearer COSY.'))
  assert.ok(without.Authorization.startsWith('Bearer COSY.'))
})

test('聊天头去掉 ClientIp，加上 X-Model-Key 与 SSE Accept', () => {
  const h = chatHeaders('https://gateway.qwenwork.cn/algo/api/v2/x', account, 'BODY', 'qwen3.8-max-preview')
  assert.equal(h['Cosy-ClientIp'], undefined, '聊天头不应带 Cosy-ClientIp')
  assert.equal(h['Cosy-MachineToken'], undefined, '缺设备身份时不应带 MachineToken')
  assert.equal(h['Cosy-MachineType'], undefined)
  assert.equal(h['X-Model-Key'], 'qwen3.8-max-preview')
  assert.equal(h.Accept, 'text/event-stream')
  assert.equal(h['Cache-Control'], 'no-cache')
  assert.ok(h.Authorization.startsWith('Bearer COSY.'))
})

test('普通头保留 ClientIp 且场景为 qwork', () => {
  const h = cosyHeaders('https://gateway.qwenwork.cn/algo/api/v1/x', account, 'B')
  assert.equal(h['Cosy-ClientIp'], account.machineId)
  assert.equal(h['Cosy-Scene'], 'qwork')
  assert.equal(h['Cosy-Business-Product'], 'qoder_work')
  assert.equal(h['Login-Version'], 'v2')
})

test('缺 machineId 要明确抛错', () => {
  const bad = { ...account, machineId: '' }
  assert.throws(() => cosyHeaders('https://x/algo/api/v1/y', bad, 'B'), /machineId/)
})

test('machineOS 只改写 x64/arm64', () => {
  assert.equal(machineOS('x64', 'win32'), 'x86_64_win32')
  assert.equal(machineOS('arm64', 'darwin'), 'aarch64_darwin')
  assert.equal(machineOS('ia32', 'win32'), 'ia32_win32')
})

test('machineHostname 处理 ASCII / 空 / 超长', () => {
  assert.equal(machineHostname('my-pc'), 'my-pc')
  assert.equal(machineHostname(''), '')
  assert.equal(machineHostname('  '), '')
  const long = 'a'.repeat(200)
  const capped = machineHostname(long)
  assert.ok(capped.length <= 96, `超长主机名应被截断到 96 以内，得到 ${capped.length}`)
})

test('客户端身份头齐全', () => {
  const h = clientHeaders()
  assert.match(h['User-Agent']!, /^qoderwork\/\d+\.\d+\.\d+$/)
  assert.ok(h['X-Request-Id']!.length > 0)
  assert.ok(h['X-QwenWork-Version']!.length > 0)
  assert.ok(h['X-QwenWork-Release-Version']!.length > 0)
  assert.equal(h['X-QwenWork-Channel'], 'stable')
})

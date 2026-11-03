/**
 * 插件入口测试。
 *
 * 验证：注册了 provider、账号目录解析正确、没有 llm 服务时不崩。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resolveConfig, name, inject } from '../src/index.ts'

/** 造一个记录调用的假 ctx。 */
function fakeCtx(opts: { withLlm?: boolean } = {}) {
  const registered: Array<{ providers: string[]; adapter: unknown }> = []
  const logs: string[] = []
  const ctx = {
    logger: {
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
    },
    ...(opts.withLlm === false
      ? {}
      : {
          llm: {
            registerAdapter(providers: string[], adapter: unknown) {
              registered.push({ providers, adapter })
              return () => {}
            },
          },
        }),
    emit: () => {},
    effect: (fn: () => () => void) => {
      void fn
    },
  }
  return { ctx, registered, logs }
}

test('插件元信息正确', () => {
  assert.equal(name, 'dsh-qwenwork-connector')
  assert.deepEqual([...inject], ['llm'])
})

test('apply 会注册 provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-entry-'))
  const { ctx, registered } = fakeCtx()
  apply(ctx as never, { dataDir: dir })
  assert.equal(registered.length, 1, '应注册一次')
  assert.deepEqual(registered[0]!.providers, ['qwenwork'], '默认 provider id')
  assert.ok(registered[0]!.adapter, '应传入适配器实例')
})

test('自定义 providerId 生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-entry-'))
  const { ctx, registered } = fakeCtx()
  apply(ctx as never, { dataDir: dir, providerId: 'qw' })
  assert.deepEqual(registered[0]!.providers, ['qw'])
})

test('没有 llm 服务时报错但不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-entry-'))
  const { ctx, registered, logs } = fakeCtx({ withLlm: false })
  const handle = apply(ctx as never, { dataDir: dir })
  assert.equal(registered.length, 0)
  assert.ok(logs.some(l => l.startsWith('error')), '应记录错误日志')
  // 仍然返回句柄，不让宿主启动失败
  const ready = await handle.ready
  assert.equal(ready.version, 'adapter')
})

test('dataDir 默认在用户主目录下的独立目录', () => {
  const cfg = resolveConfig()
  assert.ok(cfg.dataDir.includes('.dsh-qwenwork-connect'), `默认数据目录应独立，得到 ${cfg.dataDir}`)
  assert.ok(!cfg.dataDir.includes('profiles'), '不应写进 profile')
})

test('配置解析：空串与空白回退到默认', () => {
  const cfg = resolveConfig({ providerId: '  ', displayName: '', gateway: '  ' })
  assert.equal(cfg.providerId, 'qwenwork')
  assert.equal(cfg.displayName, '千问办公')
  assert.equal(cfg.gateway, 'https://gateway.qwenwork.cn')
})

test('gateway 尾部斜杠被去掉', () => {
  const cfg = resolveConfig({ gateway: 'https://example.com///' })
  assert.equal(cfg.gateway, 'https://example.com')
})

test('registerAdapter 抛错时不让异常外泄（只自己失效）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-entry-'))
  const logs: string[] = []
  const ctx = {
    logger: {
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
    },
    llm: {
      registerAdapter() {
        throw new Error('duplicate provider route')
      },
    },
    emit: () => {},
    effect: (fn: () => () => void) => {
      void fn
    },
  }
  // 不应该抛
  const handle = apply(ctx as never, { dataDir: dir })
  const ready = await handle.ready
  assert.equal(ready.version, 'adapter')
  assert.ok(logs.some(l => l.startsWith('error')), '应记录注册失败')
  assert.ok(
    logs.some(l => l.includes('duplicate provider route')),
    `错误里应带上原因，得到：${logs.join(' | ')}`,
  )
})

test('apply 内部任何异常都不外泄', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-entry-'))
  const logs: string[] = []
  const ctx = {
    logger: {
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
    },
    llm: { registerAdapter: () => () => {} },
    emit: () => {},
    // effect 里抛错，模拟宿主服务异常
    effect: () => {
      throw new Error('host service exploded')
    },
  }
  assert.doesNotThrow(() => apply(ctx as never, { dataDir: dir }))
})

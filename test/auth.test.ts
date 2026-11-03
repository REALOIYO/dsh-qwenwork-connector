/**
 * 登录层测试。
 *
 * 起一个本地 HTTP 服务器冒充千问办公网关，验证：
 * - 设备码参数齐全且正确
 * - 轮询到 token 后能组装出账号
 * - account-context 的 uid/额度被正确读取
 * - 存储层原子写入与去重
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDeviceSignIn, AccountStore } from '../src/adapter/auth.ts'

/** 起一个可控的假网关，返回它的地址与请求记录。 */
async function fakeGateway(routes: Record<string, (url: URL) => { status: number; json: unknown }>): Promise<{
  base: string
  seen: string[]
  close: () => Promise<void>
}> {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    seen.push(`${req.method} ${url.pathname}`)
    const handler = routes[url.pathname]
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    const out = handler(url)
    res.writeHead(out.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out.json))
  })
  await new Promise<void>(r => server.listen(0, r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    base: `http://localhost:${port}`,
    seen,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

test('设备码登录全流程：poll 成功后读 account-context 组装账号', async () => {
  let polls = 0
  const gw = await fakeGateway({
    '/api/v1/deviceToken/poll': () => {
      polls += 1
      if (polls < 2) return { status: 200, json: { pending: true } }
      return {
        status: 200,
        json: { token: 'tok-abc', refresh_token: 'ref-xyz', expires_in: 3600, user_id: 'u-1' },
      }
    },
    '/api/v1/adapter/user/account-context': () => ({
      status: 200,
      json: {
        data: {
          user: { id: 'u-1', email: 'me@example.com', name: '张三' },
          plan: { name: '个人版' },
          quota: { remaining: 1234 },
        },
      },
    }),
  })

  try {
    const signIn = startDeviceSignIn(gw.base, 20)
    // 授权地址要带上完整参数
    const u = new URL(signIn.url)
    assert.equal(u.pathname, '/device/selectAccounts')
    for (const k of ['challenge', 'challenge_method', 'nonce', 'machine_id', 'client_id', 'redirect_uri']) {
      assert.ok(u.searchParams.get(k), `缺少参数 ${k}`)
    }
    assert.equal(u.searchParams.get('challenge_method'), 'S256')
    assert.equal(u.searchParams.get('redirect_uri'), 'qwenwork-cn://')

    const account = await signIn.wait()
    assert.equal(account.uid, 'u-1')
    assert.equal(account.access, 'tok-abc')
    assert.equal(account.refresh, 'ref-xyz')
    assert.equal(account.email, 'me@example.com')
    assert.equal(account.name, '张三')
    assert.equal(account.plan, '个人版')
    assert.equal(account.balance, '1234 credits')
    assert.ok(account.machineId.length > 0, '应生成 machineId')
    assert.ok(account.expires! > Date.now(), '过期时间应在将来')
    assert.ok(polls >= 2, '应轮询多次才拿到 token')
  } finally {
    await gw.close()
  }
})

test('poll 返回 403 立即失败，不空转到超时', async () => {
  const gw = await fakeGateway({
    '/api/v1/deviceToken/poll': () => ({ status: 403, json: { message: 'denied' } }),
  })
  try {
    const signIn = startDeviceSignIn(gw.base, 20)
    await assert.rejects(signIn.wait(), /授权被拒绝/)
  } finally {
    await gw.close()
  }
})

test('poll 返回 404（未授权常态）会继续等，不误判失败', async () => {
  // 实测上游未授权时就是 404 + 空 body，这是常态不是错误
  let polls = 0
  const gw = await fakeGateway({
    '/api/v1/deviceToken/poll': () => {
      polls += 1
      if (polls <= 2) return { status: 404, json: {} }
      return { status: 200, json: { token: 'tok-late', user_id: 'u-late' } }
    },
  })
  try {
    const signIn = startDeviceSignIn(gw.base, 20)
    const account = await signIn.wait()
    assert.equal(account.uid, 'u-late', '404 之后应继续等到 token')
    assert.ok(polls >= 3, '应至少轮询三次')
  } finally {
    await gw.close()
  }
})

test('errorCode=INVALID_DEVICE_FLOW 立即失败', async () => {
  const gw = await fakeGateway({
    '/api/v1/deviceToken/poll': () => ({
      status: 400,
      json: { errorCode: 'INVALID_DEVICE_FLOW', errorMessage: 'device flow poll request is invalid' },
    }),
  })
  try {
    const signIn = startDeviceSignIn(gw.base, 20)
    await assert.rejects(signIn.wait(), /设备流无效/)
  } finally {
    await gw.close()
  }
})

test('account-context 不可用时，用 poll 里的 user_id 兜底', async () => {
  const gw = await fakeGateway({
    '/api/v1/deviceToken/poll': () => ({
      status: 200,
      json: { token: 'tok-2', refresh_token: 'r', user_id: 'u-2' },
    }),
    // account-context 不在路由表 → 404
  })
  try {
    const signIn = startDeviceSignIn(gw.base, 20)
    const account = await signIn.wait()
    assert.equal(account.uid, 'u-2', '应回退到 poll 返回的 user_id')
    assert.equal(account.access, 'tok-2')
  } finally {
    await gw.close()
  }
})

test('拿不到 uid 要明确报错（签名必需）', async () => {
  const gw = await fakeGateway({
    '/api/v1/deviceToken/poll': () => ({ status: 200, json: { token: 'tok-3' } }),
  })
  try {
    const signIn = startDeviceSignIn(gw.base, 20)
    await assert.rejects(signIn.wait(), /用户 id/)
  } finally {
    await gw.close()
  }
})

test('AccountStore 读写与去重', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qwenwork-store-'))
  const store = new AccountStore(dir)

  assert.deepEqual(await store.load(), [], '首次应为空')

  await store.upsert({
    uid: 'u-a', access: 't1', machineId: 'm1', label: 'A',
  })
  await store.upsert({
    uid: 'u-b', access: 't2', machineId: 'm2', label: 'B',
  })
  assert.equal(store.list().length, 2)

  // 同 uid 覆盖而非追加
  await store.upsert({ uid: 'u-a', access: 't1-new', machineId: 'm1', label: 'A2' })
  assert.equal(store.list().length, 2, '同 uid 应覆盖')
  assert.equal(store.find('u-a')?.access, 't1-new')

  // 落盘可重读
  const raw = JSON.parse(await readFile(store.path, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.accounts.length, 2)

  const again = new AccountStore(dir)
  await again.load()
  assert.equal(again.list().length, 2, '重载应读到 2 个账号')

  await store.remove('u-a')
  assert.equal(store.list().length, 1)
  assert.equal(store.find('u-a'), undefined)
})

test('AccountStore.sync 真的打到上游并更新额度（而不是读本地快照）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-sync-'))
  let remaining = 1234.5678
  const gw = await fakeGateway({
    '/api/v1/adapter/user/account-context': () => ({
      status: 200,
      json: {
        code: 'ok',
        data: {
          user: { id: 'u-1', name: '小明', email: 'a@b.c' },
          plan: { name: 'basic', period: 'monthly', next_due_date: '2026-12-03T11:46:42Z' },
          quota: { total: null, used: null, remaining, exceeded: false },
        },
      },
    }),
  })

  try {
    const store = new AccountStore(dir)
    // 登录时的旧快照是 900，上游已经降到别的值 —— 同步要能拉回新值
    await store.upsert({
      uid: 'u-1', access: 'tok', machineId: 'm1', label: 'a@b.c',
      plan: 'basic', balance: '900 credits',
    })

    const first = await store.sync(gw.base)
    assert.deepEqual(first.errors, [], '不该有错误')
    const a = first.accounts[0]
    assert.ok(a !== undefined, '应该有一个账号')
    assert.equal(a.balance, '1234.57 credits', '额度应来自上游')
    assert.equal(a.quota?.remaining, 1234.5678, '结构化额度也要带回来')
    assert.equal(a.period, 'monthly')
    assert.equal(a.renewsAt, Date.parse('2026-12-03T11:46:42Z'), '续费时间要解析出来')
    assert.ok(typeof a.syncedAt === 'number' && a.syncedAt > 0, '要记录同步时刻')

    // 再降一次，确认是可重复同步而非一次性
    remaining = 800
    const second = await store.sync(gw.base)
    assert.equal(second.accounts[0]?.balance, '800 credits')

    // 落盘了才叫真同步（重启后仍是新值）
    const again = new AccountStore(dir)
    await again.load()
    assert.equal(again.find('u-1')?.balance, '800 credits')
  } finally {
    await gw.close()
  }
})

test('sync 遇到 401 时保留原数据并报错，不把账号清空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-sync-401-'))
  const gw = await fakeGateway({
    '/api/v1/adapter/user/account-context': () => ({
      status: 401,
      json: { errorCode: 'INVALID_TOKEN' },
    }),
  })

  try {
    const store = new AccountStore(dir)
    await store.upsert({
      uid: 'u-1', access: 'bad', machineId: 'm1', label: 'a@b.c', balance: '900 credits',
    })

    const r = await store.sync(gw.base)
    assert.equal(r.errors.length, 1, '要有一个账号的错误')
    assert.match(r.errors[0] ?? '', /401|失效/, '错误要说明是 token 问题')
    assert.equal(r.accounts.length, 1, '账号不能消失')
    assert.equal(r.accounts[0]?.balance, '900 credits', '旧额度保留，不能被清成空')
  } finally {
    await gw.close()
  }
})

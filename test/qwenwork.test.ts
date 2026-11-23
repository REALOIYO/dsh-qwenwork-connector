/**
 * 适配器端到端测试。
 *
 * 起一个假网关，验证：
 * - 7 个契约方法形状正确
 * - 整条链路：签名 → 编码 → 发请求 → 解流
 * - 多账号轮转与失败切换
 * - 未登录时明确报错
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QwenWorkAdapter, MODELS } from '../src/adapter/qwenwork.ts'
import { AccountStore, type StoredAccount } from '../src/adapter/auth.ts'
import type { AttachmentStore } from '../src/adapter/images.ts'
import { PrefsStore } from '../src/adapter/prefs.ts'
import { decodeBody } from '../src/adapter/codec.ts'

/** 造一个已登录账号。 */
function anAccount(uid = 'u1', label = 'A'): StoredAccount {
  return { uid, access: `tok-${uid}`, machineId: `m-${uid}`, label }
}

/**
 * 假网关：记录收到的请求，按预设回应。
 * handler 可返回 SSE 帧数组或 HTTP 错误。
 *
 * 模型列表请求（GET）不经过 handler：它由 `modelList` 统一应答，
 * 也不计入 `calls`。原因是从「目录没回源时先拉一次」这层保护落地后，
 * adapter 可能在真正发聊天请求前先补一次目录拉取；不区分的话，
 * 计数类断言（「400 不该重试」「应请求两次」）会被这次拉取带偏。
 */
async function gateway(
  handler: (req: { body: string; headers: Record<string, string | string[] | undefined> }) => { status?: number; frames?: string[]; text?: string },
  modelList?: () => { status?: number; text: string },
): Promise<{ base: string; calls: Array<{ body: string; headers: Record<string, string | string[] | undefined> }>; close: () => Promise<void> }> {
  const calls: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = []
  // 默认给一份合法的上游目录，让 adapter 能正常拿到 flash
  const listText = (): { status?: number; text: string } =>
    modelList !== undefined
      ? modelList()
      : { text: JSON.stringify({ qwork: [{ key: 'flash', display_name: '标准', price_factor: 0.1 }] }) }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      // 模型列表是 GET 且不带请求体
      if (req.method === 'GET') {
        const out = listText()
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
        res.end(out.text)
        return
      }
      calls.push({ body: raw, headers: req.headers })
      const out = handler({ body: raw, headers: req.headers })
      const status = out.status ?? 200
      if (out.text !== undefined) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(out.text)
        return
      }
      res.writeHead(status, { 'content-type': 'text/event-stream' })
      res.end((out.frames ?? []).join('\n\n') + '\n\n')
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    base: `http://localhost:${port}`,
    calls,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

/** 一个正常的 SSE 帧。 */
const okFrame = (content: string): string =>
  `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { content } }] }) })}`

const doneFrame = `data: ${JSON.stringify({
  body: JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
})}`

test('7 个契约方法形状正确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const adapter = new QwenWorkAdapter({ store: new AccountStore(dir) })

  const info = adapter.providerInfo('qwenwork')
  assert.equal(info.id, 'qwenwork')
  assert.equal(info.name, '千问办公')

  // 重试策略必须自己声明：DSH 默认按 code 字符串匹配，
  // 不认识 MODEL_POOL_BUSY / QUEUED 就会当场判失败（「跑一会儿突然停」的根因）
  const policy = adapter.providerRetryPolicy('qwenwork')
  assert.equal(policy.mode, 'normal')
  assert.ok(policy.maxRetries >= 1)
  assert.ok(policy.retryableCodes.includes('MODEL_POOL_BUSY'), '模型池忙必须可重试')
  assert.ok(policy.retryableCodes.includes('QUEUED'), '上游排队必须可重试')
  assert.equal(adapter.imageRequestPricing('qwenwork', 'flash'), undefined)

  const listed = await adapter.listModels('qwenwork')
  assert.equal(listed.length, MODELS.length)
  for (const m of listed) {
    assert.equal(m.provider, 'qwenwork')
    assert.ok(m.id.length > 0)
    assert.ok(Array.isArray(m.inputModalities))
    // 倍率走 badge 才能在模型选择器里看见（宿主会把它渲染成名称旁的 Tag）
    assert.ok(m.badge !== undefined, `${m.id} 应带倍率角标`)
    assert.ok(m.badge!.text.length > 0)
  }
  // 标准档 0.1×、高级档 1×、Max 档 1.8×
  assert.equal(listed.find(m => m.id === 'flash')!.badge!.text, '0.1×')
  assert.equal(listed.find(m => m.id === 'pro')!.badge!.text, '1×')
  assert.equal(listed.find(m => m.id === 'qwen3.8-max-preview')!.badge!.text, '1.8×')

  const resolved = adapter.resolveModel('qwenwork', 'flash')
  assert.equal(resolved.id, 'flash')
  assert.equal(resolved.name, '标准')
  assert.ok(resolved.context.contextWindow > 0)
  assert.ok(resolved.defaultMaxTokens > 0)

  const prepared = await adapter.prepareCall('qwenwork', 'pro')
  assert.equal(prepared.model.id, 'pro')
  assert.equal(typeof prepared.stream, 'function')
})

test('端到端：签名 → 编码 → 请求 → 解流', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount())

  let sentBody = ''
  let sentHeaders: Record<string, string | string[] | undefined> = {}
  const gw = await gateway(req => {
    sentBody = req.body
    sentHeaders = req.headers
    return { frames: [okFrame('你好'), okFrame('！'), doneFrame] }
  })

  try {
    const adapter = new QwenWorkAdapter({ store, gateway: gw.base })
    const chunks = []
    for await (const c of adapter.stream({ model: 'flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 })) {
      chunks.push(c)
    }

    // 1. 请求体是编码过的，不是明文 JSON
    assert.ok(sentBody.length > 0)
    assert.notEqual(sentBody.trim()[0], '{', '请求体应是 Encode=1 编码后的')

    // 2. 解开后结构正确
    const decoded = JSON.parse(decodeBody(sentBody)) as Record<string, unknown>
    assert.equal((decoded.model_config as Record<string, unknown>).key, 'flash')
    assert.ok(Array.isArray(decoded.messages))

    // 3. 签名头齐全
    const auth = String(sentHeaders.authorization ?? '')
    assert.ok(auth.startsWith('Bearer COSY.'), `Authorization 应为 COSY 签名，得到 ${auth.slice(0, 20)}`)
    assert.equal(sentHeaders['x-model-key'], 'flash')
    assert.ok(sentHeaders['cosy-user'])
    assert.ok(sentHeaders['cosy-key'])

    // 4. 流被正确转换
    const text = chunks.filter((c: { type: string }) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text).join('')
    assert.equal(text, '你好！')
    assert.equal(chunks[chunks.length - 2]!.type, 'usage', '倒数第二应是 usage')
    assert.equal(chunks[chunks.length - 1]!.type, 'finish', '最后应是 finish')
  } finally {
    await gw.close()
  }
})

test('未登录时明确报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const adapter = new QwenWorkAdapter({ store: new AccountStore(dir) })
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({ model: 'flash', messages: [{ role: 'user', content: 'x' }] })) void _
    },
    /还没有登录账号/,
  )
})

test('未知模型报错并列出可用项', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount())
  const adapter = new QwenWorkAdapter({ store })
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({ model: 'gpt-9', messages: [{ role: 'user', content: 'x' }] })) void _
    },
    /未知模型/,
  )
})

test('第一个账号 401 时自动换下一个账号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount('bad', '坏号'))
  await store.upsert(anAccount('good', '好号'))

  let n = 0
  const gw = await gateway(() => {
    n += 1
    if (n === 1) return { status: 401, text: '{"message":"unauthorized"}' }
    return { frames: [okFrame('备用账号答的'), doneFrame] }
  })

  try {
    const adapter = new QwenWorkAdapter({ store, gateway: gw.base })
    const chunks = []
    for await (const c of adapter.stream({ model: 'flash', messages: [{ role: 'user', content: 'x' }], max_tokens: 1000 })) chunks.push(c)
    const text = chunks.filter((c: { type: string }) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text).join('')
    assert.equal(text, '备用账号答的', '应切到第二个账号')
    assert.equal(n, 2, '应请求两次')
  } finally {
    await gw.close()
  }
})

test('400（请求本身的问题）不换账号，直接报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount('a'))
  await store.upsert(anAccount('b'))

  let n = 0
  const gw = await gateway(() => {
    n += 1
    return { status: 400, text: '{"message":"bad request"}' }
  })

  try {
    const adapter = new QwenWorkAdapter({ store, gateway: gw.base })
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream({ model: 'flash', messages: [{ role: 'user', content: 'x' }] })) void _
      },
      /bad request/,
    )
    assert.equal(n, 1, '400 不该重试别的账号')
  } finally {
    await gw.close()
  }
})

test('错误信息带上账号标签，便于定位是哪个号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount('a', '我的号'))

  const gw = await gateway(() => ({ status: 429, text: '{"message":"usage limit reached"}' }))
  try {
    const adapter = new QwenWorkAdapter({ store, gateway: gw.base })
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream({ model: 'flash', messages: [{ role: 'user', content: 'x' }] })) void _
      },
      (e: unknown) => {
        const msg = (e as Error).message
        assert.ok(msg.includes('我的号'), `错误应带账号标签，得到：${msg}`)
        return true
      },
    )
  } finally {
    await gw.close()
  }
})

test('回归：用户选的上下文档位要反映到 resolveModel 的 contextWindow', async () => {
  // 曾经恒取上游最大值，用户选了 200K 而 DSH 仍按最大值算压缩阈值，
  // 导致「剩余上下文」和压缩时机全是错的。
  const dir = await mkdtemp(join(tmpdir(), 'qw-window-'))
  const store = new AccountStore(dir)
  const prefs = new PrefsStore(dir)
  await prefs.load()

  const adapter = new QwenWorkAdapter({ store, prefs })

  const auto = adapter.resolveModel('qwenwork', 'flash')
  const autoWindow = auto.context.contextWindow
  assert.ok(autoWindow > 0, '自动时应回落到上游给的窗口')

  // 选一个明显更小的档位
  await adapter.setWindowPreference('flash', 200000)
  const chosen = adapter.resolveModel('qwenwork', 'flash')
  assert.equal(chosen.context.contextWindow, 200000, 'DSH 看到的窗口要跟着用户的选择走')

  // 改回自动
  await adapter.setWindowPreference('flash', 0)
  const back = adapter.resolveModel('qwenwork', 'flash')
  assert.equal(back.context.contextWindow, autoWindow, '选自动要回落到默认值')
})

test('刷新目录：回源拿上游真值，变化时通知宿主', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount())

  // 上游列表返回两个模型，其中一个是我们兜底快照里没有的
  const listing = JSON.stringify({
    qwork: [
      { key: 'flash', display_name: '标准', price_factor: 0.1, is_vl: true, is_reasoning: true },
      { key: 'brand-new-model', display_name: '新上架的', price_factor: 0.5, is_vl: false },
    ],
  })
  const gw = await gateway(() => ({ text: '{}' }), () => ({ text: listing }))

  try {
    const seen: string[][] = []
    const adapter = new QwenWorkAdapter({
      store,
      gateway: gw.base,
      onModelsChanged: models => seen.push(models.map(m => m.key)),
    })

    const models = await adapter.refreshModels(true)
    assert.equal(models.length, 2, '目录必须取上游给的，不是兜底快照')
    assert.ok(models.some(m => m.key === 'brand-new-model'), '上游新加的模型要被收进来')
    assert.ok(models.some(m => m.key === 'pro') === false, '兜底快照里的 pro 不该还留着')
    assert.deepEqual(seen, [['flash', 'brand-new-model']], '目录变了要通知一次')

    // 再刷一次：内容没变就不该再惊动宿主（刷新按钮会被反复点）
    await adapter.refreshModels(true)
    assert.equal(seen.length, 1, '内容没变时不该重复广播')
  } finally {
    await gw.close()
  }
})

test('刷新目录：上游挂了就沿用当前目录，不抛也不丢模型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount())

  const gw = await gateway(() => ({ status: 500, text: 'boom' }), () => ({ status: 500, text: 'boom' }))
  try {
    let notified = 0
    const adapter = new QwenWorkAdapter({
      store,
      gateway: gw.base,
      onModelsChanged: () => {
        notified += 1
      },
    })
    const before = adapter.models.length
    const beforeAt = adapter.modelsFetchedAt
    assert.equal(beforeAt, 0, '还没成功回源过，时间戳应为 0')

    const after = await adapter.refreshModels(true)
    assert.equal(after.length, before, '拉取失败要保留原目录')
    assert.equal(notified, 0, '没变化就不该广播')
    assert.equal(adapter.modelsFetchedAt, 0, '拉取失败不能把时间戳当成功——否则界面会谎报已回源')
  } finally {
    await gw.close()
  }
})

test('回归：会话选了上游新增的模型，不能报「未知模型」', async () => {
  // 真实场景：选择器拿到的是上游完整目录（含新加的 frontier-1），
  // 而 adapter 重启后还没来得及回源，手里只有兜底快照。
  // 早先 prepareCall/stream 直接查这张表，于是「选了新模型就处理失败」。
  const dir = await mkdtemp(join(tmpdir(), 'qw-adapter-'))
  const store = new AccountStore(dir)
  await store.upsert(anAccount())

  const listing = JSON.stringify({
    qwork: [
      { key: 'flash', display_name: '标准', price_factor: 0.1 },
      { key: 'frontier-1', display_name: 'Qwen4-Max 预览版', price_factor: 1.8 },
    ],
  })
  const gw = await gateway(() => ({ frames: [okFrame('新模型答的'), doneFrame] }), () => ({ text: listing }))

  try {
    const adapter = new QwenWorkAdapter({ store, gateway: gw.base })
    assert.equal(adapter.modelsFetchedAt, 0, '前置条件：还没回源过')
    assert.ok(
      adapter.models.some(m => m.key === 'frontier-1') === false,
      '前置条件：兜底快照里没有 frontier-1',
    )

    // 直接按会话里存的模型 key 发起调用
    const prepared = await adapter.prepareCall('qwenwork', 'frontier-1')
    assert.equal(prepared.model.id, 'frontier-1', 'prepareCall 前应先回源，能认出新模型')
    assert.ok(adapter.modelsFetchedAt > 0, 'prepareCall 应触发过一次回源')

    const chunks = []
    for await (const c of adapter.stream({
      model: 'frontier-1',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
    })) {
      chunks.push(c)
    }
    const text = chunks
      .filter((c: { type: string }) => c.type === 'text-delta')
      .map(c => (c as unknown as { text: string }).text)
      .join('')
    assert.equal(text, '新模型答的')
  } finally {
    await gw.close()
  }
})

/** 带图的提问（DSH 传的是附件引用，不是 base64）。 */
const imageMessage = () => ({
  role: 'user' as const,
  content: [
    { type: 'text', text: '这是什么' },
    {
      type: 'image',
      attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', bytes: 3, width: 10, height: 10, name: 'a.png' },
    },
  ],
})

/** 一张 10×10 的假图，附件服务就绪后由它吐出。 */
const tinyStore = (): AttachmentStore => ({
  async readImageRequest() {
    return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', bytes: 3, width: 10, height: 10 }
  },
})

/**
 * 发一条带图消息跑完一轮，回上游收到的 messages 与解出来的文本。
 *
 * 附件服务怎么给由 attach 决定（构造即给 / 惰性解析 / 惰性解析里抛错）。
 * 目录显式带 is_vl：否则标准档先被判成「不接受图片」，测不到读取链路。
 */
async function streamWithImage(
  attach: Record<string, unknown>,
): Promise<{ messages: string; text: string }> {
  const store = new AccountStore(await mkdtemp(join(tmpdir(), 'qw-adapter-')))
  await store.upsert(anAccount())

  let sentBody = ''
  const gw = await gateway(
    req => {
      sentBody = req.body
      return { frames: [okFrame('回了'), doneFrame] }
    },
    () => ({ text: JSON.stringify({ qwork: [{ key: 'flash', display_name: '标准', price_factor: 0.1, is_vl: true }] }) }),
  )

  try {
    const adapter = new QwenWorkAdapter({ store, gateway: gw.base, ...attach })
    const chunks = []
    for await (const c of adapter.stream({ model: 'flash', messages: [imageMessage()], max_tokens: 1000 })) chunks.push(c)
    const decoded = JSON.parse(decodeBody(sentBody)) as Record<string, unknown>
    return {
      messages: JSON.stringify(decoded.messages),
      text: chunks
        .filter((c: { type: string }) => c.type === 'text-delta')
        .map(c => (c as unknown as { text: string }).text)
        .join(''),
    }
  } finally {
    await gw.close()
  }
}

test('回归：只在请求时现取附件服务也能把图发出去（issue #1）', async () => {
  // 只给 attachmentsLookup、不给构造期的 attachments —— 正是插件早于宿主
  // provision 就绪时的形状。没这层惰性解析的话这条必退化成读不到图。
  const { messages } = await streamWithImage({ attachmentsLookup: () => tinyStore() })
  assert.ok(messages.includes('data:image/png;base64,'), '请求时现取到的服务应把图读出来随请求上行')
  assert.ok(!messages.includes('宿主附件服务不可用'), '不该退化成「读不到图」的说明')
})

test('附件服务始终不可用时仍明确告知，不静默丢图', async () => {
  const { messages } = await streamWithImage({ attachmentsLookup: () => undefined })
  assert.ok(messages.includes('宿主附件服务不可用'), '真没服务时要留一句说明，让用户知道图没送出去')
  assert.ok(!messages.includes('data:image/png;base64,'), '没有服务时不该出现图片块')
})

test('惰性解析器抛错按「没有服务」处理，不带崩整轮', async () => {
  const { text } = await streamWithImage({
    attachmentsLookup: () => {
      throw new Error('host service exploded')
    },
  })
  assert.equal(text, '回了', '取附件失败不该把整轮判死')
})

test('构造时就把服务给全的话不再走惰性解析（不白查宿主）', async () => {
  let lookups = 0
  const { messages } = await streamWithImage({
    attachments: tinyStore(),
    attachmentsLookup: () => {
      lookups += 1
      return undefined
    },
  })
  assert.ok(messages.includes('data:image/png;base64,'), '应直接用构造时给的服务')
  assert.equal(lookups, 0, '已经有服务时不该再查一次')
})

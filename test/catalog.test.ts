/**
 * 模型目录与图片处理测试。
 *
 * 这两块都是「上游给了什么就得如实接住」的地方，漏一个字段用户就少一个
 * 功能，所以按实测的真实响应形状来断言。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseModelListing,
  toModelEntry,
  formatRate,
  FALLBACK_MODELS,
  type ModelEntry,
} from '../src/adapter/catalog.ts'
import { collectImageRefs, resolveImages, imageFailureNote, type AttachmentStore } from '../src/adapter/images.ts'

/** 2026-11-03 实测的 flash 条目（截取关键字段）。 */
const REAL_FLASH = {
  key: 'flash',
  display_name: '标准',
  description: '极速全能，秒杀日常任务',
  is_vl: true,
  is_reasoning: true,
  enable: true,
  is_default: true,
  price_factor: 0.1,
  original_price_factor: null,
  max_input_tokens: 1_000_000,
  context_config: {
    '1M': { token_count: 1_000_000, is_default: true },
    '200K': { token_count: 200_000 },
    '400K': { token_count: 400_000 },
  },
  thinking_config: null,
  format: 'openai',
  source: 'system',
}

test('实测 flash：倍率、视觉、思考、上下文全部读出来', () => {
  const e = toModelEntry(REAL_FLASH)
  assert.ok(e)
  assert.equal(e.key, 'flash')
  assert.equal(e.displayName, '标准')
  assert.equal(e.description, '极速全能，秒杀日常任务')
  assert.equal(e.rate, 0.1, '倍率 0.1 必须读到，写死 1 会让用户以为贵 10 倍')
  assert.equal(e.isVision, true, 'is_vl 必须读到')
  assert.equal(e.isReasoning, true, 'is_reasoning 必须读到')
  assert.equal(e.maxInputTokens, 1_000_000)
  assert.deepEqual(e.windows, [200_000, 400_000, 1_000_000], '三档要按升序')
  assert.equal(e.defaultWindow, 1_000_000)
})

test('thinking_config 有档位阶梯时读出级联', () => {
  const e = toModelEntry({
    key: 'x',
    is_reasoning: true,
    thinking_config: {
      enabled: {
        efforts: {
          high: { is_default: true },
          low: {},
          medium: {},
        },
      },
    },
  })
  assert.ok(e)
  assert.deepEqual(e.efforts, ['low', 'medium', 'high'], '要按强度序排')
  assert.equal(e.defaultEffort, 'high')
})

test('thinking_config 为 null 时能思考但无档位', () => {
  const e = toModelEntry({ key: 'x', is_reasoning: true, thinking_config: null })
  assert.ok(e)
  assert.equal(e.isReasoning, true)
  assert.deepEqual(e.efforts, [], '没有阶梯就是空数组，不能编造')
})

test('enable=false 的模型不列出', () => {
  assert.equal(toModelEntry({ key: 'off', enable: false }), null)
})

test('auto / default 不是具体模型', () => {
  assert.equal(toModelEntry({ key: 'auto' }), null)
  assert.equal(toModelEntry({ key: 'default' }), null)
})

test('parseModelListing 读 qwork 场景', () => {
  const models = parseModelListing({ qwork: [REAL_FLASH, { key: 'pro', price_factor: 1 }] })
  assert.equal(models.length, 2)
  assert.equal(models[0]!.key, 'flash')
})

test('parseModelListing 忽略空的其他场景', () => {
  const models = parseModelListing({ chat: [], developer: [], qwork: [REAL_FLASH] })
  assert.equal(models.length, 1, 'chat/developer 空数组不该干扰')
})

test('parseModelListing 对垃圾输入返回空数组', () => {
  assert.deepEqual(parseModelListing(null), [])
  assert.deepEqual(parseModelListing('x'), [])
  assert.deepEqual(parseModelListing({}), [])
})

test('促销价：划线价与实付价都读', () => {
  const e = toModelEntry({
    key: 'x',
    price_factor: 0.5,
    promotion: { active: true, before_promotion_price_factor: 2, discount_factor: 0.25 },
  })
  assert.ok(e)
  assert.equal(e.rate, 0.5)
  assert.equal(e.rateWas, 2, '划线价应是最初的 2×')
})

test('formatRate 去掉多余小数', () => {
  assert.equal(formatRate(1), '1×')
  assert.equal(formatRate(0.1), '0.1×')
  assert.equal(formatRate(1.8), '1.8×')
  assert.equal(formatRate(0), '')
  assert.equal(formatRate(undefined), '')
})

test('兜底快照与实测一致', () => {
  const flash = FALLBACK_MODELS.find(m => m.key === 'flash')
  assert.ok(flash)
  assert.equal(flash.rate, 0.1)
  assert.equal(flash.isVision, true, '兜底也必须说支持视觉')
  assert.equal(flash.isReasoning, true)
  assert.deepEqual(flash.windows, [200_000, 400_000, 1_000_000])
})

// ── 图片 ──────────────────────────────────────────────────────────────────

test('collectImageRefs 认 DSH 的附件引用形状', () => {
  const { refs, inlineUrls } = collectImageRefs([
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 100, width: 10, height: 10 } },
  ])
  assert.equal(refs.length, 1)
  assert.equal(refs[0]!.attachmentId, 'att-1')
  assert.equal(inlineUrls.length, 0)
})

test('collectImageRefs 也认已是 data URL 的块', () => {
  const { refs, inlineUrls } = collectImageRefs([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ])
  assert.equal(refs.length, 0)
  assert.deepEqual(inlineUrls, ['data:image/png;base64,AAA'])
})

test('resolveImages 用附件服务把引用读成 data URL', async () => {
  const store: AttachmentStore = {
    async readImageRequest() {
      return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', bytes: 3, width: 10, height: 10 }
    },
  }
  const out = await resolveImages(
    [{ attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 10, height: 10 }],
    store,
  )
  assert.equal(out.images.size, 1)
  const first = out.images.get('a1')
  assert.ok(first !== undefined)
  assert.ok(first.dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(out.failed, 0)
})

test('没有附件服务时明确报失败，不静默丢', async () => {
  const out = await resolveImages(
    [{ attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 10, height: 10 }],
    undefined,
  )
  assert.equal(out.images.size, 0)
  assert.equal(out.failed, 1)
  assert.ok(out.reason !== undefined && out.reason.includes('附件'))
})

test('读图抛错时计入失败并带原因', async () => {
  const store: AttachmentStore = {
    async readImageRequest() {
      throw new Error('attachment not found')
    },
  }
  const out = await resolveImages(
    [{ attachmentId: 'gone', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
    store,
  )
  assert.equal(out.failed, 1)
  assert.ok(out.reason?.includes('attachment not found'))
})

test('imageFailureNote 说清丢了几张', () => {
  assert.equal(imageFailureNote(0), '')
  assert.ok(imageFailureNote(1).includes('1 张'))
  assert.ok(imageFailureNote(3).includes('3 张'))
  assert.ok(imageFailureNote(1, 'boom').includes('boom'))
})

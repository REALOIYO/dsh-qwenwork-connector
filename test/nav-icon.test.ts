/**
 * 导航图标测试。
 *
 * `isOwnNavRow` 是纯函数，直接测。DOM 部分用一个极简的 document 桩，
 * 验证标记会被打上、切语言能重新认领、销毁时摘干净。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isOwnNavRow, installSettingsNavIcon } from '../src/client/nav-icon.ts'

test('isOwnNavRow：文字完全相同才算', () => {
  assert.equal(isOwnNavRow('千问办公', '千问办公'), true)
  assert.equal(isOwnNavRow('  千问办公  ', '千问办公'), true, '应忽略首尾空白')
  assert.equal(isOwnNavRow('QwenWork', '千问办公'), false, '不同语言不算')
  assert.equal(isOwnNavRow('千问办公 2', '千问办公'), false)
  assert.equal(isOwnNavRow('', '千问办公'), false)
})

test('isOwnNavRow：label 为空时一律不认（语言未解析时不乱标）', () => {
  assert.equal(isOwnNavRow('千问办公', ''), false)
  assert.equal(isOwnNavRow('', ''), false)
  assert.equal(isOwnNavRow('anything', '   '), false)
})

/**
 * 极简 DOM 桩：只实现这个模块用到的部分。
 * 用真实的属性 map 记录，方便断言。
 */
function makeDom() {
  const rows: Array<{ textContent: string; attrs: Map<string, string>; setAttribute(k: string, v: string): void; removeAttribute(k: string): void }> = []
  const makeRow = (textContent: string) => {
    const attrs = new Map<string, string>()
    return {
      textContent,
      attrs,
      setAttribute(k: string, v: string) {
        attrs.set(k, v)
      },
      removeAttribute(k: string) {
        attrs.delete(k)
      },
    }
  }
  const styles: string[] = []
  const headChildren: Array<{ textContent: string; remove(): void }> = []

  const doc = {
    querySelectorAll(selector: string) {
      if (selector.includes('nav button')) return rows
      // 清理时按标记选择器查
      const m = selector.match(/\[([^\]]+)\]/)
      if (m) return rows.filter(r => r.attrs.has(m[1]!))
      return []
    },
    createElement() {
      const el = {
        dataset: {} as Record<string, string>,
        textContent: '',
        remove() {
          const at = styles.indexOf(el.textContent)
          if (at >= 0) styles.splice(at, 1)
        },
      }
      return el
    },
    head: {
      appendChild(el: { textContent: string; remove(): void }) {
        styles.push(el.textContent)
        headChildren.push(el)
      },
    },
    body: {},
  }

  return { doc, rows, makeRow, styles }
}

test('DOM 桩：标记本插件那一行，其他行不动', () => {
  const { doc, rows, makeRow, styles } = makeDom()
  rows.push(makeRow('账号与余额'), makeRow('千问办公'), makeRow('Our Free Model'))

  // 全局挂上桩，installSettingsNavIcon 用的是全局 document
  const prevDoc = (globalThis as Record<string, unknown>).document
  const prevObserver = (globalThis as Record<string, unknown>).MutationObserver
  ;(globalThis as Record<string, unknown>).document = doc
  ;(globalThis as Record<string, unknown>).MutationObserver = class {
    observe() {}
    disconnect() {}
  }

  try {
    let disposed: (() => void) | undefined
    const ctx = {
      effect(fn: () => () => void) {
        disposed = fn()
        return undefined
      },
    }

    installSettingsNavIcon(ctx, () => '千问办公')

    assert.equal(styles.length, 1, '应注入一份样式')
    assert.ok(styles[0]!.includes('data:image/svg+xml'), '样式应含 mask 图标')
    assert.ok(styles[0]!.includes('mask-image'), '样式应设置 mask')

    assert.ok(rows[1]!.attrs.has('data-dsh-qwenwork-nav-icon'), '本插件那行应被标记')
    assert.equal(rows[0]!.attrs.size, 0, '其他行不该被标记')
    assert.equal(rows[2]!.attrs.size, 0)

    // 销毁后摘干净
    disposed?.()
    assert.equal(rows[1]!.attrs.size, 0, '销毁后标记应被移除')
    assert.equal(styles.length, 0, '销毁后样式应被移除')
  } finally {
    ;(globalThis as Record<string, unknown>).document = prevDoc
    ;(globalThis as Record<string, unknown>).MutationObserver = prevObserver
  }
})

test('没有 document 时（服务端渲染）安全跳过', () => {
  const prevDoc = (globalThis as Record<string, unknown>).document
  delete (globalThis as Record<string, unknown>).document
  try {
    let called = false
    const ctx = {
      effect() {
        called = true
        return undefined
      },
    }
    assert.doesNotThrow(() => installSettingsNavIcon(ctx, () => '千问办公'))
    assert.equal(called, false, '没有 document 时不该注册 effect')
  } finally {
    ;(globalThis as Record<string, unknown>).document = prevDoc
  }
})

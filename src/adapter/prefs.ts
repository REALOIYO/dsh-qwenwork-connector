/**
 * 用户偏好：每个模型用哪个上下文档位。
 *
 * 上游给每个模型三档（1M / 400K / 200K），选大档吃更多上下文、也更贵；
 * 选小档省钱但长对话会被截。默认走「自动」——按消息实际大小挑够用的
 * 最小档，这是最省心的做法，但用户想固定某一档时得能改。
 *
 * 存成 `{ [modelKey]: windowTokens }`，与账号文件分开（偏好不是凭证）。
 *
 * @module src/adapter/prefs.ts
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 「自动」用这个值表示：不固定，按消息大小挑。 */
export const AUTO_WINDOW = 0

/** 落盘格式。 */
interface StoredPrefs {
  version: 1
  /** 模型 key → 固定档位（token 数）；0 或缺省表示自动。 */
  windows: Record<string, number>
}

/** 偏好存储。 */
export class PrefsStore {
  readonly #path: string
  #windows: Record<string, number> = {}
  #loaded = false

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'prefs.json')
    // 构造时就同步读一次。
    //
    // 这不是冗余：`apply()` 是同步函数，没法 await 一次 load；而
    // `resolveModel()` / `buildBody()` 都是同步取档位的。若等设置页的
    // `/status` 路由去触发 `load()`，冷启动（重启后没打开设置页）这段时间里
    // 偏好一直是空表 —— UI 按上游最大值显示 1M，实际请求却按「自动」发，
    // 两边对不上。文件很小（几十字节），同步读没有性能顾虑。
    this.#primeSync()
  }

  /** 同步读盘。失败（含首次运行无文件）一律当作空偏好。 */
  #primeSync(): void {
    try {
      const raw = readFileSync(this.#path, 'utf8')
      this.#applyParsed(JSON.parse(raw) as Partial<StoredPrefs>)
    } catch {
      // 没有文件 / 内容坏了都按空偏好处理，不影响启动
    }
  }

  /** 把解析结果并进内存表（两边共用的校验逻辑）。 */
  #applyParsed(parsed: Partial<StoredPrefs>): void {
    const windows = parsed?.windows
    if (windows !== null && windows !== undefined && typeof windows === 'object') {
      for (const [key, value] of Object.entries(windows)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          this.#windows[key] = Math.floor(value)
        }
      }
    }
  }

  get path(): string {
    return this.#path
  }

  async load(): Promise<void> {
    if (this.#loaded) return
    try {
      const raw = await readFile(this.#path, 'utf8')
      this.#applyParsed(JSON.parse(raw) as Partial<StoredPrefs>)
    } catch {
      // 首次运行没有文件是正常的
    }
    this.#loaded = true
  }

  /** 某模型固定的档位；0 表示自动。 */
  windowFor(model: string): number {
    return this.#windows[model] ?? AUTO_WINDOW
  }

  /** 全部偏好（给设置页读）。 */
  all(): Record<string, number> {
    return { ...this.#windows }
  }

  /** 设置某模型的档位；传 0 恢复自动。 */
  async setWindow(model: string, tokens: number): Promise<void> {
    await this.load()
    const key = model.trim()
    if (key === '') throw new Error('qwenwork: 模型 key 不能为空')
    const value = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : AUTO_WINDOW
    if (value === AUTO_WINDOW) delete this.#windows[key]
    else this.#windows[key] = value
    await this.#flush()
  }

  /** 原子写。 */
  async #flush(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${process.pid}.tmp`
    const payload: StoredPrefs = { version: 1, windows: this.#windows }
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.#path)
  }
}

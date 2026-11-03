/**
 * 千问办公的模型目录。
 *
 * 上游的 `/algo/api/v2/model/list` 会给出每个模型的能力与价格，这些字段
 * **全都得读**，写死任何一个都会让用户看到的和实际能用的不一致：
 *
 *   price_factor    积分倍率（flash 0.1×、max 1.8×）
 *   is_vl           能不能收图
 *   is_reasoning    会不会思考
 *   context_config  可选上下文档位（1M / 400K / 200K）
 *   description     给用户看的用途说明
 *
 * 拿不到列表时退回静态快照（登录前就是这种情况），字段照实测值抄。
 *
 * @module src/adapter/catalog.ts
 */

/** 一个模型的价格与能力。 */
export interface ModelEntry {
  /** 请求里用的 key。 */
  key: string
  /** 显示名。 */
  displayName: string
  /** 用途说明（上游原文）。 */
  description?: string
  /** 积分倍率：1 是标准价，0.1 是打一折。 */
  rate?: number
  /** 打折前倍率（有促销时有值，用于显示划线价）。 */
  rateWas?: number
  /** 是否免费。 */
  free?: boolean
  /** 能否收图。 */
  isVision?: boolean
  /** 会不会思考。 */
  isReasoning?: boolean
  /**
   * 思考档位阶梯。空数组表示「能思考但没有档位可选」——
   * 这种情况只发 enable_thinking，不带 reasoning_effort。
   */
  efforts?: string[]
  /** 默认档位。 */
  defaultEffort?: string
  /** 最大输入 tokens。 */
  maxInputTokens?: number
  /** 可选上下文档位（升序）。 */
  windows?: number[]
  /** 默认上下文档位。 */
  defaultWindow?: number
  /** 格式，客户端默认 openai。 */
  format?: string
  /** 来源，客户端默认 system。 */
  source?: string
}

/**
 * 登录前用的静态快照。
 *
 * 值抄自 2026-11-03 实测的 qwork 列表。拿不到真实列表时用它，
 * 好过让选择器空着。
 */
export const FALLBACK_MODELS: ModelEntry[] = [
  {
    key: 'flash',
    displayName: '标准',
    description: '极速全能，秒杀日常任务',
    rate: 0.1,
    isVision: true,
    isReasoning: true,
    efforts: [],
    maxInputTokens: 1_000_000,
    windows: [200_000, 400_000, 1_000_000],
    defaultWindow: 1_000_000,
  },
  {
    key: 'pro',
    displayName: '高级',
    description: '性能均衡，擅长复杂任务',
    rate: 1,
    isVision: true,
    isReasoning: true,
    efforts: [],
    maxInputTokens: 1_000_000,
    windows: [200_000, 400_000, 1_000_000],
    defaultWindow: 1_000_000,
  },
  {
    key: 'qwen3.8-max-preview',
    displayName: 'Qwen3.8-Max',
    description: '千问最强模型',
    rate: 1.8,
    isVision: true,
    isReasoning: true,
    efforts: [],
    maxInputTokens: 1_000_000,
    windows: [200_000, 400_000, 1_000_000],
    defaultWindow: 1_000_000,
  },
]

/** 思考档位的强度序，用来给上游给的档位排序。 */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** 上游列表里的一条（只声明读的字段）。 */
interface RawModel {
  key?: unknown
  display_name?: unknown
  description?: unknown
  price_factor?: unknown
  priceFactor?: unknown
  original_price_factor?: unknown
  originalPriceFactor?: unknown
  is_free?: unknown
  isFree?: unknown
  is_vl?: unknown
  is_reasoning?: unknown
  enable?: unknown
  format?: unknown
  source?: unknown
  max_input_tokens?: unknown
  context_config?: unknown
  contextConfig?: unknown
  available_context_windows?: unknown
  default_context_window?: unknown
  reasoning_efforts?: unknown
  thinking_config?: unknown
  promotion?: unknown
}

const numOf = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * 读价格倍率。
 *
 * 有促销时：`promotion.before_promotion_price_factor` 是划线价，
 * 若当前价被算成 0 而促销力度有值，则用 `before * discount` 还原真实价。
 */
function rateOf(raw: RawModel): { rate: number; rateWas: number } {
  const price = raw.price_factor ?? raw.priceFactor
  if (typeof price !== 'number' || !Number.isFinite(price)) return { rate: 0, rateWas: 0 }

  const promotion = (raw.promotion ?? {}) as Record<string, unknown>
  const before = numOf(promotion.before_promotion_price_factor ?? promotion.beforePromotionPriceFactor)
  const discount = numOf(promotion.discount_factor ?? promotion.discountFactor)
  const active = promotion.active === true && before > 0

  let rate = Math.max(price, 0)
  let rateWas = Math.max(numOf(raw.original_price_factor), numOf(raw.originalPriceFactor))
  if (active) {
    rateWas = before
    if (rate === 0) rate = before * discount
  }
  if (rateWas <= rate) rateWas = 0
  return { rate, rateWas }
}

/**
 * 读可选的上下文档位。
 *
 * `context_config` 形如 `{"1M":{"token_count":1000000,"is_default":true}, ...}`；
 * 没有时退回 `available_context_windows`。
 */
function windowsOf(raw: RawModel): { windows: number[]; defaultWindow: number } {
  const positive = (v: unknown): number => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0)
  const windows: number[] = []
  let def = 0

  const config = (raw.context_config ?? raw.contextConfig) as Record<string, unknown> | undefined
  if (config !== null && config !== undefined && typeof config === 'object' && !Array.isArray(config)) {
    for (const entry of Object.values(config)) {
      const e = entry as Record<string, unknown> | null
      const tokens = positive(e?.token_count)
      if (tokens === 0) continue
      if (!windows.includes(tokens)) windows.push(tokens)
      if (e?.is_default === true || e?.is_default === 1 || e?.is_default === '1') def = tokens
    }
  }

  if (windows.length === 0) {
    const list = raw.available_context_windows
    for (const v of Array.isArray(list) ? list : []) {
      const tokens = positive(v)
      if (tokens > 0 && !windows.includes(tokens)) windows.push(tokens)
    }
    def = positive(raw.default_context_window)
    if (!windows.includes(def)) def = 0
  }

  windows.sort((a, b) => a - b)
  return { windows, defaultWindow: def }
}

/**
 * 读思考档位。
 *
 * `thinking_config.enabled.efforts` 是 `{low: {...}, high: {is_default: true}}`
 * 这种形状；没有 `thinking_config` 但 `is_reasoning` 为 true 时，
 * 模型能思考但没有档位可选（只发 enable_thinking）。
 */
function thinkingOf(raw: RawModel): {
  isReasoning: boolean
  efforts: string[]
  defaultEffort: string
} {
  const config = raw.thinking_config as Record<string, unknown> | null | undefined
  if (config !== null && config !== undefined && typeof config === 'object') {
    const enabled = config.enabled as Record<string, unknown> | undefined
    if (config.enabled == null) return { isReasoning: false, efforts: [], defaultEffort: '' }
    const efforts: string[] = []
    let defaultEffort = ''
    const declared = enabled?.efforts as Record<string, unknown> | undefined
    if (declared !== null && declared !== undefined && typeof declared === 'object') {
      for (const [name, entry] of Object.entries(declared)) {
        efforts.push(name)
        if ((entry as { is_default?: unknown })?.is_default === true) defaultEffort = name
      }
    }
    const rank = (s: string): number => {
      const at = EFFORT_ORDER.indexOf(s)
      return at < 0 ? EFFORT_ORDER.length : at
    }
    efforts.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    return { isReasoning: true, efforts, defaultEffort }
  }

  // 没有 thinking_config：能思考但没档位
  const fallbackEfforts = Array.isArray(raw.reasoning_efforts)
    ? raw.reasoning_efforts.filter((v): v is string => typeof v === 'string')
    : []
  return { isReasoning: raw.is_reasoning === true, efforts: fallbackEfforts, defaultEffort: '' }
}

/** 把一个上游条目读成我们的形状。 */
export function toModelEntry(raw: RawModel): ModelEntry | null {
  const key = typeof raw.key === 'string' ? raw.key.trim() : ''
  if (key === '') return null
  // auto / default 是上游路由内部用的，不是具体模型
  if (key === 'auto' || key === 'default') return null
  // 明确关掉的模型不列出
  if (raw.enable === false) return null

  const { windows, defaultWindow } = windowsOf(raw)
  const { isReasoning, efforts, defaultEffort } = thinkingOf(raw)
  const { rate, rateWas } = rateOf(raw)

  const entry: ModelEntry = {
    key,
    displayName: typeof raw.display_name === 'string' && raw.display_name.trim() !== '' ? raw.display_name : key,
    rate,
    isVision: raw.is_vl === true,
    isReasoning,
    efforts,
    maxInputTokens:
      Number.isInteger(raw.max_input_tokens) && (raw.max_input_tokens as number) > 0
        ? (raw.max_input_tokens as number)
        : windows.length > 0
          ? windows[windows.length - 1]!
          : 0,
    ...(windows.length > 0 ? { windows } : {}),
    ...(defaultWindow > 0 ? { defaultWindow } : {}),
  }
  if (typeof raw.description === 'string' && raw.description.trim() !== '') entry.description = raw.description
  if (rateWas > 0) entry.rateWas = rateWas
  if (raw.is_free === true) entry.free = true
  if (defaultEffort !== '') entry.defaultEffort = defaultEffort
  if (typeof raw.format === 'string') entry.format = raw.format
  if (typeof raw.source === 'string') entry.source = raw.source
  return entry
}

/**
 * 从一份模型列表响应里取出模型。
 *
 * 千问办公用的是 `qwork` 场景；响应里还有 chat/developer/assistant 等
 * 别的场景，那些不是给 agent 用的。
 */
export function parseModelListing(payload: unknown): ModelEntry[] {
  const root = payload as Record<string, unknown> | null
  if (root === null || typeof root !== 'object') return []

  // qwork 优先；没有就依次试别的场景
  const scenes = ['qwork', 'app', 'chat']
  for (const scene of scenes) {
    const list = root[scene]
    if (!Array.isArray(list)) continue
    const out: ModelEntry[] = []
    const seen = new Set<string>()
    for (const item of list) {
      const entry = toModelEntry(item as RawModel)
      if (entry === null || seen.has(entry.key)) continue
      seen.add(entry.key)
      out.push(entry)
    }
    if (out.length > 0) return out
  }
  return []
}

/** 倍率显示成 `0.1×` / `1.8×`。 */
export function formatRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return ''
  // 去掉多余的小数位：0.1 → 0.1，1 → 1，1.8 → 1.8
  const text = Number(rate.toFixed(2)).toString()
  return `${text}×`
}

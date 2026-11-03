/**
 * DSH 请求 → QwenWork 的 agent_chat_generation 请求体。
 *
 * 移植自 `@magpie-community/opencode-qoder-auth@0.2.59`（MIT），
 * 原实现 `qoderBody` / `qoderMessages` / `modelConfig` / `effortFor` / `windowFor`。
 *
 * 与 OpenAI 的差异都必须照客户端的方式处理：
 *   1. system 提示是 `system: [{type:'text'}]` 加上 messages 首条重复一份
 *   2. 消息块要打 prompt cache 标记（`cacheMarked`）
 *   3. tool 结果必须严格配对到前面的 tool_call，否则整轮被拒
 *   4. 图片是附件引用，要先读成 base64，且**图前要放一句尺寸说明**
 *
 * @module src/adapter/body.ts
 */

import {
  imageFailureNote,
  imageHandleText,
  offloadedImageText,
  type ImageAttachmentRef,
  type ResolvedImage,
} from './images.ts'
import type { ModelEntry } from './catalog.ts'
import { markTaskAnswered, taskOf, type Task } from './session.ts'

export type { ModelEntry }

/** 千问办公对 agent 的固定系统提示（客户端原话）。 */
export const QWENWORK_SYSTEM_PROMPT =
  'You are QwenWork (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.'

/**
 * DSH 传来的消息。
 *
 * **工具相关的形状不是 OpenAI 的**，这是照抄 `dsh-magpie-connect` 的
 * `HarnessBlock` / `HarnessMessage` 得来的（那是对的，因为它就是给 DSH 写的）：
 *
 *   - 工具调用是 assistant `content` 里的 `{ type:'tool-call', id, name, arguments }`
 *     块，**不是** `message.tool_calls` 数组
 *   - 工具结果 ID 在消息上是驼峰 `toolCallId`，**不是**下划线 `tool_call_id`
 *
 * 早期版本只认 OpenAI 那套，结果：assistant 的工具轮被整轮丢弃（tool-call
 * 块没有 text，textOf 取到空串），工具结果被并回 user 轮当纯文本 ——
 * 模型永远看不到自己调过什么、拿到了什么。与「23 个工具被过滤」同一根因。
 *
 * 两种形状都保留：DSH 的为主，OpenAI 的形状仍然接住（有些调用方会那么发）。
 */
export interface HarnessMessage {
  role: string
  content: unknown
  /** 工具结果消息上的工具调用 ID（驼峰，DSH 用这个）。 */
  toolCallId?: string
  /** 老式下划线写法，仍然接受。 */
  tool_call_id?: string
  isError?: boolean
  /** OpenAI 风格的 assistant 工具调用数组，仍然接受。 */
  tool_calls?: Array<{
    id?: string
    type?: string
    function?: { name?: string; arguments?: unknown }
  }>
  name?: string
  reasoning_content?: string
  reasoning?: string
}

/** DSH content 数组里的一个块（只声明用到的）。 */
type HarnessBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments?: unknown }
  | { type: 'tool-result'; toolCallId: string; content?: unknown; isError?: boolean }
  | { type: string; [key: string]: unknown }

/** 发一次聊天的输入。 */
export interface ChatRequest {
  messages: HarnessMessage[]
  /**
   * 工具定义。**两种形状都可能出现**：
   *   - 扁平：`{ name, description, parameters }` —— DSH 宿主实际传的就是这个
   *   - 包装：`{ type:'function', function:{ name, ... } }` —— OpenAI 风格
   *
   * 所以这里刻意用宽松类型，交给 {@link normaliseTool} 归一化。
   * 别把它收紧成某一种，否则另一种会被静默丢掉。
   */
  tools?: Array<Record<string, unknown>>
  tool_choice?: string
  toolChoice?: string
  /**
   * DSH 契约用**驼峰**：`maxTokens` / `reasoningEffort` / `system`。
   *
   * 早期版本只读下划线的 `max_tokens` / `reasoning_effort`，宿主传的驼峰
   * 字段一个也读不到 —— 于是输出上限永远走默认 32000，用户在 DSH 里
   * 调的输出长度和思考强度全部被静默忽略。两种命名都接住，别只留一种。
   */
  system?: string
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  /** OpenAI 风格的下划线命名，同样接受。 */
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: string
}

/** 一条内容块。 */
type Block =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 取纯文本（字符串或块数组里的文本块）。 */
/** 把 content 统一成块数组（字符串内容视作单个文本块），不做图片解析。 */
function rawBlocksOf(content: unknown): HarnessBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.filter((b): b is HarnessBlock => typeof b === 'object' && b !== null)
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        (b as { type?: string })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map(b => b.text)
    .join('')
}

/**
 * 把内容规范成块数组。
 *
 * 图片按 magpie 的 `userContentWithImages` 排：
 *  - 已解析的附件 → **先放一句尺寸说明，再放图片**
 *  - offloaded → 只放一句「已省略」
 *  - 本来就带 `image_url` 的 → 直接透传
 *
 * 说明这行不能省：模型靠它知道图的名字与预览尺寸。
 */
function blocksOf(content: unknown, resolved?: ReadonlyMap<string, ResolvedImage>): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const out: Block[] = []
  for (const p of content) {
    const part = p as {
      type?: string
      text?: unknown
      image_url?: unknown
      offloaded?: boolean
      attachment?: Partial<ImageAttachmentRef>
    }
    if (part?.type === 'text' && part.text != null) {
      out.push({ type: 'text', text: String(part.text) })
      continue
    }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url as { url?: string })?.url
      if (url) out.push({ type: 'image_url', image_url: { url } })
      continue
    }
    if (part?.type === 'image') {
      const ref = part.attachment as ImageAttachmentRef | undefined
      if (ref === undefined || typeof ref.attachmentId !== 'string') continue
      if (part.offloaded === true) {
        out.push({ type: 'text', text: offloadedImageText(ref) })
        continue
      }
      const image = resolved?.get(ref.attachmentId)
      if (image === undefined) continue
      out.push({ type: 'text', text: imageHandleText(ref, image) })
      out.push({ type: 'image_url', image_url: { url: image.dataUrl } })
    }
  }
  return out
}

/**
 * 把对话整理成 QwenWork 要的形状。
 *
 * 关键约束：**tool 结果必须紧跟在其 tool_call 之后**，且 id 对得上。
 * 客户端在客户端那边就会补齐丢失的 id，这里照做——否则服务端直接拒整轮。
 */
export function qwenworkMessages(
  messages: HarnessMessage[],
  /** attachmentId → 已读出的图片；缺省时图片块会被跳过。 */
  resolved?: ReadonlyMap<string, ResolvedImage>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const names = new Map<string, string>()
  /** 当前正在被回答的 assistant 轮：还没被结果认领的 call id。 */
  let open: string[] = []
  let loose: Block[] = []

  const flushLoose = (): void => {
    if (loose.length) {
      out.push({ role: 'user', content: loose })
      loose = []
    }
  }

  for (const [i, m] of messages.entries()) {
    if (m.role === 'system' || m.role === 'developer') continue

    if (m.role === 'user') {
      // 注意：这里**不清空 open**。
      //
      // DSH 会把工具结果塞在 user 消息的 content 里当 tool-result 块，
      // 如果一见到 user 就把待认领的 call 清掉，那些结果就永远配不上 id，
      // 只能被并回用户轮当纯文本。真正的 user 轮在下面会自己写出去，
      // 而 flushLoose 只在有 loose 内容时才会动 out。
      if (!rawBlocksOf(m.content).some(b => b?.type === 'tool-result')) {
        open = []
      }
      flushLoose()
    } else if (m.role !== 'tool') {
      flushLoose()
    }

    if (m.role === 'tool') {
      const text = textOf(m.content)
      const named = String(m.toolCallId ?? m.tool_call_id ?? '').trim()
      // 优先认领同名 id；丢了 id 的按顺序认领最早未答的那个
      let at = named ? open.indexOf(named) : -1
      if (at < 0) at = 0
      if (open.length === 0) {
        // 没有可答的 call：把内容并回用户轮，别丢文字
        const said = text.trim()
        if (said) loose.push({ type: 'text', text: said })
        continue
      }
      const answered = open.splice(at, 1)[0]!
      out.push({ role: 'tool', tool_call_id: answered, content: text })
      continue
    }

    if (m.role === 'assistant') {
      // 工具调用有两个来源，都要收：
      //   1. DSH 形状：content 里的 { type:'tool-call', id, name, arguments } 块
      //   2. OpenAI 形状：message.tool_calls 数组
      // 只读第 2 种的话，DSH 的整个工具轮会被当成「没有文本的空轮」丢掉。
      const fromContent = rawBlocksOf(m.content).filter(
        (b): b is Extract<HarnessBlock, { type: 'tool-call' }> => b?.type === 'tool-call',
      )
      const fromField = Array.isArray(m.tool_calls) ? m.tool_calls : []

      if (fromContent.length > 0 || fromField.length > 0) {
        open = []
        const normalised: Array<Record<string, unknown>> = []

        for (const [k, b] of fromContent.entries()) {
          const id = String(b.id ?? '').trim() || `call_${i}_${k}`
          const name = String(b.name ?? '')
          if (name) names.set(id, name)
          open.push(id)
          // arguments 在 DSH 里可能已经是对象，也可能是字符串
          const args =
            typeof b.arguments === 'string'
              ? b.arguments
              : JSON.stringify(b.arguments ?? {})
          normalised.push({ id, type: 'function', function: { name, arguments: args } })
        }

        for (const [k, c] of fromField.entries()) {
          const id = String(c.id ?? '').trim() || `call_${i}_f${k}`
          const name = String(c.function?.name ?? '')
          if (name) names.set(id, name)
          // 同上：两者相同时别重复登记
          if (!open.includes(id)) open.push(id)
          const args =
            typeof c.function?.arguments === 'string'
              ? c.function.arguments
              : JSON.stringify(c.function?.arguments ?? {})
          normalised.push({ id, type: 'function', function: { name, arguments: args } })
        }

        const said = textOf(m.content)
        const turn: Record<string, unknown> = { role: 'assistant', tool_calls: normalised }
        if (said) turn.content = said
        const thinking = reasoningOf(m)
        if (thinking) turn.reasoning_content = thinking
        out.push(turn)
        continue
      }
      const said = textOf(m.content)
      const thinking = reasoningOf(m)
      if (!said && !thinking) continue
      const turn: Record<string, unknown> = { role: 'assistant', content: said }
      if (thinking) turn.reasoning_content = thinking
      out.push(turn)
      continue
    }

    // user
    //
    // DSH 有时候不把工具结果单独发成 role:'tool' 消息，而是塞在 user
    // 消息的 content 里当 `{ type:'tool-result', toolCallId, content }` 块
    // （见 dsh-magpie-connect/messages.ts:371-386）。那些块不能当普通
    // 内容丢掉，要拆成独立的 tool 轮，否则模型看不到工具返回值。
    const results = rawBlocksOf(m.content).filter(
      (b): b is Extract<HarnessBlock, { type: 'tool-result' }> => b?.type === 'tool-result',
    )
    const blocks = blocksOf(m.content, resolved)
    if (blocks.length) out.push({ role: 'user', content: blocks })

    for (const r of results) {
      const text = textOf(r.content)
      const named = String(r.toolCallId ?? '').trim()
      let at = named ? open.indexOf(named) : -1
      if (at < 0) at = 0
      if (open.length === 0) {
        // 没有可认领的 call：把内容并回用户轮，别丢字
        const said = text.trim()
        if (said) out.push({ role: 'user', content: [{ type: 'text', text: said }] })
        continue
      }
      const answered = open.splice(at, 1)[0]!
      out.push({ role: 'tool', tool_call_id: answered, content: text })
    }
  }

  flushLoose()
  return out
}

/** assistant 轮带回的思考内容（兼容三种字段写法）。 */
function reasoningOf(m: HarnessMessage): string {
  const direct = [m.reasoning_content, m.reasoning].find(v => typeof v === 'string' && v.trim() !== '')
  if (typeof direct === 'string') return direct
  const details = (m as { reasoning_details?: Array<{ text?: string; summary?: string }> }).reasoning_details
  if (Array.isArray(details)) {
    const joined = details
      .map(d => (typeof d?.text === 'string' ? d.text : typeof d?.summary === 'string' ? d.summary : ''))
      .join('')
    if (joined.trim()) return joined
  }
  return ''
}

/**
 * 给最后一条用户消息的末块打 prompt cache 标记。
 * 不打的话每轮都重算，长对话会明显变慢变贵。
 */
/**
 * 客户端不会给这几类块打 cache 标记。
 *
 * 照 magpie 的 `UNCACHED`：思考、加密思考、工具调用、工具结果。
 * 给图片块打标记也不行——服务端会直接 400（实测「Error in upstream response」）。
 */
const UNCACHED = new Set(['thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'image_url'])

/**
 * 给最后一条 user 消息里最后一个可缓存的块打 prompt cache 标记。
 *
 * 照 magpie 的 `cacheMarked`：
 *  - 每个 user 轮的块**同时写进 `contents`**（客户端双写，服务端按 contents 读）
 *  - 只标最后一条 user 消息，且跳过 UNCACHED 里的类型
 *  - 从后往前找，找到第一个能标的就停
 *
 * 不打标记的话，只认标记缓存的模型（Anthropic 那类）会每轮重算，
 * 长对话明显变慢变贵。
 */
function cacheMarked(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  // 双写 contents：客户端就是这么发的
  const out = messages.map(m =>
    m.role === 'user' && Array.isArray(m.content) ? { ...m, contents: m.content } : m,
  )

  const last = out[out.length - 1]
  if (last?.role !== 'user' || !Array.isArray(last.content)) return out

  const blocks = last.content as Array<Record<string, unknown>>
  // 从后往前找第一个可缓存的块
  let at = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i]?.type
    if (typeof type === 'string' && type !== '' && !UNCACHED.has(type)) {
      at = i
      break
    }
  }
  if (at < 0) return out

  const marked = blocks.slice()
  marked[at] = { ...marked[at]!, cache_control: { type: 'ephemeral' } }
  out[out.length - 1] = { ...last, content: marked, contents: marked }
  return out
}

/** 一个模型的请求侧配置。 */
function modelConfig(m: ModelEntry, thinking: boolean): Record<string, unknown> {
  const key = m.key.trim()
  if (!key || ['auto', 'default'].includes(key)) {
    throw new Error(`qwenwork: 模型 key 不可用（${JSON.stringify(m.key)}）`)
  }
  return {
    key,
    display_name: m.displayName || key,
    model: '',
    format: m.format ?? 'openai',
    is_vl: m.isVision === true,
    is_reasoning: m.isReasoning === true && thinking,
    api_key: '',
    url: '',
    source: m.source || 'system',
    max_input_tokens: m.maxInputTokens && m.maxInputTokens > 0 ? m.maxInputTokens : 200_000,
  }
}

/** 小额度请求不思考：标题、分类这类调用不该把预算烧在推理上。 */
const SMALL_BUDGET = 1024

/**
 * 思考档位的强度序。
 *
 * `off` 是 DSH/pi-ai 表示「关闭思考」的取值（见 dsh-llm-pi-ai 的
 * `thinkingLevelMap`：`{ off: null }`），它不在强度阶梯里，要单独认。
 * 早期版本只认 none，用户选 off 会被当成无效值忽略、思考关不掉。
 */
const EFFORT_OFF = new Set(['off', 'none', 'disabled', 'false'])
const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/**
 * 把一个请求的档位夹到模型真有的档位里（照 magpie 的 `fitEffort`）。
 * 距离相同时往强的方向靠。
 */
function fitEffort(want: string, levels: readonly string[]): string {
  let target = want
  if (target === 'ultra' && !levels.includes(target)) target = 'max'
  if (levels.length === 0 || levels.includes(target)) return target
  const at = EFFORT_RANK.indexOf(target)
  if (at < 0) return target
  let best = target
  let distance = EFFORT_RANK.length
  for (const level of levels) {
    const i = EFFORT_RANK.indexOf(level)
    if (i < 0 || level === 'none') continue
    const d = Math.abs(i - at)
    if (d < distance || (d === distance && i > at)) {
      best = level
      distance = d
    }
  }
  return best
}

/**
 * 决定这次要不要思考、带哪个档位（照 magpie 的 `effortFor`）。
 *
 *  - 模型不会思考 → 不思考、不带档位
 *  - 请求预算 ≤1024 → 不思考
 *  - 用户说 none → 不思考
 *  - 模型没有档位阶梯 → 只开思考，不带 reasoning_effort
 *  - 否则按用户要求，夹到模型真有的档位
 */
function decideThinking(
  asked: string | undefined,
  model: ModelEntry,
  budget: number,
): { thinking: boolean; effort: string } {
  const levels = model.efforts ?? []
  let want = String(asked ?? '').toLowerCase()
  // `off` 归一成 `none`，两种写法都表示关闭
  if (EFFORT_OFF.has(want)) want = 'none'
  if (want !== 'none' && !EFFORT_RANK.includes(want)) want = ''
  if (want === '' && budget > 0 && budget <= SMALL_BUDGET) want = 'none'

  if (model.isReasoning !== true) return { thinking: false, effort: '' }
  if (want === 'none') return { thinking: false, effort: '' }
  if (levels.length === 0) return { thinking: true, effort: '' }
  if (want === '') return { thinking: true, effort: model.defaultEffort ?? '' }
  return { thinking: true, effort: fitEffort(want, levels) }
}

/**
 * 选这次请求用的上下文窗口。
 *
 *  - 用户固定了某档 → 用它（只有消息塞不下才升档）
 *  - 否则按消息大小挑够用的最小档（照 magpie 的 `windowFor`）
 *
 * 0 表示不带这个字段。
 */
export function windowFor(
  req: ChatRequest,
  model: ModelEntry,
  replyTokens = 0,
  fixedWindow = 0,
): number {
  const windows = model.windows ?? []
  const base = model.defaultWindow ?? model.maxInputTokens ?? 0

  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify({ m: req.messages ?? [], t: req.tools ?? [] }), 'utf8')
  } catch {
    bytes = 0
  }
  const need = Math.ceil(bytes / 3) + Math.max(0, replyTokens)

  if (fixedWindow > 0) {
    if (windows.length === 0) return fixedWindow
    if (need <= fixedWindow) return fixedWindow
    return windows.find(w => w >= need) ?? windows[windows.length - 1] ?? fixedWindow
  }

  if (windows.length === 0) return base
  if (base > 0 && need <= base) return base
  return windows.find(w => w >= need) ?? windows[windows.length - 1] ?? base
}

/**
 * 组装 agent_chat_generation 的明文请求体。
 *
 * @param sessionId 会话标识，同一对话要稳定（影响服务端缓存）
 * @param requestId 本次请求的 uuid
 * @param fixedWindow 用户固定的上下文档位；0 = 自动
 * @param resolved attachmentId → 已读出的图片
 * @param imageFailure 读图失败的数量与原因
 */
export function buildBody(
  req: ChatRequest,
  model: ModelEntry,
  sessionId: string,
  requestId: string,
  task: Task,
  fixedWindow = 0,
  resolved?: ReadonlyMap<string, ResolvedImage>,
  imageFailure?: { failed: number; reason?: string },
): Record<string, unknown> {
  // 系统提示有两个来源，**两个都要读**（照 dsh-magpie-connect/messages.ts:390）：
  //
  //   1. `options.system` —— DSH 契约里真正传系统提示的字段
  //   2. messages 里 role === 'system' / 'developer' 的消息
  //
  // 这里曾经只读第 2 种，结果 DSH 的全部系统提示都没发给上游：
  // 实测传 `system: '你叫小白'` 过去，模型照样自称「我是 QwenWork（qw）」。
  // 宿主给的 system 是 string，规范在先，消息体里的往后排。
  const declared = typeof req.system === 'string' && req.system.trim() !== '' ? req.system : ''
  const systems = req.messages
    .filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => textOf(m.content))
    .filter(Boolean)
  if (declared !== '') systems.unshift(declared)
  const base = QWENWORK_SYSTEM_PROMPT
  const systemText = systems.length ? `${base}\n\n${systems.join('\n\n')}` : base

  // 工具定义转换 —— **照抄 dsh-magpie-connect/src/adapter/messages.ts:toolsOf()**
  //
  //   const tools = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  //
  // 它直接取 tool.name，不做任何过滤、不解包 —— 因为 DSH 宿主传的就是
  // 扁平结构 { name, description, parameters }。
  //
  // 这里曾照抄 magpie **网关**（yetone/magpie 的 qoderBody）那行
  //   .filter(t => t?.type === "function" && t.function?.name)
  // 那行对网关是对的：它的输入来自 Cline / Roo / OpenCode 这些标准
  // OpenAI 客户端，确实带包装。但 DSH 不是 OpenAI 客户端，
  // 同一行搬过来就把 23 个工具全过滤没了 —— 模型看不到工具，想调却
  // 无从调起，只吐一段思考就结束，表现为「几秒钟截断、只有思维链」。
  //
  // 教训：抄 DSH 插件（dsh-magpie-connect），别抄协议网关（magpie）。
  // 两个项目同源但输入形状不同。
  const tools = ((req.tool_choice ?? req.toolChoice) !== 'none' ? (req.tools ?? []) : [])
    .map(t => normaliseTool(t))
    .filter((t): t is NormalisedTool => t !== undefined)

  // 字段名两种都认：DSH 契约是驼峰（maxTokens / reasoningEffort），
  // OpenAI 风格是下划线（max_tokens / reasoning_effort）。
  // 只认一种就会让宿主传的值被静默忽略。
  const budget = req.maxTokens ?? req.max_completion_tokens ?? req.max_tokens ?? 0
  const maxTokens = req.maxTokens ?? req.max_completion_tokens ?? req.max_tokens ?? 32000
  const { thinking, effort } = decideThinking(req.reasoningEffort ?? req.reasoning_effort, model, budget)

  const parameters: Record<string, unknown> = {
    enable_thinking: thinking,
    max_tokens: maxTokens,
  }
  // 只有模型确实有档位阶梯时才带；千问办公现在三个模型都是无档位
  if (effort !== '') parameters.reasoning_effort = effort
  if (typeof req.temperature === 'number') parameters.temperature = req.temperature

  const contextWindow = windowFor(req, model, maxTokens, fixedWindow)
  if (contextWindow > 0) parameters.context_length = contextWindow

  const sys = { type: 'text', text: systemText }
  const body: Record<string, unknown> = {
    request_id: requestId,
    // 同一任务的所有调用共用 request_set_id 与 begin_at
    request_set_id: task.id,
    chat_record_id: requestId,
    session_id: sessionId,
    parameters,
    business: {
      product: 'qoder_work',
      version: '1.1.59',
      type: 'agent',
      id: task.id,
      name: task.name,
      begin_at: task.begin,
      // 任务被回答过一轮后就是 processing
      stage: task.answered ? 'processing' : 'start',
    },
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qoder_work',
    model_config: modelConfig(model, thinking),
    system: [sys],
    messages: [{ role: 'system', content: [sys] }, ...cacheMarked(qwenworkMessages(req.messages, resolved))],
  }

  if (tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: normaliseSchema(t.parameters) ?? { type: 'object', properties: {} },
      },
    }))
  }

  if ((req.tool_choice ?? req.toolChoice) === 'required' && tools.length) {
    const s = body.system as Array<{ type: string; text: string }>
    s[0]!.text += '\nYou must call an available function in this response.'
    const first = (body.messages as Array<{ role: string; content: unknown }>)[0]!
    first.content = [s[0]]
  }

  // 图读不出来时留一句说明，别让用户以为图发出去了
  if (imageFailure !== undefined && imageFailure.failed > 0) {
    const note = imageFailureNote(imageFailure.failed, imageFailure.reason)
    if (note !== '') {
      const msgs = body.messages as Array<{ role: string; content: unknown }>
      const lastUser = [...msgs].reverse().find(m => m.role === 'user')
      if (lastUser !== undefined) {
        if (Array.isArray(lastUser.content)) (lastUser.content as Block[]).push({ type: 'text', text: note })
        else if (typeof lastUser.content === 'string') lastUser.content = `${lastUser.content}\n\n${note}`
      }
    }
  }

  return body
}

/**
 * 服务端对 schema 挑剔：**整棵** schema 里凡是「没有 type、但 oneOf 的
 * 每个分支都是 object」的节点，都要补上 `type: 'object'`。
 *
 * 只补顶层的做法不够——工具参数经常是嵌套的，漏掉的深层节点一样会被拒。
 * 照 magpie 的 `typedUnions`：递归走完整棵树，能解析 `$ref`，深度有上限
 * 防环。
 */

/** 值是单个子 schema 的键。 */
const SUB_ONE = [
  'items',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'additionalProperties',
  'unevaluatedProperties',
]
/** 值是子 schema 数组的键。 */
const SUB_LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
/** 值是「名字 → 子 schema」映射的键。 */
const SUB_MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']

/** 一个已归一化的工具定义。 */
interface NormalisedTool {
  name: string
  description: string
  parameters: unknown
}

/**
 * 把任意形状的工具定义归一化成 `{ name, description, parameters }`。
 *
 * 认两种形状：
 *   - DSH 宿主给的扁平结构：`{ name, description, parameters }`
 *   - OpenAI 风格包装：`{ type:'function', function:{ name, ... } }`
 *
 * 认不出来就返回 undefined（该工具被丢弃），调用方要能接受空列表——
 * 但**不要**因为形状不合预期就把宿主的工具全丢掉，那会让模型
 * 一个工具都看不到。
 */
function normaliseTool(tool: unknown): NormalisedTool | undefined {
  if (!tool || typeof tool !== 'object') return undefined
  const t = tool as Record<string, unknown>

  // 包装形状优先（有些人会把包装套在包装里）
  const inner = t.function
  if (inner && typeof inner === 'object') {
    const f = inner as Record<string, unknown>
    const name = typeof f.name === 'string' ? f.name.trim() : ''
    if (name === '') return undefined
    return {
      name,
      description: typeof f.description === 'string' ? f.description : '',
      parameters: f.parameters,
    }
  }

  // 扁平形状
  const name = typeof t.name === 'string' ? t.name.trim() : ''
  if (name === '') return undefined
  return {
    name,
    description: typeof t.description === 'string' ? t.description : '',
    parameters: t.parameters,
  }
}

function normaliseSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  const root = structuredClone(schema) as Record<string, unknown>
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

  /** 按 JSON Pointer 找 `$ref` 指向的节点。 */
  const target = (ref: string): Record<string, unknown> | undefined => {
    if (!ref.startsWith('#/')) return undefined
    let at: unknown = root
    for (const k of ref.slice(2).split('/')) {
      if (!isObj(at)) return undefined
      at = at[k.replaceAll('~1', '/').replaceAll('~0', '~')]
    }
    return isObj(at) ? at : undefined
  }

  /** 判断一个分支最终是不是 object（会跟 `$ref`，带环检测）。 */
  const isObject = (branch: unknown, seen: string[] = []): boolean => {
    if (!isObj(branch)) return false
    if ('type' in branch) return branch.type === 'object'
    if (typeof branch.$ref !== 'string' || seen.includes(branch.$ref) || seen.length > 16) return false
    return isObject(target(branch.$ref), [...seen, branch.$ref])
  }

  const walk = (node: unknown, depth: number): void => {
    if (!isObj(node) || depth > 64) return
    if (
      !('type' in node) &&
      Array.isArray(node.oneOf) &&
      node.oneOf.length > 0 &&
      node.oneOf.every(b => isObject(b))
    ) {
      node.type = 'object'
    }
    for (const k of SUB_ONE) walk(node[k], depth + 1)
    for (const k of SUB_LIST) {
      const list = node[k]
      if (Array.isArray(list)) for (const v of list) walk(v, depth + 1)
    }
    for (const k of SUB_MAP) {
      const map = node[k]
      if (isObj(map)) for (const v of Object.values(map)) walk(v, depth + 1)
    }
  }

  walk(root, 0)
  return root
}

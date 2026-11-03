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

export type { ModelEntry }

/** 千问办公对 agent 的固定系统提示（客户端原话）。 */
export const QWENWORK_SYSTEM_PROMPT =
  'You are QwenWork (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.'

/** DSH 传来的消息（只声明用到的字段）。 */
export interface HarnessMessage {
  role: string
  content: unknown
  tool_call_id?: string
  tool_calls?: Array<{
    id?: string
    type?: string
    function?: { name?: string; arguments?: unknown }
  }>
  name?: string
  reasoning_content?: string
  reasoning?: string
}

/** 发一次聊天的输入。 */
export interface ChatRequest {
  messages: HarnessMessage[]
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>
  tool_choice?: string
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  reasoning_effort?: string
}

/** 一条内容块。 */
type Block =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 取纯文本（字符串或块数组里的文本块）。 */
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
      open = []
      flushLoose()
    } else if (m.role !== 'tool') {
      flushLoose()
    }

    if (m.role === 'tool') {
      const text = textOf(m.content)
      const named = String(m.tool_call_id ?? '').trim()
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
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      if (calls.length > 0) {
        open = []
        const normalised = calls.map((c, k) => {
          const id = String(c.id ?? '').trim() || `call_${i}_${k}`
          const name = String(c.function?.name ?? '')
          if (name) names.set(id, name)
          open.push(id)
          const args =
            typeof c.function?.arguments === 'string'
              ? c.function.arguments
              : JSON.stringify(c.function?.arguments ?? {})
          return { id, type: 'function', function: { name, arguments: args } }
        })
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
    const blocks = blocksOf(m.content, resolved)
    if (blocks.length) out.push({ role: 'user', content: blocks })
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
function cacheMarked(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    const blocks = m.content as Array<Record<string, unknown>>
    if (blocks.length === 0) continue
    const last = blocks[blocks.length - 1]!
    blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
    break
  }
  return messages
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

/** 思考档位的强度序。 */
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

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
  if (!EFFORT_RANK.includes(want)) want = ''
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
  taskId: string,
  fixedWindow = 0,
  resolved?: ReadonlyMap<string, ResolvedImage>,
  imageFailure?: { failed: number; reason?: string },
): Record<string, unknown> {
  const systems = req.messages
    .filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => textOf(m.content))
    .filter(Boolean)
  const base = QWENWORK_SYSTEM_PROMPT
  const systemText = systems.length ? `${base}\n\n${systems.join('\n\n')}` : base

  const tools =
    req.tool_choice !== 'none'
      ? (req.tools ?? []).filter(t => t?.type === 'function' && t.function?.name)
      : []

  const budget = req.max_completion_tokens ?? req.max_tokens ?? 0
  const maxTokens = req.max_completion_tokens ?? req.max_tokens ?? 32000
  const { thinking, effort } = decideThinking(req.reasoning_effort, model, budget)

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
    request_set_id: taskId,
    chat_record_id: requestId,
    session_id: sessionId,
    parameters,
    business: {
      product: 'qoder_work',
      version: '1.1.59',
      type: 'agent',
      id: taskId,
      name: '',
      begin_at: Date.now(),
      stage: 'start',
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
        name: t.function!.name,
        description: t.function?.description ?? '',
        parameters: normaliseSchema(t.function?.parameters) ?? { type: 'object', properties: {} },
      },
    }))
  }

  if (req.tool_choice === 'required' && tools.length) {
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

/** 服务端对 schema 的 oneOf 挑剔：没有 type 的 oneOf 要走 `object`。 */
function normaliseSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  const o = schema as Record<string, unknown>
  if (Array.isArray(o.oneOf) && !o.type) return { ...o, type: 'object' }
  return o
}

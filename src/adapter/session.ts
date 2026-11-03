/**
 * 会话与任务的标识。
 *
 * 这两件事看着琐碎，但QwenWork 服务端靠它们做**会话隔离与提示词缓存**，
 * 弄错的表现是「越聊越慢」或者「模型记不住上下文」。
 *
 * ## 会话（session_id）
 *
 * 客户端是这么生成 UUID 形状的会话 id 的（magpie 的 `sessionOf`）：
 * 把「稳定的种子」做 sha256，再按 UUID 的格式切段。种子优先级：
 *
 *   1. DSH 明确给的会话名
 *   2. `prompt_cache_key`
 *   3. `user`
 *   4. 兜底：system 提示 + 第一条用户消息
 *
 * **不能**用「账号 uid」当会话 id——那样同一个账号下所有对话会撞成
 * 同一个会话，服务端的缓存全部串味。
 *
 * ## 任务（request_set_id / begin_at / stage）
 *
 * 客户端把「一次用户提问」称为一个 task（magpie 的 `taskOf`）：
 *
 *   - 同一个任务下所有模型调用（工具循环的每一轮）用**同一个**
 *     `request_set_id` 和 `begin_at`
 *   - 只有 `request_id` / `chat_record_id` 每次是新的
 *   - 某一轮被回答了，`stage` 从 `start` 变 `processing`
 *
 * 如果不这么做，一个有 265 次工具调用的任务在服务端看来就是 265 个任务。
 *
 * @module src/adapter/session.ts
 */

import { createHash, randomUUID } from 'node:crypto'

import { textOf, type HarnessMessage } from './body.ts'

/** 一个任务。 */
export interface Task {
  /** `request_set_id` / `business.id`。 */
  id: string
  /** `begin_at`：任务开始的时间，整个任务期间不变。 */
  begin: number
  /** 是否已有轮次被回答（决定 `stage`）。 */
  answered: boolean
  /** `business.name`：提示词的前十个字。 */
  name: string
  /** 最后一次使用时间，用于回收。 */
  used: number
}

/** 最多记多少个任务。 */
const TASK_MAX = 512
/** 任务最后一次使用后保留多久。 */
const TASK_IDLE = 2 * 60 * 60 * 1000

/** 任务表：key 是「会话 + 最后一条用户消息」的哈希。 */
const TASKS = new Map<string, Task>()

/**
 * 把任意字符串稳定地变成 UUID 形状的标识。
 *
 * 同一份输入永远得到同一个结果——这是会话 id 能跨进程重启后仍然稳定的前提。
 */
export function stableUUID(seed: string): string {
  const h = createHash('sha256').update(seed, 'utf8').digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * 算这次请求的会话 id。
 *
 * @param named  DSH 明确给的会话名（没有就传空串）
 * @param chat   本次请求的消息，用于兜底种子
 */
export function sessionOf(
  named: string,
  chat: { messages?: HarnessMessage[]; prompt_cache_key?: unknown; user?: unknown },
): string {
  const trimmedNamed = String(named ?? '').trim()

  let seed = ''
  if (trimmedNamed !== '') {
    seed = `session\0${trimmedNamed}`
  } else {
    const cacheKey = String(chat.prompt_cache_key ?? '').trim()
    const user = String(chat.user ?? '').trim()
    if (cacheKey !== '') seed = `key\0${cacheKey}`
    else if (user !== '') seed = `user\0${user}`
  }

  if (seed === '') {
    // 兜底：system 提示 + 第一条用户消息
    const messages = chat.messages ?? []
    const systems = messages
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => textOf(m.content))
    const firstUser = messages.find(m => m.role === 'user')
    seed = `chat\0${JSON.stringify([systems, firstUser?.content ?? ''])}`
  }

  return stableUUID(seed)
}

/** 任务名：提示词的前十个字（客户端的做法）。 */
function taskName(prompt: string): string {
  return prompt.length > 10 ? prompt.slice(0, 10) : prompt
}

/**
 * 找这次调用属于哪个任务。
 *
 * 判据是「会话 + 最后一条用户消息的位置与内容」——工具循环会一轮轮
 * 重复同一个提示，所以它们落到同一个任务上；用户提新问题就是新任务。
 */
export function taskOf(sessionId: string, chat: { messages?: HarnessMessage[] }, now = Date.now()): Task {
  const messages = chat.messages ?? []
  const at = messages.findLastIndex(m => m?.role === 'user')
  const prompt = at < 0 ? '' : textOf(messages[at]!.content)

  const key = createHash('sha256')
    .update(JSON.stringify([sessionId, at, at < 0 ? null : (messages[at]!.content ?? null)]))
    .digest('hex')

  // 回收：从头开始，超过空闲阈值就停（Map 保持插入序）
  for (const [k, t] of TASKS) {
    if (now - t.used <= TASK_IDLE) break
    TASKS.delete(k)
  }

  let task = TASKS.get(key)
  if (task !== undefined && now - task.used > TASK_IDLE) task = undefined
  TASKS.delete(key)

  if (task === undefined) {
    task = {
      id: randomUUID(),
      begin: now,
      answered: false,
      name: taskName(prompt),
      used: now,
    }
  } else {
    task.used = now
  }
  TASKS.set(key, task)

  while (TASKS.size > TASK_MAX) {
    const oldest = TASKS.keys().next().value
    if (oldest === undefined) break
    TASKS.delete(oldest)
  }

  return task
}

/** 标记某个任务已有轮次被回答（后续调用发 `processing`）。 */
export function markTaskAnswered(task: Task): void {
  task.answered = true
}

/** 清空任务表（测试用）。 */
export function __resetTasks(): void {
  TASKS.clear()
}

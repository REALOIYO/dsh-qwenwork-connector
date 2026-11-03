/**
 * QwenWork 的 body 编解码。
 *
 * 千问办公的 `agent_chat_generation` 带 `Encode=1`，请求体不是明文 JSON，
 * 而是一套自定义编码：先用打乱的 64 字符表做 base64 变体（`$` 补齐），
 * 再把字符串切成三等份、首尾互换。
 *
 * 移植自 `@magpie-community/opencode-qoder-auth@0.2.59`（MIT），
 * 原实现 `segmentEncode` / `swapThirds` / `encodeBody` / `decodeBody`。
 *
 * 这一层是纯函数，无 IO、无状态，可以完全靠往返测试验证。
 *
 * @module src/adapter/codec.ts
 */

/**
 * 打乱的 64 字符表。注意它包含 `$`（补位符）以外的全部 ASCII 特���字符，
 * 这不是标准 base64 —— 服务端就是这么认的，不能替换。
 */
const ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'

/** 补位符。出现在末组时忽略。 */
const PAD = '$'

/** 每 6 位映射一个字符的编码过程。 */
function segmentEncode(bytes: Uint8Array): string {
  let s = ''
  let acc = 0
  let nb = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff
    nb += 8
    while (nb >= 6) {
      nb -= 6
      s += ALPHABET[(acc >> nb) & 63]
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63]
  while (s.length % 4) s += PAD
  return s
}

/**
 * 三段轮换：把字符串切成三等份，首尾交换。
 *
 * 长度不足 3 时原样返回（此时 t = 0）。
 */
function swapThirds(s: string): string {
  const t = Math.floor(s.length / 3)
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s
}

/** 明文 → wire 形式的 body。 */
export function encodeBody(text: string): string {
  return swapThirds(segmentEncode(new TextEncoder().encode(text)))
}

/**
 * wire 形式的 body → 明文。
 *
 * 与 encodeBody 严格互逆：先还原三段，再按 4 字符一组还原字节。
 */
export function decodeBody(wire: string): string {
  const s = swapThirds(wire)
  const out: number[] = []
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter(c => c !== PAD).map(c => ALPHABET.indexOf(c))
    // 出现表外字符说明不是这套编码，直接抛错而不是静默产出脏字节
    if (vals.some(v => v < 0)) throw new Error('qwenwork: body 含未知字符，不是 QwenWork 的编码')
    let x = 0
    for (const v of vals) x = x * 64 + v
    const n = Math.floor((6 * vals.length) / 8)
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255)
  }
  return new TextDecoder().decode(new Uint8Array(out))
}

/** 一段 SSE 是否需要解码：`Encode=1` 的响应体也是编码过的。 */
export function looksEncoded(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  // 明文 JSON 一定以 { 或 [ 开头；编码后不可能出现在字母表之外
  if (t.startsWith('{') || t.startsWith('[')) return false
  return [...t].every(c => c === PAD || ALPHABET.includes(c))
}

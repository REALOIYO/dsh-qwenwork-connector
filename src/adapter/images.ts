/**
 * DSH 的图片块 → QwenWork 能吃的 data URL。
 *
 * 关键事实：DSH 里的图片**不是 base64，也不是 URL**，而是一个附件引用：
 *
 *   { type: 'image', attachment: { attachmentId, mediaType, bytes, width, height } }
 *
 * 真正的内容在宿主的附件服务里，要调
 *   ctx.get('attachments').readImageRequest(ref, target, signal)
 * 才能拿到字节。不接这一步，图片会被静默丢弃——用户发了图，模型只看到
 * 一句「[图片]」，还不知道自己漏了什么。
 *
 * 实现严格对照 `dsh-magpie-connect` 的 `messages.ts`（MIT），三处照抄不
 * 自作主张：
 *
 *  1. **尺寸策略**：按像素总数等比缩放（`sqrt(MAX_PIXELS/pixels)`），
 *     不是把边长截到某个数——后者会把超长图压扁或拉伸。
 *  2. **上限**：2048×2048 像素、1MB 字节。
 *  3. **图片前先放一条文本**（`Image xxx; request preview WxHpx.`）。
 *     模型靠这行知道图有多大、叫什么，缺了它对图的方位判断会差。
 *
 * @module src/adapter/images.ts
 */

/** 一个图片附件引用（DSH 的形状）。 */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** 宿主附件服务的最小面。 */
export interface AttachmentStore {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: { width: number; height: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: string; bytes: number; width: number; height: number }>
}

/** 读出来的一张图。 */
export interface ResolvedImage {
  /** base64（不含 data: 前缀）。 */
  base64: string
  /** 可直接拼 data URL 的完整串。 */
  dataUrl: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** 请求上行图片的像素上限：2048×2048（与 magpie 一致）。 */
const REQUEST_MAX_PIXELS = 2048 * 2048
/** 请求上行图片的字节上限：1MB（与 magpie 一致）。 */
const REQUEST_MAX_BYTES = 1024 * 1024

/**
 * 算这次该让宿主把图缩到多大。
 *
 * 图本身没超上限就原样（`width`/`height` 传原值，宿主自己判断）；
 * 超了按**像素总数**等比缩放，保持长宽比。
 */
export function requestImageTarget(ref: ImageAttachmentRef): {
  width: number
  height: number
  maxBytes: number
} {
  const pixels = ref.width * ref.height
  if (!(pixels > REQUEST_MAX_PIXELS) || !(ref.width > 0 && ref.height > 0)) {
    return { width: ref.width, height: ref.height, maxBytes: REQUEST_MAX_BYTES }
  }
  const scale = Math.sqrt(REQUEST_MAX_PIXELS / pixels)
  return {
    width: Math.max(1, Math.floor(ref.width * scale)),
    height: Math.max(1, Math.floor(ref.height * scale)),
    maxBytes: REQUEST_MAX_BYTES,
  }
}

/**
 * 图片前那句说明，照 magpie 的 `imageHandleText`。
 *
 * 模型靠它知道这张图叫什么、被缩到了多大。没有这行，模型对图的
 * 尺度感知会没了依据。
 */
export function imageHandleText(ref: ImageAttachmentRef, image: { width: number; height: number }): string {
  const name = ref.name ?? `attachment ${String(ref.attachmentId).slice(0, 12)}`
  return `Image ${name}; request preview ${image.width}x${image.height}px.`
}

/** 图被宿主标为 offloaded（内容已移出）时的说明。 */
export function offloadedImageText(ref: ImageAttachmentRef): string {
  const name = ref.name ?? `attachment ${String(ref.attachmentId).slice(0, 12)}`
  return `[image omitted (offloaded); ${name}]`
}

/**
 * 从一条消息里摘出所有图片块。
 *
 * 兼容两种形状：真正的 DSH 形状（`attachment` 引用），以及已经
 * 转好的 `image_url`（有些调用方会预处理），后者直接透传。
 */
export function collectImageRefs(content: unknown): {
  refs: ImageAttachmentRef[]
  inlineUrls: string[]
  offloaded: ImageAttachmentRef[]
} {
  const refs: ImageAttachmentRef[] = []
  const inlineUrls: string[] = []
  const offloaded: ImageAttachmentRef[] = []
  if (!Array.isArray(content)) return { refs, inlineUrls, offloaded }

  for (const block of content) {
    const b = block as {
      type?: string
      attachment?: Partial<ImageAttachmentRef>
      offloaded?: boolean
      image_url?: unknown
    }
    if (b?.type === 'image' && b.attachment !== undefined) {
      const a = b.attachment
      if (typeof a.attachmentId === 'string' && a.attachmentId !== '') {
        const ref: ImageAttachmentRef = {
          attachmentId: a.attachmentId,
          mediaType: typeof a.mediaType === 'string' ? a.mediaType : 'image/png',
          bytes: typeof a.bytes === 'number' ? a.bytes : 0,
          width: typeof a.width === 'number' ? a.width : 0,
          height: typeof a.height === 'number' ? a.height : 0,
          ...(typeof a.name === 'string' ? { name: a.name } : {}),
        }
        // offloaded 的图内容已不在，只能留一句说明
        if (b.offloaded === true) offloaded.push(ref)
        else refs.push(ref)
      }
    } else if (b?.type === 'image_url') {
      const url = typeof b.image_url === 'string' ? b.image_url : (b.image_url as { url?: string })?.url
      if (typeof url === 'string' && url !== '') inlineUrls.push(url)
    }
  }
  return { refs, inlineUrls, offloaded }
}

/**
 * 把附件引用读成 base64。
 *
 * 读失败不抛错——图片是增强，不是必需。失败的图会在文本里留一句
 * 说明，免得用户以为发了图而模型什么都没看到。
 */
export async function resolveImages(
  refs: readonly ImageAttachmentRef[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<{ images: Map<string, ResolvedImage>; failed: number; reason?: string }> {
  const images = new Map<string, ResolvedImage>()
  if (refs.length === 0) return { images, failed: 0 }
  if (attachments === undefined || typeof attachments.readImageRequest !== 'function') {
    return {
      images,
      failed: refs.length,
      reason: '宿主附件服务不可用，图片无法读取',
    }
  }

  let failed = 0
  let reason: string | undefined

  // 并发读：magpie 也是 Promise.all，一张张大图串行会明显变慢
  await Promise.all(
    refs.map(async ref => {
      try {
        const read = await attachments.readImageRequest(ref, requestImageTarget(ref), signal)
        if (read.bytes <= 0 || read.data.length === 0) {
          failed += 1
          return
        }
        const mediaType = read.mediaType !== '' ? read.mediaType : ref.mediaType
        const base64 = Buffer.from(read.data.buffer, read.data.byteOffset, read.data.byteLength).toString('base64')
        images.set(ref.attachmentId, {
          base64,
          dataUrl: `data:${mediaType};base64,${base64}`,
          mediaType,
          bytes: read.bytes,
          width: read.width,
          height: read.height,
        })
      } catch (error) {
        failed += 1
        if (reason === undefined) reason = error instanceof Error ? error.message : String(error)
      }
    }),
  )

  return { images, failed, ...(reason !== undefined ? { reason } : {}) }
}

/**
 * 给用户/模型的兜底说明。
 *
 * 图读不出来时不能静默——不然「我明明发了图」和「模型说没看到图」
 * 会变成一次无谓的排查。
 */
export function imageFailureNote(failed: number, reason?: string): string {
  if (failed <= 0) return ''
  const what = failed === 1 ? '1 张图片' : `${failed} 张图片`
  const why = reason !== undefined && reason !== '' ? `（${reason}）` : ''
  return `[${what}未能读取${why}，这条消息里没有图片内容]`
}

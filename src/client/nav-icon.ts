/**
 * 设置侧边栏那一行的千问图标。
 *
 * 为什么要这么干：`settings.section` 这个 slot 只投影 `id`/`order`/`label`，
 * 宿主给导航行画图标用的是按 id 硬编码的映射表，插件注册的 id 不在表里，
 * 于是落到兜底的齿轮。
 *
 * 做法与 `dsh-magpie-connect` 相同（也是 dshmarket / dsh-better-sidebar 用的）：
 * 等对话框挂载后，按**可见文字**找到属于本插件的那一行，打上标记，
 * 再用 CSS 把宿主的齿轮盖掉、画上自己的图标。
 *
 * 约束刻意收窄：
 *  - 只标记文字与本插件当前语言下的 label 完全相同的那一行
 *  - 标记与样式都挂在 `ctx.effect` 里，fiber 销毁时一起摘掉
 *  - 切语言后靠 MutationObserver 重新认领，避免文字和图标对不上
 *
 * 宿主哪天给这个 slot 加上 `icon` 字段，就该删掉这个模块。
 *
 * @module src/client/nav-icon.ts
 */

/** 标记本插件那一行的属性名。 */
const NAV_ICON_MARKER = 'data-dsh-qwenwork-nav-icon'

/**
 * 设置对话框的导航行。宿主把每个 `settings.section` 渲染成
 * `<nav>` 里的一个 `<button>`。
 */
const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

/**
 * 千问的六边形标（24×24 viewBox），路径抄自 magpie 仓库的
 * `internal/gui/assets/icons/qwen-color.svg`。
 *
 * 这里用单色 mask 而不是原图的紫色渐变：mask 只读 alpha，颜色由
 * `background-color: currentColor` 给，于是图标会跟随导航行自己的
 * 常态/悬停/选中颜色，和旁边几个入口一致。
 */
const QWEN_PATH =
  'M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z'

/** 把路径包成可当 CSS mask 用的 SVG。 */
function qwenMaskSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#000"><path fill-rule="nonzero" d="${QWEN_PATH}"/></svg>`
}

/** mask 的 data URL（运行时编码，不手拼转义）。 */
function qwenMaskUrl(svg = qwenMaskSvg()): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * 这一行是不是本插件的。
 *
 * 纯函数，也是这个模块唯一的判断：可见文字与当前 label 完全相同才算。
 * label 为空时一律不认——语言还没解析出来时不能把整个导航都标了。
 *
 * @param rowText    该行的可见文字
 * @param wantedLabel 本插件当前的 section 文字
 */
export function isOwnNavRow(rowText: unknown, wantedLabel: unknown): boolean {
  const wanted = String(wantedLabel ?? '').trim()
  if (wanted.length === 0) return false
  return String(rowText ?? '').trim() === wanted
}

/** 标记行的样式：藏掉宿主齿轮，画上自己的图标。 */
function navIconCss(maskUrl: string): string {
  return [
    `[${NAV_ICON_MARKER}] > svg { display: none; }`,
    `[${NAV_ICON_MARKER}]::before {`,
    `  content: '';`,
    `  flex: none;`,
    `  width: 18px;`,
    `  height: 18px;`,
    `  background-color: currentColor;`,
    `  -webkit-mask-image: url("${maskUrl}");`,
    `  mask-image: url("${maskUrl}");`,
    `  -webkit-mask-repeat: no-repeat;`,
    `  mask-repeat: no-repeat;`,
    `  -webkit-mask-position: center;`,
    `  mask-position: center;`,
    `  -webkit-mask-size: 18px 18px;`,
    `  mask-size: 18px 18px;`,
    `}`,
  ].join('\n')
}

/** 这个模块需要的最小客户端上下文。 */
export interface NavIconContext {
  effect(fn: () => () => void, label?: string): unknown
}

/**
 * 装上导航图标。
 *
 * @param ctx          客户端上下文，用于绑定生命周期
 * @param resolveLabel 本插件当前的 section 文字（与注册时同一个来源），
 *                     每次同步都重新读，切语言才能跟上
 */
export function installSettingsNavIcon(ctx: NavIconContext, resolveLabel: () => string): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-qwenwork-connect'
    tag.dataset.pluginCss = 'dsh-qwenwork-connect/settings-nav-icon'
    tag.textContent = navIconCss(qwenMaskUrl())
    document.head.appendChild(tag)

    let disposed = false
    let scheduled = false

    const sync = (): void => {
      scheduled = false
      if (disposed) return
      const wanted = resolveLabel()
      for (const row of Array.from(document.querySelectorAll(NAV_ROW_SELECTOR))) {
        if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, '')
        else row.removeAttribute(NAV_ICON_MARKER)
      }
    }

    const schedule = (): void => {
      if (scheduled || disposed) return
      scheduled = true
      queueMicrotask(sync)
    }

    sync()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    return () => {
      disposed = true
      observer.disconnect()
      for (const row of Array.from(document.querySelectorAll(`[${NAV_ICON_MARKER}]`))) {
        row.removeAttribute(NAV_ICON_MARKER)
      }
      tag.remove()
    }
  }, 'dsh-qwenwork-connect: settings nav icon')
}

/**
 * 构建：把 src/ 的 TypeScript 用 esbuild 打成单文件 lib/index.js。
 *
 * 为什么不引入 tsc 产物链：这个插件刻意不 import 宿主的任何
 * `@deepseek-ai/*` 包（只做结构化类型对接），所以没有需要解析的类型依赖，
 * 也不需要 .d.ts 分发。esbuild 一步到位，产物可以直接被 DSH 加载。
 *
 * 依赖 esbuild 由调用方提供（沙箱里可用 npx 临时装），不写进 dependencies，
 * 保持插件运行时零依赖。
 */

// esbuild 是构建期依赖，不写进 package.json（保持插件运行时零依赖）。
// 允许用 QWENWORK_ESBUILD 指定已安装的 esbuild 目录，供沙箱/CI 复用。
const esbuildSpecifier = process.env.QWENWORK_ESBUILD
  ? pathToFileURL(join(process.env.QWENWORK_ESBUILD, 'lib/main.js')).href
  : 'esbuild'
const { build } = await import(esbuildSpecifier)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

mkdirSync(join(here, 'lib'), { recursive: true })

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(here, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // 宿主提供的包保持外部引用：运行时由 DSH 的模块解析提供
  external: ['@deepseek-ai/*'],
  sourcemap: true,
  logLevel: 'info',
})

// package.json 里的 version 是唯一真相，同步进 dsh.plugin.json
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const manifestPath = join(here, 'dsh.plugin.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`dsh.plugin.json: version synced to ${pkg.version}`)
}

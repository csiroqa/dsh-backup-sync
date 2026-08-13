/**
 * backup-sync 独立构建脚本（单插件版）。
 *
 * 产物约定与 harness 外部插件一致：
 *   - lib/index.js   host 半区（Node ESM；@deepseek-ai/* 保持 external）
 *   - lib/client.js  browser 半区（CJS + __ModuleLoader__.load 包装；平台模块 external）
 *
 * 用法：node scripts/build.mjs [--watch]
 */
import { build, context } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { readFile } = await import('node:fs/promises')
const pkgPath = join(ROOT, 'package.json')
const pkgJson = JSON.parse(await readFile(pkgPath, 'utf8'))
const id = pkgJson.name

/** 浏览器模块表（platform seed + 文档化的 runtime 例外），必须保持 external。 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const configs = []

configs.push({
  entryPoints: [join(ROOT, 'src', 'index.ts')],
  outfile: join(ROOT, 'lib', 'index.js'),
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  bundle: true,
  sourcemap: true,
  external: ['@deepseek-ai/*'],
})

configs.push({
  entryPoints: [join(ROOT, 'src', 'client', 'index.ts')],
  outfile: join(ROOT, 'lib', 'client.js'),
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  bundle: true,
  sourcemap: true,
  external: CLIENT_EXTERNALS,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

const watch = process.argv.includes('--watch')
const pending = []
for (const config of configs) {
  if (watch) {
    pending.push(await context(config).then((ctx) => ctx.watch()))
  } else {
    await build(config)
    console.log(`[${id}] ${config.outfile} built`)
  }
}

if (watch) {
  console.log('watching... (Ctrl+C to stop)')
  process.on('SIGINT', async () => { await Promise.all(pending.map((ctx) => ctx.dispose())) })
  process.on('SIGTERM', async () => { await Promise.all(pending.map((ctx) => ctx.dispose())) })
} else if (pending.length > 0) {
  await Promise.all(pending.map((ctx) => ctx.dispose()))
}

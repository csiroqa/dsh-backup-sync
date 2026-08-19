import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

/** 从 package.json 读取包名（browser 半区模块注册 id，避免硬编码漂移）。 */
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as { name: string }

/**
 * 构建配置：`fixedExtension: false`、`dts: false`、`clean: false`。
 * 依赖 external 遵循 tsdown 默认（按 package.json 的 dependencies 排除），但——
 * 本插件的 @deepseek-ai/* 共享宿主包不在 dependencies（它们在 peerDependencies，
 * 运行时由 DSH 宿主注入，见 package.json）。为保证绝不内联进产物，host 半区
 * 显式声明为 neverBundle（与 browser 半区同理）。这与"宿主注入"语义一致：
 *   - lib/index.js   host 半区（Node ESM；@deepseek-ai/* 显式 external，宿主注入）
 *   - lib/client.js  browser 半区（CJS + window.__ModuleLoader__.load 包装；平台模块
 *                     亦在 CLIENT_EXTERNALS，全部 external，其余内联）
 */

/** Host 半区：由 DSH 宿主注入的共享宿主包（= peerDependencies），必须保持 external，禁止内联。 */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-workspace',
]

/** 浏览器平台模块表（platform seed + 文档化的 runtime 例外），必须保持 external。 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: HOST_EXTERNALS },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    deps: { neverBundle: CLIENT_EXTERNALS },
    dts: false,
    clean: false,
    // harness 约定 browser 半区产物为 client.js（CJS 包装），fixedExtension: false 会输出 .cjs，需覆盖。
    outExtensions: () => ({ js: '.js' }),
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: {
      js: 'return module.exports; } });',
    },
  },
])

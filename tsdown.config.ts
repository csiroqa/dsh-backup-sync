import { defineConfig } from 'tsdown'

/**
 * 构建配置：工具链对齐 harness 内置插件（如 @deepseek-ai/dsh-schedule）：
 * `fixedExtension: false`、`dts: false`、`clean: false`，依赖 external 遵循
 * tsdown 默认（按 package.json 的 dependencies 排除）。
 *   - lib/index.js   host 半区（Node ESM；@deepseek-ai/* 已在 dependencies，自动保持 external）
 *   - lib/client.js  browser 半区（CJS + window.__ModuleLoader__.load 包装；平台模块
 *                     不在 dependencies，需显式 external，其余全部内联）
 */

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
      js: 'window.__ModuleLoader__.load({ id: "@dsh-plugin/backup-sync", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: 'return module.exports; } });',
    },
  },
])

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

/**
 * I7 代码质量守护：静态检查门（已纳入 `pnpm verify`）。
 * 规则取向：推荐集 + 少数项目性放宽（no-console 放开——演示网关/引擎
 * 生命周期日志是既定实践；TS 内 no-undef 关闭——类型系统已覆盖）。
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'tooling/visual-regression/golden/**',
      'tooling/visual-regression/current/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, sourceType: 'module' }
    }
  },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      'no-undef': 'off', // TS 已覆盖未定义标识符检查
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/attributes-order': 'off'
    }
  }
)

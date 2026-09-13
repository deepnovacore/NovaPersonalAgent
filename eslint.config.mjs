import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'thirdparty/**',
      '.worktrees/**',
      'clients/desktop/build/**',
    ],
  },
  {
    files: ['runtime/**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // Outside the executor registry, depend on the Codex package's public entry only.
    files: ['runtime/src/**/*.ts'],
    ignores: ['runtime/src/executors/**', 'runtime/src/production-composition.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/executors\\/codex\\//]',
        message: 'load Codex through the executor registry; host authority belongs to production-composition.ts',
      }],
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/executors/codex/**'],
          message: 'import Codex through executors/index.js instead of package internals',
        }],
      }],
    },
  },
  {
    files: ['runtime/src/production-composition.ts'],
    rules: {
      'no-restricted-imports': ['error', {patterns: [{
        group: ['**/executors/codex/**', '!./executors/codex/host.js'],
        message: 'the composition may load only the dedicated Codex host entry',
      }]}],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/executors\\/codex\\//][source.value!="./executors/codex/host.js"]',
        message: 'the composition may load only the dedicated Codex host entry',
      }],
    },
  },
  {
    // Spec 07 R3: executor packages never reach into the conversation layer.
    files: ['runtime/src/executors/*/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/realtime/**', '**/desktop*', '**/*-assembly*'],
          message: 'executor packages must not import realtime/, desktop*, or assemblies; depend on ports.ts',
        }],
      }],
    },
  },
  {
    files: ['runtime/{eval,test}/**/*.ts'],
    rules: {
      // node:test owns the returned registration promise.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
)

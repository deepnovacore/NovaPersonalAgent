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
    // Spec 07 R1: concrete packages belong behind the registry; coding/ is a shared role coordinator.
    files: ['runtime/src/**/*.ts'],
    ignores: ['runtime/src/executors/**', 'runtime/src/composition/production-composition.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/executors\\/.+\\//]:not([source.value=/executors\\/coding\\//])',
        message: 'load concrete executor packages through the registry; host authority belongs to production-composition.ts',
      }],
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/executors/*/**', '!**/executors/coding/**'],
          message: 'import concrete executors through executors/index.js instead of package internals',
        }],
      }],
    },
  },
  {
    files: ['runtime/src/composition/production-composition.ts'],
    rules: {
      'no-restricted-imports': ['error', {patterns: [{
        group: ['**/executors/*/**', '!**/executors/coding/**', '!../executors/codex/host.js'],
        message: 'the composition may load only the dedicated Codex host entry',
      }]}],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/executors\\/.+\\//]:not([source.value=/executors\\/coding\\//])[source.value!="../executors/codex/host.js"]',
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
          group: ['**/realtime/**', '**/desktop*', '**/desktop/**', '**/composition/**', '**/*-assembly*'],
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

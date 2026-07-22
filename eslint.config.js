import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
        WeakRef: 'readonly',
        FinalizationRegistry: 'readonly',
        navigator: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        DOMException: 'readonly',
        ReadableStream: 'readonly',
        performance: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Control-character regexes are intentional in input sanitization.
      'no-control-regex': 'off',
      // Re-assignment after initial value is a common defensive pattern.
      'no-useless-assignment': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Throwing a new error inside catch is intentional when the new error
      // describes a different failure (e.g. fallback logging failure).
      'preserve-caught-error': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'data/', 'dist/'],
  },
];

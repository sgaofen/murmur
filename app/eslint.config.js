import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist/**', 'src-tauri/target/**', 'src-tauri/etcli/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The app is not using React Compiler. eslint-plugin-react-hooks v7 enables
      // Compiler-specific rules by default; they flag ordinary fetch-in-effect
      // page code as build-breaking errors without improving runtime safety here.
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-refresh/only-export-components': 'off',
      // Backend API payloads are dynamic JSON from Python. Keep runtime checks at
      // the call sites instead of forcing broad DTO typing during this cleanup.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])

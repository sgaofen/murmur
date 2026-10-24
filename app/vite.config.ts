import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// package.json is the version the release scripts bump; 设置 → 关于 shows it.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __MURMUR_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    watch: {
      ignored: ['**/src-tauri/target/**', '**/src-tauri/etcli/**'],
    },
  },
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled serif (all weights, unicode-range slices) — no network font requests.
import '@fontsource-variable/noto-serif-sc/wght.css'
import './index.css'
import './ui/ui.css'
import App from './App.tsx'
import { initTheme, ThemeProvider } from './ui/theme'
import { AppLockGate } from './components/AppLockGate'

// Apply the saved theme before the first paint so dark mode doesn't flash light.
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {/* Outside <App> on purpose: while locked, App and its boot effects
          (profile sync, onboarding probe) must not mount at all. */}
      <AppLockGate>
        <App />
      </AppLockGate>
    </ThemeProvider>
  </StrictMode>,
)

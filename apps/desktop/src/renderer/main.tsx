import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import styles from './app.module.css'
import { App } from './app.tsx'
import { Wordmark } from './frame/wordmark.tsx'

const LEGACY_CONFIG_NAMES = new Set([
  'settings.json',
  'models.json',
  'mcp.json',
])

function HostError() {
  const legacyFiles = (
    new URLSearchParams(location.search).get('legacyFiles') ?? ''
  )
    .split(',')
    .map((name) => name.trim())
    .filter((name) => LEGACY_CONFIG_NAMES.has(name))
  return (
    <main className={styles.hostError}>
      <Wordmark heading />
      <p role="alert">
        {legacyFiles.length > 0
          ? `Vela could not start: found legacy configuration (${legacyFiles.join(', ')}) without config.json. Migrate to unified config.json and restart.`
          : 'Vela could not start. Check your settings and restart.'}
      </p>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing renderer root')
createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('hostError') ? (
      <HostError />
    ) : (
      <App />
    )}
  </StrictMode>,
)

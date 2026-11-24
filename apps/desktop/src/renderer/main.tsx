import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import styles from './app.module.css'
import { App } from './app.tsx'
import { Wordmark } from './frame/wordmark.tsx'

function HostError() {
  return (
    <main className={styles.hostError}>
      <Wordmark heading />
      <p role="alert">Vela could not start. Check your settings and restart.</p>
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

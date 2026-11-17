import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import icon from '../assets/vela-icon-180.png'
import '../styles/base.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing renderer root')

createRoot(root).render(
  <StrictMode>
    <main className="shell" aria-label="Vela desktop">
      <div className="brand">
        <img src={icon} width="72" height="72" alt="" />
        <h1 className="wordmark">VELA</h1>
      </div>
    </main>
  </StrictMode>,
)

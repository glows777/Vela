import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import tokens from '../../design/tokens.json'
import { Button } from './ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from './ui/dialog.tsx'
import { Switch } from './ui/switch.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.tsx'
import '../styles/base.css'
import '../styles/specimen.css'

const themeChoices = ['system', ...tokens.themes]

function Specimen() {
  const [theme, setTheme] = useState('system')
  const [pressed, setPressed] = useState(false)
  return (
    <main className="specimen">
      <header className="specimen-header">
        <div>
          <p className="eyebrow">VELA FOUNDATION</p>
          <h1>Vela design foundation</h1>
        </div>
        <fieldset>
          <legend>Theme</legend>
          <div className="themes">
            {themeChoices.map((choice) => (
              <Button
                size="sm"
                variant={theme === choice ? 'primary' : 'secondary'}
                key={choice}
                aria-pressed={theme === choice}
                onClick={() => {
                  setTheme(choice)
                  if (choice === 'system')
                    delete document.documentElement.dataset.theme
                  else document.documentElement.dataset.theme = choice
                }}
              >
                {choice.replace('-', ' ')}
              </Button>
            ))}
          </div>
        </fieldset>
      </header>
      <p className="specimen-intro">
        Vela brand, native controls and motion. Development samples keep no
        product data.
      </p>
      <section aria-labelledby="type-heading" className="type-specimen">
        <div>
          <p className="eyebrow">01 / TYPE</p>
          <h2 id="type-heading">Typography</h2>
          <p>A clear thought deserves a little space.</p>
          <p className="muted" lang="zh">
            留一点空间，让想法清晰。
          </p>
          <p className="muted" lang="ja">
            考えるための、余白。
          </p>
          <code>Barlow Condensed / Arial / native CJK</code>
        </div>
        <div className="seal" lang="ja" aria-hidden="true">
          試作
        </div>
      </section>
      <section aria-labelledby="controls-heading">
        <p className="eyebrow">02 / CONTROLS</p>
        <h2 id="controls-heading">Button and dialog</h2>
        <div className="control-row">
          <Button
            id="sample-button"
            aria-pressed={pressed}
            onClick={() => setPressed(!pressed)}
          >
            {pressed ? 'Selected' : 'Select sample'}
          </Button>
          <Button variant="secondary" disabled>
            Disabled sample
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">Open sample dialog</Button>
            </DialogTrigger>
            <DialogContent
              title="Sample dialog"
              description="A development sample with Vela motion and keyboard focus."
            >
              <p>The dialog inherits the document theme through its portal.</p>
              <DialogClose asChild>
                <Button>Done</Button>
              </DialogClose>
            </DialogContent>
          </Dialog>
        </div>
        <p className="muted">
          Use Tab, Enter, and Escape to inspect focus and dismissal.
        </p>
      </section>
      <section aria-labelledby="tabs-heading">
        <p className="eyebrow">03 / NAVIGATION</p>
        <h2 id="tabs-heading">Tabs and switch</h2>
        <Tabs defaultValue="overview">
          <TabsList aria-label="Sample panels">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            Vela segmented tabs switch panels directly.
          </TabsContent>
          <TabsContent value="preferences">
            <Switch label="Sample preference" defaultChecked />
          </TabsContent>
        </Tabs>
      </section>
      <section aria-labelledby="palette-heading">
        <p className="eyebrow">04 / COLOUR</p>
        <h2 id="palette-heading">Vela palette</h2>
        <div className="swatches">
          {[
            'white',
            'paper',
            'ink',
            'teal',
            'mint',
            'accent',
            'muted',
            'border-strong',
          ].map((name) => (
            <div className="swatch" key={name}>
              <div style={{ background: `var(--vela-${name})` }} />
              <code>vela-{name}</code>
            </div>
          ))}
        </div>
      </section>
      <footer>
        <span>
          {tokens.themes.length} themes · local assets · native Vela controls
        </span>
        <span>Development only</span>
      </footer>
    </main>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing specimen root')
createRoot(root).render(
  <StrictMode>
    <Specimen />
  </StrictMode>,
)

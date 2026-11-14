import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import tokens from '../design/tokens.json'

type Frame = {
  elapsed: number
  transform: string
  opacity: string
  width: string
}
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`
const identity = (value: string) =>
  value === 'none' || value === 'matrix(1, 0, 0, 1, 0, 0)'
const frames = (page: Page, selector: string) =>
  page.evaluate(async (query) => {
    const samples: Frame[] = []
    const start = performance.now()
    while (performance.now() - start < 650) {
      const node = document.querySelector(query)
      if (node) {
        const style = getComputedStyle(node)
        samples.push({
          elapsed: performance.now() - start,
          transform: style.transform,
          opacity: style.opacity,
          width: style.width,
        })
      }
      await new Promise(requestAnimationFrame)
    }
    return samples
  }, selector)

async function portalColors(page: Page, theme: string) {
  const dialog = page.getByRole('dialog', {
    name: 'Sample dialog',
    exact: true,
  })
  await page
    .getByRole('button', { name: 'Open sample dialog', exact: true })
    .click()
  await dialog.waitFor()
  assert.equal(
    await dialog.evaluate((element) => element.closest('#root') === null),
    true,
    'Dialog uses a body portal',
  )
  const expected =
    tokens.tokens['vela-ink'][theme as keyof (typeof tokens.tokens)['vela-ink']]
  assert(expected)
  assert.equal(
    await dialog.evaluate((element) => getComputedStyle(element).color),
    rgb(expected),
    'Dialog renders the themed foreground',
  )
  assert.equal(
    await dialog.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--foreground').trim(),
    ),
    expected,
  )
  assert.equal(
    await dialog.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--surface-raised').trim(),
    ),
    tokens.tokens['vela-paper'][
      theme as keyof (typeof tokens.tokens)['vela-paper']
    ],
  )
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
}

async function controlShadows(page: Page) {
  const button = page.locator('#sample-button')
  await button.hover()
  await page.waitForTimeout(250)
  const buttonShadow = await button.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  )
  await page.getByRole('tab', { name: 'Preferences', exact: true }).click()
  const switchShadow = await page
    .locator('[role="switch"] > span > span')
    .evaluate((element) => getComputedStyle(element).boxShadow)
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await page
    .getByRole('button', { name: 'Open sample dialog', exact: true })
    .click()
  const dialog = page.getByRole('dialog', {
    name: 'Sample dialog',
    exact: true,
  })
  await dialog.waitFor()
  const dialogShadow = await dialog.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  )
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  return { button: buttonShadow, switch: switchShadow, dialog: dialogShadow }
}

export async function verifyControls(page: Page, evidence: string) {
  const checks: string[] = []
  await page.getByRole('heading', { name: 'Vela design foundation' }).waitFor()
  for (const theme of tokens.themes) {
    await page
      .getByRole('button', { name: theme.replace('-', ' '), exact: true })
      .click()
    await page.waitForTimeout(250)
    const selection = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement, '::selection')
      return { color: style.color, background: style.backgroundColor }
    })
    assert.equal(
      selection.color,
      rgb(
        tokens.tokens['vela-on-mint'][
          theme as keyof (typeof tokens.tokens)['vela-on-mint']
        ],
      ),
    )
    assert.equal(
      selection.background,
      rgb(
        tokens.tokens['vela-mint'][
          theme as keyof (typeof tokens.tokens)['vela-mint']
        ],
      ),
    )
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--vela-ink')
          .trim(),
      ),
      tokens.tokens['vela-ink'][
        theme as keyof (typeof tokens.tokens)['vela-ink']
      ],
    )
    await page.screenshot({
      path: resolve(evidence, `specimen-${theme}.png`),
      fullPage: true,
    })
    await portalColors(page, theme)
  }
  checks.push(
    'Explicit light, dark, and high-contrast theme colors reach body-portaled Arc dialogs.',
  )
  await page.getByRole('button', { name: 'system', exact: true }).click()
  for (const media of [
    { colorScheme: 'dark', contrast: 'no-preference', theme: 'dark' },
    { colorScheme: 'light', contrast: 'more', theme: 'high-contrast' },
    { colorScheme: 'light', contrast: 'no-preference', theme: 'light' },
  ] as const) {
    await page.emulateMedia({
      colorScheme: media.colorScheme,
      contrast: media.contrast,
    })
    await portalColors(page, media.theme)
  }
  checks.push(
    'System light, dark, and high contrast reach Arc portal semantic colors.',
  )
  const shadows: Record<string, Awaited<ReturnType<typeof controlShadows>>> = {}
  for (const media of [
    {
      colorScheme: 'dark',
      contrast: 'no-preference',
      forcedColors: 'none',
      theme: 'dark',
    },
    {
      colorScheme: 'dark',
      contrast: 'more',
      forcedColors: 'none',
      theme: 'high-contrast',
    },
    {
      colorScheme: 'dark',
      contrast: 'no-preference',
      forcedColors: 'active',
      theme: 'high-contrast',
    },
  ] as const) {
    await page.emulateMedia(media)
    await page
      .getByRole('button', { name: media.theme.replace('-', ' '), exact: true })
      .click()
    const explicit = await controlShadows(page)
    await page.getByRole('button', { name: 'system', exact: true }).click()
    const system = await controlShadows(page)
    const key = `${media.theme}-${media.contrast}-${media.forcedColors}`
    shadows[`${key}-explicit`] = explicit
    shadows[`${key}-system`] = system
    await Bun.write(
      resolve(evidence, 'theme-shadows.json'),
      JSON.stringify(shadows, null, 2),
    )
    assert.deepEqual(
      system,
      explicit,
      `${key} uses the explicit theme's consumed Arc shadows`,
    )
    if (media.forcedColors === 'none') {
      assert(
        Object.values(system).every((shadow) => shadow !== 'none'),
        'Arc consumers render their shadows',
      )
    } else {
      assert(
        Object.values(system).every((shadow) => shadow === 'none'),
        'Forced colors suppresses control shadows',
      )
    }
    const root = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        colorScheme: style.colorScheme,
        ink: style.getPropertyValue('--vela-ink').trim(),
      }
    })
    if (media.forcedColors === 'none')
      assert.equal(root.colorScheme, media.theme === 'dark' ? 'dark' : 'light')
    assert.equal(root.ink, tokens.tokens['vela-ink'][media.theme])
  }
  checks.push(
    'System dark matches explicit dark Button, Switch, and Dialog shadows; high contrast and forced colors take precedence over OS dark.',
  )
  await page.emulateMedia({ forcedColors: 'none' })
  const motion: Record<string, Record<string, Frame[]>> = {}
  for (const reduced of [false, true]) {
    await page.emulateMedia({
      colorScheme: 'light',
      contrast: 'no-preference',
      reducedMotion: reduced ? 'reduce' : 'no-preference',
    })
    await page.reload()
    await page
      .getByRole('heading', { name: 'Vela design foundation' })
      .waitFor()
    const button = page.getByRole('button', {
      name: 'Select sample',
      exact: true,
    })
    await button.focus()
    await page.keyboard.press('Tab')
    const trigger = page.getByRole('button', {
      name: 'Open sample dialog',
      exact: true,
    })
    assert.equal(
      await trigger.evaluate((element) => document.activeElement === element),
      true,
      'Tab skips disabled button',
    )
    assert.equal(
      await trigger.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      ),
      'solid',
      'Keyboard focus is visible',
    )
    await button.hover()
    const [buttonFrames] = await Promise.all([
      frames(page, '#sample-button'),
      (async () => {
        await page.mouse.down()
        await page.waitForTimeout(160)
        await page.mouse.up()
      })(),
    ])
    assert.equal(
      await page
        .getByRole('button', { name: 'Selected', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    )
    const [dialogFrames] = await Promise.all([
      frames(page, '[role="dialog"]'),
      (async () => {
        await trigger.focus()
        await page.keyboard.press('Enter')
      })(),
    ])
    const dialog = page.getByRole('dialog', {
      name: 'Sample dialog',
      exact: true,
    })
    await dialog.waitFor()
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
      'Dialog autofocus',
    )
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press('Tab')
      assert.equal(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
        true,
        'Dialog traps forward Tab',
      )
    }
    await page.keyboard.press('Shift+Tab')
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
      'Dialog traps reverse Tab',
    )
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(
      await trigger.evaluate((element) => document.activeElement === element),
      true,
      'Escape restores trigger focus',
    )
    const overview = page.getByRole('tab', { name: 'Overview', exact: true })
    await overview.focus()
    const [tabFrames] = await Promise.all([
      frames(page, '[role="tabpanel"][data-state="active"]'),
      page.keyboard.press('ArrowRight'),
    ])
    assert.equal(
      await page
        .getByRole('tab', { name: 'Preferences', exact: true })
        .getAttribute('aria-selected'),
      'true',
      'Tabs support ArrowRight',
    )
    const toggle = page.getByRole('switch', {
      name: 'Sample preference',
      exact: true,
    })
    await toggle.focus()
    const [switchFrames] = await Promise.all([
      frames(page, '[role="switch"] > span > span'),
      page.keyboard.press('Space'),
    ])
    assert.equal(
      await toggle.getAttribute('aria-checked'),
      'false',
      'Space toggles switch',
    )
    for (const [name, samples] of Object.entries({
      button: buttonFrames,
      dialog: dialogFrames,
      tabs: tabFrames,
    })) {
      assert(samples.length > 2, `${name} frames were observed`)
      assert.equal(
        samples.some((sample) => !identity(sample.transform)),
        !reduced,
        `${name} respects the reduced-motion transform branch`,
      )
    }
    assert(switchFrames.length > 2)
    const positions = new Set(switchFrames.map((sample) => sample.transform))
    assert(
      reduced ? positions.size <= 2 : positions.size > 2,
      'Switch jumps when reduced and travels on a spring otherwise',
    )
    motion[reduced ? 'reduced' : 'normal'] = {
      button: buttonFrames,
      dialog: dialogFrames,
      tabs: tabFrames,
      switch: switchFrames,
    }
    await page.screenshot({
      path: resolve(
        evidence,
        `controls-${reduced ? 'reduced' : 'normal'}-motion.png`,
      ),
      fullPage: true,
    })
  }
  await Bun.write(
    resolve(evidence, 'motion-frames.json'),
    JSON.stringify(motion, null, 2),
  )
  checks.push(
    'Observed normal and reduced Motion frame branches for Button, Dialog, Tabs, and Switch; keyboard controls and dialog focus trap, Escape, and restore pass.',
  )
  return checks
}

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import tokens from '../design/tokens.json'

type Theme = keyof (typeof tokens.tokens)['vela-ink']
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`

async function themeColors(page: Page, theme: Theme) {
  const expected = tokens.tokens['vela-ink'][theme]
  await page.waitForFunction(
    (ink) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--vela-ink')
        .trim() === ink,
    expected,
  )
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
  assert.equal(
    await dialog.evaluate((element) => getComputedStyle(element).color),
    rgb(expected),
    'Portal renders the Vela foreground',
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
    tokens.tokens['vela-paper'][theme],
  )
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
}

export async function verifyControls(page: Page, evidence: string) {
  for (const theme of ['light', 'dark', 'high-contrast'] as const) {
    await page
      .getByRole('button', { name: theme.replace('-', ' '), exact: true })
      .click()
    await themeColors(page, theme)
    await page.screenshot({
      path: resolve(evidence, `specimen-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    })
  }
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
    await themeColors(page, media.theme)
  }
  return [
    'Explicit and system light, dark, and high-contrast tokens reach root and body portals.',
  ]
}

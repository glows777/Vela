import { expect, test } from 'bun:test'
import { formatKeyId, keyLabel } from '../../../src/cli/tui/editor.ts'

test('Alt reads as Option on macOS and stays Alt elsewhere', () => {
  expect(formatKeyId('alt+up', 'darwin')).toBe('Option+Up')
  expect(formatKeyId('alt+up', 'linux')).toBe('Alt+Up')
  expect(formatKeyId('alt+up', 'win32')).toBe('Alt+Up')
  expect(formatKeyId('alt+enter', 'darwin')).toBe('Option+Enter')
  expect(keyLabel('dequeue', 'darwin')).toBe('Option+Up')
})

test('other modifiers and key names keep their order and spelling', () => {
  expect(formatKeyId('escape', 'darwin')).toBe('Esc')
  expect(formatKeyId('shift+ctrl+p', 'linux')).toBe('Shift+Ctrl+P')
  expect(formatKeyId('shift+tab', 'darwin')).toBe('Shift+Tab')
  expect(formatKeyId('ctrl+c', 'win32')).toBe('Ctrl+C')
  expect(formatKeyId('enter', 'darwin')).toBe('Enter')
})

test('paste image is Alt+V on Windows and Ctrl+V elsewhere', () => {
  expect(keyLabel('pasteImage', 'win32')).toBe('Alt+V')
  expect(keyLabel('pasteImage', 'darwin')).toBe('Ctrl+V')
  expect(keyLabel('pasteImage', 'linux')).toBe('Ctrl+V')
})

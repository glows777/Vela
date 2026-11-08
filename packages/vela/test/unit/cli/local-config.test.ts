import { expect, test } from 'bun:test'
import { localServeOptions } from '../../../src/cli/local-config.ts'

test('Local stays disabled unless user settings explicitly enable it for serve', () => {
  expect(localServeOptions({}, true)).toBeUndefined()
  expect(
    localServeOptions({ local: { token: 'secret' } }, true),
  ).toBeUndefined()
  expect(localServeOptions({ local: { enabled: false } }, true)).toBeUndefined()
  expect(localServeOptions({ local: { enabled: true } }, false)).toBeUndefined()
})

test('Local uses user options and its default port', () => {
  expect(
    localServeOptions({ local: { enabled: true, token: 'secret' } }, true),
  ).toEqual({ token: 'secret', port: 8788 })
  expect(
    localServeOptions(
      { local: { enabled: true, token: 'secret', port: 0, timezone: 'UTC' } },
      true,
    ),
  ).toEqual({ token: 'secret', port: 0, timezone: 'UTC' })
})

test.each([undefined, '', '   ', 42])(
  'Local rejects missing or invalid token %s',
  (token) => {
    expect(() =>
      localServeOptions({ local: { enabled: true, token } }, true),
    ).toThrow('local.token')
  },
)

test.each([-1, 65536, 1.5, '8788', null])(
  'Local rejects invalid port %s',
  (port) => {
    expect(() =>
      localServeOptions(
        { local: { enabled: true, token: 'secret', port } },
        true,
      ),
    ).toThrow('local.port')
  },
)

test('Local rejects mistyped enablement and timezone without echoing input', () => {
  expect(() =>
    localServeOptions({ local: { enabled: 'secret' } }, true),
  ).toThrow('local.enabled')
  expect(() =>
    localServeOptions(
      { local: { enabled: true, token: 'secret', timezone: 'invalid' } },
      true,
    ),
  ).toThrow('local.timezone')
})

test('Local rejects line breaks in bearer tokens as a config error', () => {
  expect(() =>
    localServeOptions(
      { local: { enabled: true, token: 'secret\nvalue' } },
      true,
    ),
  ).toThrow('local.token')
})

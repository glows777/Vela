import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExecutionEnv, Result } from '@glows777/vela-core'

function value<T>(result: Result<T, Error>): T {
  if (!result.ok) throw result.error
  return result.value
}

// Shared acceptance for the real, compiled Linux Docker operations. All fixtures are synthetic.
export async function checkDockerOperations(env: ExecutionEnv) {
  const bytes = Buffer.from(`${'A'.repeat(65535)}一\ntwo🙂\n末`)
  value(await env.writeFile('page', bytes))
  const reader = value(await env.openBinaryReader('page', { noFollow: true }))
  try {
    const head = value(await reader.read(0, 65536))
    value(await env.writeFile('replacement', 'replaced'))
    value(await env.renameFile('replacement', 'page'))
    assert.equal(value(await reader.info()).size, 65550)
    const tail = value(await reader.read(65536, 65536))
    assert.deepEqual(Buffer.concat([head, tail]), bytes)
    assert.equal(value(await reader.read(bytes.length, 10)).length, 0)
    const scan = value(await reader.scanLines({ startLine: 1, endLine: 2 }))
    assert.deepEqual(scan, {
      newlines: 2,
      start: 65539,
      end: 65546,
      selectedBytes: 7,
      firstLineEnd: 65546,
      lastLineStart: 65539,
      firstLineBytes: 7,
    })
    assert.equal(
      new TextDecoder().decode(value(await reader.read(scan.start, 7))),
      'two🙂',
    )
  } finally {
    await reader.close()
  }
  assert.equal(value(await env.readTextFile('page')), 'replaced')
  assert.equal(
    value(await env.exec(['ln', '-s', 'page', 'leaf'], {})).exitCode,
    0,
  )
  assert.match(
    JSON.stringify(await env.openBinaryReader('leaf', { noFollow: true })),
    /"code":"invalid"/,
  )
  console.log(
    'reader: 65550 bytes, 65536+14 across rename, UTF-8 scan [65539,65546), EOF, noFollow',
  )
  for (const trial of ['control', 'abort', 'timeout']) {
    const marker = `mark-${trial}`
    const abort = new AbortController()
    let ready = false
    // Ordinary foreground process group. Ignoring TERM distinguishes immediate KILL from TERM.
    const run = await env.exec(
      [
        'sh',
        '-c',
        `trap '' TERM; (trap '' TERM; echo ready; sleep 2; echo complete > "${marker}") & wait`,
      ],
      {
        timeout: trial === 'timeout' ? 0.8 : 6,
        onOutput(text) {
          if (text.includes('ready')) {
            ready = true
            if (trial === 'abort') abort.abort()
          }
        },
      },
      abort.signal,
    )
    assert.equal(ready, true)
    if (trial === 'control') assert.equal(value(run).exitCode, 0)
    else {
      assert.equal(run.ok, false)
      if (!run.ok)
        assert.equal(run.error.code, trial === 'abort' ? 'aborted' : 'timeout')
    }
    if (trial !== 'control') await delay(2200)
    const markerExists = value(await env.exists(marker))
    assert.equal(markerExists, trial === 'control')
    console.log(
      'foreground',
      trial,
      run.ok ? run.value.exitCode : run.error.code,
      'marker',
      markerExists,
    )
  }
  const root = '/tmp/vela-results'
  const previous = value(await env.exists(root))
    ? value(await env.listDir(root)).length
    : 0
  const spill = value(
    await env.exec(['printf', 'synthetic spill'], {
      spill: { afterBytes: 2, afterLines: 1 },
    }),
  ).spillPath
  assert.ok(spill?.startsWith('/tmp/vela-results/'))
  assert.equal(value(await env.readTextFile(spill!)), 'synthetic spill')
  assert.equal(value(await env.listDir(root)).length, previous + 1)
  value(await env.remove(spill!, {}))
  assert.equal(value(await env.listDir(root)).length, previous)
  console.log(
    'spill: exactly one readable container result file allocated, then removed',
  )
}

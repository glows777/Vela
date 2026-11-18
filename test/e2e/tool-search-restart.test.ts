import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('restoring a completed tool_search also restores its deferred tool declarations before the next model request', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vela-search-restart-'))
  const fixture = new URL(
    '../fixtures/recovery/tool-search.ts',
    import.meta.url,
  ).pathname
  const child = Bun.spawn([process.execPath, fixture, cwd, 'start'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const errors = new Response(child.stderr).text()
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    let output = ''
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk)
      if (output.includes('SEARCH_SAVED')) break
    }
    child.kill('SIGKILL')
    await child.exited
    expect(output, await errors).toContain('SEARCH_SAVED')
    const resumed = Bun.spawn([process.execPath, fixture, cwd, 'resume'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = new Response(resumed.stdout).text()
    const stderr = new Response(resumed.stderr).text()
    const timeout = setTimeout(() => resumed.kill('SIGKILL'), 5000)
    try {
      expect(await resumed.exited, await stderr).toBe(0)
      expect(await stdout).toContain('RECOVERED')
    } finally {
      clearTimeout(timeout)
      resumed.kill('SIGKILL')
      await resumed.exited
    }
    const request = JSON.parse(
      readFileSync(join(cwd, 'search-request.json'), 'utf8'),
    )
    expect(JSON.stringify(request.toolResults)).toContain('Loaded 1 tool')
    expect(request.tools).toContain('searchfixture_lookup')
  } finally {
    clearTimeout(deadline)
    child.kill('SIGKILL')
    await child.exited
    rmSync(cwd, { recursive: true, force: true })
  }
})

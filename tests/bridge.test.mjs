import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { startBridge } from '../index.js'

const disposable = []
const directories = []
after(async () => {
  for (const close of disposable.reverse()) await close()
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
})

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function fakeHost(prompts) {
  return {
    get: name => name !== 'sessionController' ? undefined : {
      list: async () => ({ items: [{ sessionId: 'sess1', cwd: '/home/me/proj', updatedAt: 7, running: false, blank: false, agentAvailable: true }, { junk: true }] }),
      create: async ({ cwd }) => ({ sessionId: cwd ? 'sess-created' : 'sess-blank' }),
      prompt: async request => { prompts.push(request); return { accepted: true } },
      cancel: async () => ({ accepted: true }),
    },
    logger: { warn: () => {} },
  }
}

describe('bridge service', () => {
  it('requires the token and serves info, sessions, prompt, and empty history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ri-bridge-'))
    directories.push(dir)
    const dshHome = join(dir, '.dsh')
    await mkdir(join(dshHome, 'sessions', 'grp', 'sess1'), { recursive: true })
    const prompts = []
    const port = await freePort()
    const bridge = await startBridge(fakeHost(prompts), { port, tokenFile: join(dshHome, 'token'), dshHome })
    disposable.push(() => bridge.close())
    assert.equal(bridge.port, port)
    assert.ok(bridge.token.length > 20)

    const base = `http://127.0.0.1:${port}`
    const unauthorized = await fetch(`${base}/v1/info`)
    assert.equal(unauthorized.status, 401)

    const headers = { authorization: `Bearer ${bridge.token}` }
    const info = await (await fetch(`${base}/v1/info`, { headers })).json()
    assert.equal(info.ok, true)
    assert.equal(info.canPrompt, true)
    assert.ok(['posix', 'windows'].includes(info.platform))

    const listed = await (await fetch(`${base}/v1/sessions`, { headers })).json()
    assert.deepEqual(listed.sessions.map(row => row.sessionId), ['sess1'])
    assert.equal(listed.sessions[0].cwd, '/home/me/proj')

    const empty = await (await fetch(`${base}/v1/history?sessionId=sess1`, { headers })).json()
    assert.equal(empty.source, 'empty')

    const bad = await fetch(`${base}/v1/history?sessionId=../etc`, { headers })
    assert.equal(bad.status, 400)

    const sent = await (await fetch(`${base}/v1/prompt`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'sess1', text: 'hello' }) })).json()
    assert.equal(sent.accepted, true)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, 'sess1')
    assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'hello' }])
    assert.equal(prompts[0].mode, 'queue')

    const blank = await fetch(`${base}/v1/prompt`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'sess1', text: '   ' }) })
    assert.equal(blank.status, 400)

    const created = await (await fetch(`${base}/v1/create`, { method: 'POST', headers, body: JSON.stringify({ cwd: '/home/me/proj' }) })).json()
    assert.equal(created.sessionId, 'sess-created')

    const cancelled = await (await fetch(`${base}/v1/cancel`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'sess1' }) })).json()
    assert.equal(cancelled.ok, true)

    const unknown = await fetch(`${base}/v1/nope`, { headers })
    assert.equal(unknown.status, 404)
  })

  it('stays inert when the port is zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ri-bridge-'))
    directories.push(dir)
    const bridge = await startBridge(fakeHost([]), { port: 0, tokenFile: join(dir, 'token'), dshHome: dir })
    assert.equal(bridge.port, 0)
    await bridge.close()
  })
})

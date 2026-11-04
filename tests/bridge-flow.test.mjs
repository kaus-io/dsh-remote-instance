import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { BridgeClient, RemoteInstanceService, resolveSettings, SessionBridge } from '../index.js'

const temporary = []
after(async () => { for (const dir of temporary) await rm(dir, { recursive: true, force: true }) })
async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), 'ri-flow-'))
  temporary.push(dir)
  return dir
}

function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    const path = new URL(String(url)).pathname + new URL(String(url)).search
    const handler = routes[path.split('?')[0]]
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(handler), { status: 200 })
  }
  return { impl, calls }
}

describe('BridgeClient', () => {
  it('reads the descriptor, opens a tunnel, calls with the bearer token, and closes', async () => {
    const spawned = []
    let killed = 0
    const { impl, calls } = fakeFetch({ '/v1/info': { ok: true, platform: 'windows' } })
    const client = new BridgeClient({
      exec: async argv => {
        assert.match(argv.join(' '), /remote-instance-bridge\.json/)
        return { stdout: JSON.stringify({ port: 47_123, token: 't'.repeat(32) }), stderr: '', exitCode: 0 }
      },
      spawn: argv => { spawned.push(argv.join(' ')); return { kill: () => { killed += 1 } } },
      commandArgv: command => ['ssh', '--', 'home', command],
      tunnelArgv: forward => ['ssh', '-N', '-L', `${forward.localPort}:127.0.0.1:${forward.remotePort}`],
      descriptorPath: '/home/me/.dsh/remote-instance-bridge.json',
      fetchImpl: impl,
      openTimeoutMs: 2_000,
    })
    const info = await client.call('/v1/info')
    assert.equal(info.platform, 'windows')
    assert.equal(spawned.length, 1)
    assert.match(spawned[0], /-N -L \d+:127\.0\.0\.1:47123/)
    assert.equal(calls[0].init.headers.authorization, `Bearer ${'t'.repeat(32)}`)
    await client.close()
    assert.equal(killed, 1)
  })

  it('rejects an unreadable descriptor and a non-JSON response', async () => {
    const bad = new BridgeClient({
      exec: async () => ({ stdout: '', stderr: 'cat: no such file', exitCode: 1 }),
      spawn: () => ({ kill() {} }),
      commandArgv: command => ['ssh', command],
      tunnelArgv: () => ['ssh', '-N'],
      descriptorPath: '/nope',
    })
    await assert.rejects(() => bad.discover(), /cannot read the peer bridge descriptor/)
  })
})

describe('SessionBridge', () => {
  it('maps peer payloads into rows, history, and writes', async () => {
    const { impl, calls } = fakeFetch({
      '/v1/info': { hostname: 'win-box', platform: 'windows', canPrompt: true, dshHome: 'C:\\Users\\me\\.dsh' },
      '/v1/sessions': { sessions: [{ sessionId: 's-1', cwd: 'C:\\work', updatedAt: 5 }, { sessionId: '../bad' }] },
      '/v1/history': { source: 'log', messages: [{ role: 'assistant', text: 'done' }, { role: 'x', text: '' }] },
      '/v1/prompt': { accepted: true },
      '/v1/cancel': { ok: true },
      '/v1/create': { sessionId: 's-new' },
    })
    const bridge = new SessionBridge('/tmp/desc.json', {
      exec: async () => ({ stdout: JSON.stringify({ port: 1234, token: 'x'.repeat(32) }), stderr: '', exitCode: 0 }),
      spawn: () => ({ kill() {} }),
      commandArgv: command => ['ssh', command],
      tunnelArgv: forward => ['ssh', '-N', '-L', `${forward.localPort}:127.0.0.1:${forward.remotePort}`],
      fetchImpl: impl,
    })
    const info = await bridge.info()
    assert.deepEqual(info, { hostname: 'win-box', platform: 'windows', canPrompt: true, dshHome: 'C:\\Users\\me\\.dsh' })

    const rows = await bridge.sessions()
    assert.deepEqual(rows.map(row => row.sessionId), ['s-1'])

    const history = await bridge.history('s-1')
    assert.equal(history.source, 'log')
    assert.deepEqual(history.messages, [{ role: 'assistant', text: 'done' }])

    await bridge.send('s-1', 'hello')
    await bridge.stop('s-1')
    assert.equal(await bridge.create('C:\\work'), 's-new')
    const bodies = calls.filter(call => call.init.method === 'POST').map(call => call.init.body)
    assert.match(bodies[0], /"sessionId":"s-1"/)
    assert.match(bodies[0], /"text":"hello"/)
    assert.match(bodies[2], /"cwd":"C:\\\\work"/)
    await bridge.dispose()
    await assert.rejects(() => bridge.history('../etc'), /invalid session id/)
  })
})

function fakeHost() {
  return {
    jobs: { start: () => 'j1', get: () => { throw new Error('unknown') }, readAt: () => ({ chunks: [], next: 0, lossy: false }), kill: () => 'requested', attachController: () => () => {} },
    tools: { register: () => () => {} },
    subprocess: { resolveExecutable: async command => command, spawn: () => { throw new Error('unused') } },
    approval: { request: async () => 'allowed-once' },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    agents: { get: () => undefined },
    webServer: { register: () => () => {}, getOrigin: () => '' },
    connection: { admit: () => ({ peer: { id: 'browser' } }), browserPeer: { id: 'browser' } },
    effect: factory => { factory() },
    on: () => () => {},
    logger: { warn: () => {} },
  }
}

describe('service over the bridge', () => {
  it('routes the session actions through the bridge', async () => {
    const directory = await workdir()
    const settings = resolveSettings({ storeFile: join(directory, 'remote-instances.json') })
    const sent = []
    const bridge = {
      info: async () => ({ hostname: 'peer-box', platform: 'posix', canPrompt: true }),
      sessions: async () => [{ sessionId: 's-1', cwd: '/work/a' }, { sessionId: 's-2', cwd: '/work/b' }],
      history: async sessionId => ({ source: 'log', messages: [{ role: 'assistant', text: `history:${sessionId}` }] }),
      send: async (sessionId, text) => { sent.push([sessionId, text]) },
      stop: async sessionId => { sent.push(['stop', sessionId]) },
      create: async cwd => { sent.push(['new', cwd]); return 's-new' },
      dispose: async () => {},
    }
    const service = new RemoteInstanceService(fakeHost(), settings, { bridge: () => bridge })
    await service.execute({ action: 'add', name: 'peer', host: '10.0.0.9', user: 'me' }, { source: 'ui' })

    const sessions = await service.execute({ action: 'sessions', name: 'peer' })
    assert.deepEqual(sessions.sessions.map(row => row.sessionId), ['s-1', 's-2'])

    const history = await service.execute({ action: 'history', name: 'peer', sessionId: 's-1' })
    assert.equal(history.source, 'log')
    assert.equal(history.messages[0].text, 'history:s-1')

    await service.execute({ action: 'send', name: 'peer', sessionId: 's-1', prompt: 'hi', wait: false }, { source: 'ui' })
    assert.deepEqual(sent[0], ['s-1', 'hi'])

    await service.execute({ action: 'stop', name: 'peer', sessionId: 's-1' })
    assert.deepEqual(sent[1], ['stop', 's-1'])

    const created = await service.execute({ action: 'new', name: 'peer', cwd: '/work/a' }, { source: 'ui' })
    assert.equal(created.sessionId, 's-new')
    assert.deepEqual(sent[2], ['new', '/work/a'])

    await service.dispose()
  })
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { after, describe, it } from 'node:test'
import { RemoteInstanceService, resolveSettings } from '../index.js'

const temporary = []
async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-instance-'))
  temporary.push(dir)
  return dir
}
after(async () => { for (const dir of temporary) await rm(dir, { recursive: true, force: true }) })

function fakeHost() {
  const answered = []
  const ctx = {
    answered,
    jobs: {
      start: () => 'remote-1', get: () => { throw new Error('Unknown job') },
      readAt: () => ({ chunks: [], next: 0, lossy: false }), kill: () => 'requested', attachController: () => () => {},
    },
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
  return ctx
}

/** 行为固定的 ACP 替身。 / A deterministic ACP double. */
function fakeAcp() {
  const calls = []
  return {
    calls,
    async listSessions(cwd) { calls.push(['list', cwd]); return [{ sessionId: 's-1', cwd: cwd ?? '/work/antares-os', title: '部署墨水屏' }] },
    async newSession(cwd) { calls.push(['new', cwd]); return 's-new' },
    async resumeSession(sessionId) { calls.push(['resume', sessionId]) },
    async prompt(sessionId, text) { calls.push(['prompt', sessionId, text]); return { stopReason: 'end_turn' } },
    async cancel(sessionId) { calls.push(['cancel', sessionId]) },
    async closeSession(sessionId) { calls.push(['close', sessionId]) },
    async dispose() { calls.push(['dispose']) },
  }
}

async function serviceWith(handler, acp = fakeAcp()) {
  const ctx = fakeHost()
  const directory = await workdir()
  const settings = resolveSettings({ storeFile: join(directory, 'remote-instances.json') })
  const runner = async (argv, options = {}) => { ctx.lastArgv = argv; ctx.lastOptions = options; return handler(argv, options) }
  const service = new RemoteInstanceService(ctx, settings, { runner, acp: async () => acp })
  await service.execute({ action: 'add', name: 'home', host: '100.68.98.76', user: 'me', password: 'pw' }, { source: 'ui' })
  return { ctx, service, acp }
}

describe('remote sessions over ACP', () => {
  it('lists the remote conversations and includes this host identity', async () => {
    const { service, ctx } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const list = await service.execute({ action: 'instances' })
    assert.equal(typeof list.local.hostname, 'string')
    assert.equal(list.instances[0].name, 'home')
    const sessions = await service.execute({ action: 'sessions', name: 'home' })
    assert.equal(sessions.instance, 'home')
    assert.equal(sessions.sessions[0].title, '部署墨水屏')
    await service.dispose()
    assert.ok(ctx)
  })

  it('opens a new conversation and posts a prompt', async () => {
    const { service, acp } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const created = await service.execute({ action: 'new', name: 'home', cwd: '/work/antares-os', prompt: '烧录固件', wait: false }, { source: 'ui' })
    assert.equal(created.sessionId, 's-new')
    assert.equal(created.status, 'running')
    assert.deepEqual(acp.calls.filter(call => call[0] === 'new'), [['new', '/work/antares-os']])
    assert.deepEqual(acp.calls.filter(call => call[0] === 'prompt'), [['prompt', 's-new', '烧录固件']])
  })

  it('sends into an existing conversation, waits, and reports the stop reason', async () => {
    const { service, acp } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const sent = await service.execute({ action: 'send', name: 'home', sessionId: 's-1', prompt: '继续' }, { source: 'ui' })
    assert.equal(sent.status, 'completed')
    assert.equal(sent.stopReason, 'end_turn')
    const history = await service.execute({ action: 'history', name: 'home', sessionId: 's-1', refresh: false })
    assert.equal(history.source, 'live')
    assert.equal(history.messages.at(-1).text, '继续')
    await service.dispose()
  })

  it('stops and closes a conversation', async () => {
    const { service, acp } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    assert.equal((await service.execute({ action: 'stop', name: 'home', sessionId: 's-1' }, { source: 'ui' })).status, 'cancelled')
    assert.equal((await service.execute({ action: 'close', name: 'home', sessionId: 's-1' }, { source: 'ui' })).status, 'closed')
    assert.ok(acp.calls.some(call => call[0] === 'cancel'))
    assert.ok(acp.calls.some(call => call[0] === 'close'))
    await service.dispose()
  })
})

describe('remote history from the session log', () => {
  it('reads the remote log, decompresses it, and parses the messages', async () => {
    const log = [
      JSON.stringify({ type: 'session', version: 4, id: 's-1', cwd: '/work/antares-os' }),
      JSON.stringify({ type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: '从日志来的问题' }] } }),
      JSON.stringify({ type: 'assistant/message', seq: 2, time: 20, data: { message: { content: [{ type: 'text', text: '从日志来的回答' }] } } }),
      '',
    ].join('\n')
    const encoded = Buffer.concat([zstdCompressSync(Buffer.from(log))]).toString('base64')
    const { service } = await serviceWith(async () => ({ exitCode: 0, stdout: encoded, stderr: '' }))
    const history = await service.execute({ action: 'history', name: 'home', sessionId: 's-1', refresh: true })
    assert.equal(history.source, 'log')
    assert.equal(history.cwd, '/work/antares-os')
    assert.deepEqual(history.messages.map(message => message.text), ['从日志来的问题', '从日志来的回答'])
    await service.dispose()
  })

  it('falls back to live messages when the remote has no log', async () => {
    const { service } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    await service.execute({ action: 'send', name: 'home', sessionId: 's-2', prompt: '只有实时' }, { source: 'ui' })
    const history = await service.execute({ action: 'history', name: 'home', sessionId: 's-2', refresh: true })
    assert.equal(history.source, 'live')
    assert.match(history.note, /没有找到远端会话日志/)
    await service.dispose()
  })
})

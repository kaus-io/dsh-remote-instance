import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  ACTION_PATH,
  apply,
  createActionHandler,
  createObserveHandler,
  inject,
  OBSERVE_PATH,
  RemoteInstanceService,
  resolveSettings,
  TOOL_NAME,
} from '../index.js'

const temporary = []

async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-instance-'))
  temporary.push(dir)
  return dir
}

after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true })
})

/** 最小 Host 替身，只实现本测试关心的注册面。 / Smallest Host double with the registration surface under test. */
function fakeHost(options = {}) {
  const registered = { tools: [], routes: [] }
  const ctx = {
    registered,
    jobs: {
      start: () => 'remote-1',
      get: () => { throw new Error('Unknown job') },
      readAt: () => ({ chunks: [], next: 0, lossy: false }),
      kill: () => 'requested',
      attachController: () => () => {},
    },
    tools: { register: definition => { registered.tools.push(definition); return () => {} } },
    subprocess: { resolveExecutable: async command => command, spawn: () => { throw new Error('unused') } },
    approval: { request: async () => 'allowed-once' },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    agents: { get: () => undefined },
    webServer: {
      register: route => { registered.routes.push(route); return () => {} },
      getOrigin: () => 'http://127.0.0.1:3080',
    },
    connection: {
      admit: () => (options.peer === undefined ? { peer: { id: 'browser' } } : { peer: { id: options.peer } }),
      browserPeer: { id: 'browser' },
    },
    effect: factory => { factory() },
    on: () => () => {},
    logger: { warn: () => {} },
  }
  return ctx
}

/** 造一个真实的 IncomingMessage 替身与可断言的响应。 / A request double plus an assertable response. */
function exchange({ method = 'POST', headers = {}, body = '' } = {}) {
  const req = Object.assign(new EventEmitter(), { method, headers, destroy: () => {} })
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    status: 0,
    payload: '',
    writeHead(code) { this.status = code },
    end(text) { this.payload = String(text ?? ''); this.writableEnded = true },
  })
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return { req, res }
}

const BROWSER_HEADERS = { 'x-ri-observe': '1', 'x-ri-action': '1', 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }

describe('apply', () => {
  it('declares the Host services it cannot start without', () => {
    for (const service of ['tools', 'subprocess', 'jobs', 'sandboxPolicy', 'approval', 'agents', 'webServer', 'connection']) {
      assert.ok(inject.includes(service), `inject must declare ${service}`)
    }
  })

  it('registers the tool and the two authenticated routes', async () => {
    const ctx = fakeHost()
    apply(ctx, { storeFile: join(await workdir(), 'remote-instances.json'), bridge: false })
    assert.equal(ctx.registered.tools.length, 1)
    const tool = ctx.registered.tools[0]
    assert.equal(tool.name, TOOL_NAME)
    assert.equal(tool.parameters.required[0], 'action')
    assert.deepEqual(tool.parameters.properties.action.enum, ['instances', 'add', 'remove', 'probe', 'ask', 'jobs', 'status', 'cancel', 'sessions', 'new', 'history', 'send', 'stop', 'close'])
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(ctx.registered.routes.map(route => route.path).sort(), [ACTION_PATH, OBSERVE_PATH].sort())
    assert.ok(ctx.registered.routes.every(route => route.kind === 'exact'))

    const value = await tool.execute({ action: 'instances' }, { agent: { id: 'session-a', session: {} } })
    assert.deepEqual(value.instances, [])
    assert.match(value.store, /remote-instances\.json$/)
  })

  it('refuses to mount with an invalid configuration', () => {
    const ctx = fakeHost()
    assert.throws(() => apply(ctx, { connectTimeoutMs: 'soon' }), /connectTimeoutMs/)
    assert.throws(() => apply(ctx, { surprise: true }), /unknown field/)
    assert.throws(() => apply(ctx, { storeFile: 'relative/path.json' }), /absolute/)
  })
})

describe('Settings endpoints', () => {
  async function service() {
    const ctx = fakeHost()
    const settings = resolveSettings({ storeFile: join(await workdir(), 'remote-instances.json') })
    return { ctx, service: new RemoteInstanceService(ctx, settings, { runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }) }
  }

  it('serves the read-only list only to the authenticated browser', async () => {
    const { ctx, service: instance } = await service()
    const observe = createObserveHandler(instance, () => 'http://127.0.0.1:3080')
    const body = JSON.stringify({ args: { action: 'instances' } })

    const missingHeader = exchange({ headers: { 'content-type': 'application/json' }, body })
    await observe(missingHeader.req, missingHeader.res)
    assert.equal(missingHeader.res.status, 400)

    const foreign = exchange({ headers: { ...BROWSER_HEADERS, origin: 'http://evil.example' }, body })
    await observe(foreign.req, foreign.res)
    assert.equal(foreign.res.status, 400)

    ctx.connection.admit = () => ({ rejection: { status: 401 } })
    const unauthenticated = exchange({ headers: BROWSER_HEADERS, body })
    await observe(unauthenticated.req, unauthenticated.res)
    assert.equal(unauthenticated.res.status, 401)

    ctx.connection.admit = () => ({ peer: { id: 'api' } })
    const api = exchange({ headers: BROWSER_HEADERS, body })
    await observe(api.req, api.res)
    assert.equal(api.res.status, 403)

    ctx.connection.admit = () => ({ peer: { id: 'browser' } })
    const ok = exchange({ headers: BROWSER_HEADERS, body })
    await observe(ok.req, ok.res)
    assert.equal(ok.res.status, 200)
    assert.equal(JSON.parse(ok.res.payload).ok, true)
    assert.deepEqual(JSON.parse(ok.res.payload).value.instances, [])

    const write = exchange({ headers: BROWSER_HEADERS, body: JSON.stringify({ args: { action: 'add', name: 'dev', host: 'h' } }) })
    await observe(write.req, write.res)
    assert.equal(write.res.status, 400)
    await instance.dispose()
  })

  it('accepts explicit user actions and refuses anything else', async () => {
    const { ctx, service: instance } = await service()
    const action = createActionHandler(instance, () => 'http://127.0.0.1:3080')

    const notJson = exchange({ headers: { ...BROWSER_HEADERS, 'content-type': 'text/plain' }, body: '{}' })
    await action(notJson.req, notJson.res)
    assert.equal(notJson.res.status, 400)

    const noOrigin = exchange({ headers: { 'x-ri-action': '1', 'content-type': 'application/json' }, body: '{}' })
    await action(noOrigin.req, noOrigin.res)
    assert.equal(noOrigin.res.status, 400)

    const add = exchange({ headers: BROWSER_HEADERS, body: JSON.stringify({ args: { action: 'add', name: 'dev', host: 'dev.lan' } }) })
    await action(add.req, add.res)
    assert.equal(add.res.status, 200)
    assert.equal(JSON.parse(add.res.payload).value.instance.target, 'dev.lan')
    assert.equal(ctx.registered.tools.length, 0)

    const denied = exchange({ headers: BROWSER_HEADERS, body: JSON.stringify({ args: { action: 'jobs' } }) })
    await action(denied.req, denied.res)
    assert.equal(denied.res.status, 400)
    assert.match(JSON.parse(denied.res.payload).error, /not available from the Settings panel/)
    await instance.dispose()
  })

  it('fails closed without a browser connection service', async () => {
    const ctx = fakeHost()
    const settings = resolveSettings({ storeFile: join(await workdir(), 'remote-instances.json') })
    const instance = new RemoteInstanceService(ctx, settings, { runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })
    ctx.connection = {}
    const observe = createObserveHandler(instance, () => 'http://127.0.0.1:3080')
    const request = exchange({ headers: BROWSER_HEADERS, body: JSON.stringify({ args: { action: 'instances' } }) })
    await observe(request.req, request.res)
    assert.equal(request.res.status, 503)
    await instance.dispose()
  })
})

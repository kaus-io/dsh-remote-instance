import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let loadCount = 0

/** 以宿主模块加载器的视角执行 client.js，拿到注册的工厂。 / Run client.js the way the host module loader does. */
async function loadBundle() {
  const captured = []
  globalThis.window = { __ModuleLoader__: { load: spec => captured.push(spec) } }
  // 每次用新的查询串导入，保证工厂重新执行一次。 / A fresh query string re-executes the factory.
  await import(`${pathToFileURL(join(root, 'client.js')).href}?load=${++loadCount}`)
  assert.equal(captured.length, 1)
  return captured[0]
}

function fakeClient() {
  const registered = []
  const ctx = {
    registered,
    effect: factory => { factory() },
    locale: {
      register: (namespace, dictionaries) => {
        registered.push({ kind: 'locale', namespace, languages: Object.keys(dictionaries) })
        return () => {}
      },
      bind: namespace => key => `${namespace}.${key}`,
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registered.push({ kind: 'slot', options, component })
        return () => {}
      },
    },
  }
  return ctx
}

describe('client bundle', () => {
  it('registers under the package id and exposes only the plugin face', async () => {
    const spec = await loadBundle()
    assert.equal(spec.id, '@kaus-io/dsh-remote-instance')
    const exports = spec.factory(() => ({}))
    assert.deepEqual(Object.keys(exports).sort(), ['apply', 'inject'])
    assert.deepEqual([...exports.inject].sort(), ['locale', 'slots'])
  })

  it('registers both dictionaries and one Settings section', async () => {
    const spec = await loadBundle()
    const ctx = fakeClient()
    spec.factory(() => ({})).apply(ctx)
    const locale = ctx.registered.find(entry => entry.kind === 'locale')
    assert.equal(locale.namespace, 'remoteInstance')
    assert.deepEqual(locale.languages, ['zh', 'en'])
    const slot = ctx.registered.find(entry => entry.kind === 'slot')
    assert.equal(slot.options.name, 'settings.section')
    assert.equal(slot.options.id, 'remote-instance')
    assert.equal(slot.options.locale, 'remoteInstance')
    assert.equal(typeof slot.options.label, 'function')
    assert.equal(slot.options.label(), 'remoteInstance.nav')
    assert.equal(typeof slot.component, 'function')
    const toolbar = ctx.registered.find(entry => entry.kind === 'slot' && entry.options.name === 'conversation.session.header.utilities')
    assert.equal(toolbar.options.id, 'remote-instance-toolbar')
    assert.equal(toolbar.options.locale, 'remoteInstance')
    assert.equal(typeof toolbar.component, 'function')
    const injected = slot.options.inject()
    assert.equal(typeof injected.api.read, 'function')
    assert.equal(typeof injected.api.act, 'function')
  })

  it('sends the custom endpoints with their guard headers', async () => {
    const spec = await loadBundle()
    const ctx = fakeClient()
    spec.factory(() => ({})).apply(ctx)
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (path, init) => {
      calls.push({ path, init })
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { store: '~/.dsh/remote-instances.json', instances: [] } }) }
    }
    try {
      const { api } = ctx.registered.find(entry => entry.kind === 'slot').options.inject()
      await api.read({ action: 'instances' })
      await api.act({ action: 'probe', name: 'dev' })
    } finally {
      globalThis.fetch = original
    }
    assert.equal(calls[0].path, '/remote-instance/observe')
    assert.equal(calls[0].init.headers['x-ri-observe'], '1')
    assert.equal(calls[0].init.credentials, 'same-origin')
    assert.equal(calls[1].path, '/remote-instance/action')
    assert.equal(calls[1].init.headers['x-ri-action'], '1')
    assert.equal(calls[1].init.method, 'POST')
  })

  it('keeps the generated artifact committed and current', async () => {
    const source = await readFile(join(root, 'client.js'), 'utf8')
    assert.match(source, /window\.__ModuleLoader__\.load\(\{ id: "@kaus-io\/dsh-remote-instance"/)
    assert.match(source, /\}\);\s*$/)
  })
})

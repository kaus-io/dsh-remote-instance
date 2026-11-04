import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { assertSecret, RemoteInstanceService, resolveSettings, SecretStore, secretsPathFor } from '../index.js'

const temporary = []

async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-instance-'))
  temporary.push(dir)
  return dir
}

after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true })
})

function fakeHost() {
  const jobs = new Map()
  const ctx = {
    jobsMap: jobs,
    tools: { register: () => () => {} },
    subprocess: { resolveExecutable: async command => command, spawn: () => { throw new Error('unused') } },
    approval: { request: async () => 'allowed-once' },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    agents: { get: () => undefined },
    webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:3080' },
    connection: { admit: () => ({ peer: { id: 'browser' } }), browserPeer: { id: 'browser' } },
    effect: factory => { factory() },
    on: () => () => {},
    logger: { warn: () => {} },
  }
  ctx.jobs = {
    start: spec => {
      const id = `remote-${jobs.size + 1}`
      const record = { appended: [], progress: [] }
      const hooks = spec.run({
        id,
        append: (text, options) => { record.appended.push({ text, channel: options?.channel ?? 'log' }) },
        updateProgress: line => { record.progress.push(line) },
      })
      jobs.set(id, { spec, record, hooks })
      return id
    },
    get: id => {
      const entry = jobs.get(id)
      if (!entry) throw new Error('Unknown job')
      return { id, kind: entry.spec.kind, label: entry.spec.label, status: 'running' }
    },
    readAt: id => ({ chunks: jobs.get(id)?.record.appended.map((chunk, index) => ({ at: index, text: chunk.text })) ?? [], next: 0, lossy: false }),
    kill: (id, _caller, reason) => { jobs.get(id)?.hooks.cancel(reason); return 'requested' },
    attachController: () => () => {},
  }
  return ctx
}

function fakeRunner(handler) {
  const calls = []
  const runner = async (argv, options = {}) => {
    const call = { argv, options }
    calls.push(call)
    return handler(call)
  }
  runner.calls = calls
  return runner
}

const agent = { id: 'session-a', session: {} }

async function serviceWith(handler) {
  const ctx = fakeHost()
  const directory = await workdir()
  const settings = resolveSettings({ storeFile: join(directory, 'remote-instances.json') })
  const runner = fakeRunner(handler)
  const service = new RemoteInstanceService(ctx, settings, { runner })
  return { ctx, service, runner, directory, settings }
}

describe('SecretStore', () => {
  it('stores passwords in a 0600 file beside the list and deletes them', async () => {
    const directory = await workdir()
    const file = secretsPathFor(join(directory, 'remote-instances.json'))
    assert.equal(file, join(directory, 'remote-instances.secrets.json'))
    const store = new SecretStore(file)
    assert.equal((await store.load()).size, 0)
    await store.set('dev', 'p@ss word!#')
    assert.equal(await store.get('dev'), 'p@ss word!#')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    await store.delete('dev')
    assert.equal(await store.load().then(map => map.size), 0)
    assert.throws(() => assertSecret(''), /password/)
    assert.throws(() => assertSecret('x'.repeat(5000)), /too long/)
    assert.equal(assertSecret('a b#!$'), 'a b#!$')
  })
})

describe('password authentication', () => {
  it('stores the password on add and never returns it', async () => {
    const { service, directory, settings } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const added = await service.execute({ action: 'add', name: 'win', host: '100.68.98.76', user: '95744', password: 'Huanghao2003#.' }, { source: 'ui' })
    assert.equal(added.auth, 'password')
    assert.equal(added.instance.auth, 'password')
    const listed = await service.execute({ action: 'instances' })
    assert.equal(listed.instances[0].auth, 'password')
    const serialized = JSON.stringify(listed)
    assert.equal(serialized.includes('Huanghao2003#.'), false)
    const stored = JSON.parse(await readFile(secretsPathFor(settings.storeFile), 'utf8'))
    assert.equal(stored.passwords.win, 'Huanghao2003#.')
    assert.equal((await readFile(settings.storeFile, 'utf8')).includes('Huanghao2003#.'), false)
    await service.dispose()
    assert.ok(directory)
  })

  it('derives the device name from the host when it is omitted', async () => {
    const { service } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const added = await service.execute({ action: 'add', host: '100.68.98.76', user: '95744', password: 'pw' }, { source: 'ui' })
    assert.equal(added.instance.name, '100-68-98-76')
    const listed = await service.execute({ action: 'instances' })
    assert.deepEqual(listed.instances.map(entry => entry.name), ['100-68-98-76'])
    await service.dispose()
  })

  it('falls back to key authentication when no password is given', async () => {
    const { service, settings } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const added = await service.execute({ action: 'add', name: 'dev', host: 'dev.lan' }, { source: 'ui' })
    assert.equal(added.auth, 'key')
    await assert.rejects(() => readFile(secretsPathFor(settings.storeFile), 'utf8'), /ENOENT/)
    await service.dispose()
  })

  it('feeds ssh the password through the environment and an askpass helper', async () => {
    const { service, runner, ctx } = await serviceWith(async call => {
      call.options.onOutput?.({ stream: 'stdout', text: '{"type":"final","text":"ok"}\n' })
      return { exitCode: 0, stdout: '{"type":"final","text":"ok"}\n', stderr: '' }
    })
    await service.execute({ action: 'add', name: 'win', host: 'win.lan', user: 'me', password: 'S3cret!#' }, { source: 'ui' })
    const started = await service.execute({ action: 'ask', name: 'win', prompt: 'hello' }, { agent })
    await ctx.jobsMap.get(started.jobId).hooks.done
    const call = runner.calls.at(-1)
    assert.ok(call.argv.includes('BatchMode=no'))
    assert.ok(call.argv.includes('PreferredAuthentications=password,keyboard-interactive'))
    assert.equal(call.argv.join(' ').includes('S3cret!#'), false, 'the password must never reach argv')
    assert.equal(call.options.env.DSH_REMOTE_PASSWORD, 'S3cret!#')
    assert.equal(call.options.env.SSH_ASKPASS_REQUIRE, 'force')
    const helper = call.options.env.SSH_ASKPASS
    assert.match(await readFile(helper, 'utf8'), /DSH_REMOTE_PASSWORD/)
    assert.equal((await stat(helper)).mode & 0o777, 0o700)
    assert.equal(call.options.stdin, 'hello')
    await service.dispose()
    await assert.rejects(() => stat(helper), /ENOENT/)
  })

  it('removes the stored password together with the device', async () => {
    const { service, settings } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    await service.execute({ action: 'add', name: 'win', host: 'win.lan', password: 'pw' }, { source: 'ui' })
    await service.execute({ action: 'remove', name: 'win' }, { source: 'ui' })
    const secrets = JSON.parse(await readFile(secretsPathFor(settings.storeFile), 'utf8'))
    assert.deepEqual(secrets.passwords, {})
    await service.dispose()
  })

  it('asks for a password when the record needs one but none is stored', async () => {
    const { service, settings } = await serviceWith(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    await service.execute({ action: 'add', name: 'win', host: 'win.lan', password: 'pw' }, { source: 'ui' })
    await rm(secretsPathFor(settings.storeFile), { force: true })
    await assert.rejects(() => service.execute({ action: 'ask', name: 'win', prompt: 'x' }, { agent }), /needs a password/)
    await service.dispose()
  })
})

describe('platform detection', () => {
  it('falls back to the Windows probe and remembers the platform', async () => {
    const { service, runner, ctx } = await serviceWith(async call => {
      const command = call.argv.at(-1)
      if (command.startsWith('powershell ')) {
        return {
          exitCode: 0,
          stdout: 'probe\tversion\tdsh 0.2.1-rc.5\nprobe\tos\tMicrosoft Windows NT 10.0\nprobe\tprofile\tpresent\nprobe\tplatform\twindows\n',
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: "'bash' is not recognized as an internal or external command", stderr: '' }
    })
    await service.execute({ action: 'add', name: 'win', host: 'win.lan', user: 'me', password: 'pw' }, { source: 'ui' })
    const probe = await service.execute({ action: 'probe', name: 'win' }, { source: 'ui' })
    assert.equal(probe.ok, true)
    assert.equal(probe.platform, 'windows')
    assert.equal(probe.version, 'dsh 0.2.1-rc.5')
    const listed = await service.execute({ action: 'instances' })
    assert.equal(listed.instances[0].platform, 'windows')
    assert.equal(runner.calls.length, 2)
    assert.match(runner.calls[1].argv.at(-1), /^powershell /)

    const started = await service.execute({ action: 'ask', name: 'win', prompt: 'hi' }, { agent })
    await ctx.jobsMap.get(started.jobId).hooks.done
    assert.match(runner.calls.at(-1).argv.at(-1), /^powershell /)
    await service.dispose()
  })
})

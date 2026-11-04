import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { RemoteInstanceService, resolveSettings } from '../index.js'

const temporary = []

async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-instance-'))
  temporary.push(dir)
  return dir
}

after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true })
})

/**
 * 最小 Host 替身：真实作业注册表的最小行为（start/run/done、append、cancel），以及审批与沙箱记录。
 * Smallest Host double: the real registry's essential behavior (start/run/done,
 * append, cancel) plus recorded approvals and sandbox mode.
 */
function fakeHost(options = {}) {
  const jobs = new Map()
  const approvals = []
  const ctx = {
    approvals,
    jobs: undefined,
    jobsMap: jobs,
    tools: { register: () => () => {} },
    subprocess: {
      resolveExecutable: async command => command,
      spawn: () => { throw new Error('subprocess must not be used directly in tests') },
    },
    approval: {
      request: async request => {
        approvals.push(request)
        return options.approval ?? 'allowed-once'
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: options.mode ?? 'workspace-write' }) },
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
        append: (text, appendOptions) => { record.appended.push({ text, channel: appendOptions?.channel ?? 'log' }) },
        updateProgress: line => { record.progress.push(line) },
      })
      jobs.set(id, { spec, record, hooks, status: 'running' })
      return id
    },
    get: (id) => {
      const entry = jobs.get(id)
      if (!entry) throw new Error('Unknown job')
      return { id, kind: entry.spec.kind, label: entry.spec.label, status: entry.status, owner: entry.spec.owner }
    },
    readAt: (id) => {
      const entry = jobs.get(id)
      if (!entry) throw new Error('Unknown job')
      return { chunks: entry.record.appended.map((chunk, index) => ({ at: index, text: chunk.text, channel: chunk.channel })), next: entry.record.appended.length, lossy: false }
    },
    kill: (id, _caller, reason) => {
      const entry = jobs.get(id)
      if (!entry) throw new Error('Unknown job')
      entry.hooks.cancel(reason)
      entry.status = 'stopping'
      return 'requested'
    },
    attachController: () => () => {},
  }
  ctx.jobsMap = jobs
  return ctx
}

function fakeRunner(handler) {
  const calls = []
  const runner = async (argv, runOptions = {}) => {
    const call = { argv, options: runOptions }
    calls.push(call)
    return handler(call)
  }
  runner.calls = calls
  return runner
}

const agent = { id: 'session-a', session: {} }
const otherAgent = { id: 'session-b', session: {} }

async function serviceWith(hostOptions = {}, extra = {}) {
  const ctx = fakeHost(hostOptions)
  const settings = resolveSettings({ storeFile: join(await workdir(), 'remote-instances.json'), ...extra.settings })
  const runner = extra.runner ?? fakeRunner(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
  const service = new RemoteInstanceService(ctx, settings, { runner })
  return { ctx, service, runner, settings }
}

describe('remote instance service', () => {
  it('lists an empty list and seeds the configured devices once', async () => {
    const { service } = await serviceWith({}, {
      settings: { instances: [{ name: 'seeded', host: 'seeded.lan' }] },
    })
    const first = await service.execute({ action: 'instances' })
    assert.equal(first.instances.length, 1)
    assert.equal(first.instances[0].name, 'seeded')
    assert.match(first.store, /remote-instances\.json$/)
    await service.execute({ action: 'remove', name: 'seeded' }, { source: 'ui' })
    const second = await service.execute({ action: 'instances' })
    assert.equal(second.instances.length, 0)
    await service.dispose()
  })

  it('asks for a one-shot approval before adding a device from the tool', async () => {
    const { ctx, service } = await serviceWith({ approval: 'denied' })
    await assert.rejects(
      () => service.execute({ action: 'add', name: 'dev', host: 'dev.lan' }, { agent, source: 'tool', callId: 'call-1' }),
      /not authorized/,
    )
    assert.equal(ctx.approvals.length, 1)
    assert.equal(ctx.approvals[0].toolName, 'remote_instance')
    assert.equal((await service.execute({ action: 'instances' })).instances.length, 0)
    await service.dispose()
  })

  it('skips approval for Full Access sessions and for direct UI actions', async () => {
    const full = await serviceWith({ mode: 'danger-full-access' })
    const added = await full.service.execute({ action: 'add', name: 'dev', host: 'dev.lan' }, { agent, source: 'tool' })
    assert.equal(added.instance.target, 'dev.lan')
    assert.equal(full.ctx.approvals.length, 0)

    const ui = await serviceWith({})
    await ui.service.execute({ action: 'add', name: 'ui-dev', host: 'ui.lan' }, { source: 'ui' })
    assert.equal(ui.ctx.approvals.length, 0)
    assert.equal((await ui.service.execute({ action: 'instances' })).instances[0].name, 'ui-dev')
    await full.service.dispose()
    await ui.service.dispose()
  })

  it('probes over ssh with batch mode and caches the verdict', async () => {
    const { ctx, service, runner } = await serviceWith({}, {
      runner: fakeRunner(async () => ({
        exitCode: 0,
        stdout: 'probe\tversion\tdsh 0.2.1\nprobe\tos\tLinux 6.1\nprobe\tpath\t/usr/bin/dsh\nprobe\tprofile\tpresent\n',
        stderr: '',
      })),
    })
    await service.execute({ action: 'add', name: 'dev', host: 'dev.lan', user: 'alice' }, { source: 'ui' })
    const probe = await service.execute({ action: 'probe', name: 'dev' }, { source: 'ui' })
    assert.equal(probe.ok, true)
    assert.equal(probe.version, 'dsh 0.2.1')
    assert.deepEqual(runner.calls[0].argv.slice(0, 2), ['ssh', '-T'])
    assert.ok(runner.calls[0].argv.includes('BatchMode=yes'))
    assert.equal(runner.calls[0].argv.at(-2), 'dev.lan')
    const listed = await service.execute({ action: 'instances' })
    assert.equal(listed.instances[0].lastProbe.ok, true)
    assert.equal(listed.instances[0].lastProbe.version, 'dsh 0.2.1')
    assert.equal(ctx.approvals.length, 0)
    await service.dispose()
  })

  it('reports a failed probe as a recorded, non-throwing verdict', async () => {
    const { service } = await serviceWith({}, {
      runner: fakeRunner(async () => ({ exitCode: 255, stdout: '', stderr: 'ssh: connect to host dev.lan port 22: Connection refused' })),
    })
    await service.execute({ action: 'add', name: 'dev', host: 'dev.lan' }, { source: 'ui' })
    const probe = await service.execute({ action: 'probe', name: 'dev' }, { source: 'ui' })
    assert.equal(probe.ok, false)
    assert.match(probe.message ?? '', /Connection refused/)
    const listed = await service.execute({ action: 'instances' })
    assert.equal(listed.instances[0].lastProbe.ok, false)
    await service.dispose()
  })

  it('dispatches a task as a background job, streaming progress and answering', async () => {
    const stdout = [
      JSON.stringify({ type: 'session', sessionId: 'session-remote-9', cwd: '/work' }),
      JSON.stringify({ type: 'text', text: 'listing files' }),
      JSON.stringify({ type: 'final', text: 'there are 3 files' }),
      '',
    ].join('\n')
    const { ctx, service, runner } = await serviceWith({}, {
      runner: fakeRunner(async call => {
        call.options.onOutput?.({ stream: 'stdout', text: stdout })
        return { exitCode: 0, stdout, stderr: '' }
      }),
    })
    await service.execute({ action: 'add', name: 'dev', host: 'dev.lan', profile: 'headless', cwd: '~/work' }, { source: 'ui' })
    const started = await service.execute({ action: 'ask', name: 'dev', prompt: 'list the files' }, { agent, source: 'tool', callId: 'call-7' })
    assert.equal(started.status, 'running')
    assert.equal(started.instance, 'dev')
    const entry = ctx.jobsMap.get(started.jobId)
    assert.match(entry.spec.label, /^Remote dev: list the files/)
    assert.equal(entry.spec.kind, 'remote')
    assert.equal(entry.spec.owner, 'session-a')
    assert.equal(entry.spec.toolCall.callId, 'call-7')
    assert.equal(runner.calls[0].options.stdin, 'list the files')
    assert.equal(runner.calls[0].argv.at(-2), 'dev.lan')
    const outcome = await entry.hooks.done
    assert.equal(outcome.status, 'completed')
    const payload = JSON.parse(outcome.result)
    assert.equal(payload.answer, 'there are 3 files')
    assert.equal(payload.sessionId, 'session-remote-9')
    assert.ok(entry.record.progress.includes('session session-remote-9'))
    assert.ok(entry.record.appended.some(chunk => chunk.text === 'listing files'))

    const jobs = await service.execute({ action: 'jobs' }, { agent })
    assert.equal(jobs.jobs.length, 1)
    assert.equal(jobs.jobs[0].id, started.jobId)
    assert.deepEqual(await service.execute({ action: 'jobs' }, { agent: otherAgent }), { jobs: [] })
    await assert.rejects(() => service.execute({ action: 'status', jobId: started.jobId }, { agent: otherAgent }), /Unknown or foreign/)
    const status = await service.execute({ action: 'status', jobId: started.jobId }, { agent })
    assert.equal(status.result.answer, 'there are 3 files')
    assert.ok(status.output.chunks.length > 0)
    await service.dispose()
  })

  it('requires a live session to dispatch a task', async () => {
    const { service } = await serviceWith({})
    await assert.rejects(() => service.execute({ action: 'ask', name: 'dev', prompt: 'x' }, {}), /live session/)
    await service.dispose()
  })

  it('cancels a running task and settles it as killed', async () => {
    const { ctx, service } = await serviceWith({}, {
      runner: fakeRunner(call => new Promise((_resolve, reject) => {
        call.options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })),
    })
    await service.execute({ action: 'add', name: 'dev', host: 'dev.lan' }, { source: 'ui' })
    const started = await service.execute({ action: 'ask', name: 'dev', prompt: 'long task' }, { agent })
    const entry = ctx.jobsMap.get(started.jobId)
    const done = entry.hooks.done
    const cancelled = await service.execute({ action: 'cancel', jobId: started.jobId }, { agent })
    assert.equal(cancelled.status, 'requested')
    const outcome = await done
    assert.equal(outcome.status, 'killed')
    await assert.rejects(() => service.execute({ action: 'cancel', jobId: 'remote-404' }, { agent }), /Unknown or foreign/)
    await service.dispose()
  })

  it('rejects unknown devices and malformed requests', async () => {
    const { service } = await serviceWith({})
    await assert.rejects(() => service.execute({ action: 'probe', name: 'missing' }, { source: 'ui' }), /Unknown remote instance/)
    await assert.rejects(() => service.execute({ action: 'nope' }), /Unknown remote instance action/)
    await assert.rejects(() => service.execute({ action: 'instances', extra: 1 }), /Unknown remote instance request field/)
    await assert.rejects(() => service.execute({ action: 'add', name: 'dev', host: 'h', note: 'x\u0001y' }, { source: 'ui' }), /Invalid remote instance field/)
    await service.dispose()
  })

  it('stops live work and refuses new operations after dispose', async () => {
    const { service } = await serviceWith({}, {
      runner: fakeRunner(call => new Promise((_resolve, reject) => {
        call.options.signal?.addEventListener('abort', () => reject(new Error('unloaded')), { once: true })
      })),
    })
    await service.execute({ action: 'add', name: 'dev', host: 'dev.lan' }, { source: 'ui' })
    const started = await service.execute({ action: 'ask', name: 'dev', prompt: 'hold' }, { agent })
    assert.equal(started.status, 'running')
    await service.dispose()
    await assert.rejects(() => service.execute({ action: 'instances' }), /unloading/)
  })
})

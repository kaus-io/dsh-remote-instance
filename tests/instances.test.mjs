import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { displayTarget, InstanceStore, instanceSummary, validateInstance } from '../index.js'

const temporary = []

async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-instance-'))
  temporary.push(dir)
  return dir
}

after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true })
})

describe('validateInstance', () => {
  it('applies safe defaults and keeps only declared fields', () => {
    const instance = validateInstance({ name: 'laptop', host: 'laptop.lan', junk: 'dropped' }, { now: 1 })
    assert.equal(instance.name, 'laptop')
    assert.equal(instance.profile, 'headless')
    assert.equal(instance.dsh, 'dsh')
    assert.equal(instance.shell, 'bash')
    assert.equal(instance.createdAt, 1)
    assert.equal(instance.updatedAt, 1)
    assert.equal('junk' in instance, false)
  })

  it('preserves the creation time and probe record when replacing', () => {
    const first = validateInstance({ name: 'laptop', host: 'laptop.lan' }, { now: 10 })
    const replaced = validateInstance({ name: 'laptop', host: 'laptop2.lan', user: 'alice' }, { now: 20, existing: first })
    assert.equal(replaced.createdAt, 10)
    assert.equal(replaced.updatedAt, 20)
    assert.equal(replaced.user, 'alice')
  })

  it('rejects names that would be confusing or unsafe', () => {
    for (const name of ['Laptop', '-laptop', 'laptop name', 'a'.repeat(33), '']) {
      assert.throws(() => validateInstance({ name, host: 'h' }), /name/)
    }
    // 以 IP 派生的名字可以以数字开头。 / A name derived from an IP may start with a digit.
    assert.equal(validateInstance({ name: '100-68-98-76', host: '100.68.98.76' }).name, '100-68-98-76')
  })

  it('rejects hosts that look like ssh options', () => {
    for (const host of ['-oProxyCommand=evil', 'host name', 'host;rm -rf /', '$(id)']) {
      assert.throws(() => validateInstance({ name: 'dev', host }), /host/)
    }
  })

  it('rejects invalid ports, profiles, and control characters', () => {
    assert.throws(() => validateInstance({ name: 'dev', host: 'h', port: 0 }), /port/)
    assert.throws(() => validateInstance({ name: 'dev', host: 'h', port: 70000 }), /port/)
    assert.throws(() => validateInstance({ name: 'dev', host: 'h', profile: 'Head Less' }), /profile/)
    assert.throws(() => validateInstance({ name: 'dev', host: 'h', note: 'a\u0000b' }), /note/)
    assert.throws(() => validateInstance({ name: 'dev', host: 'h', dsh: '-oProxyCommand=evil' }), /dsh/)
  })

  it('requires absolute identity files and relative remote directories', () => {
    assert.throws(() => validateInstance({ name: 'dev', host: 'h', identityFile: 'keys/id' }), /identityFile/)
    assert.throws(() => validateInstance({ name: 'dev', host: 'h', cwd: 'relative/dir' }), /cwd/)
    assert.equal(validateInstance({ name: 'dev', host: 'h', cwd: '~/work' }).cwd, '~/work')
    assert.equal(validateInstance({ name: 'dev', host: 'h', shell: '' }).shell, '')
  })
})

describe('instanceSummary and displayTarget', () => {
  it('renders user, host, and port without leaking anything else', () => {
    const instance = validateInstance({ name: 'dev', host: 'dev.lan', user: 'alice', port: 2222, note: 'lab box' }, { now: 0 })
    assert.equal(displayTarget(instance), 'alice@dev.lan:2222')
    const summary = instanceSummary(instance)
    assert.equal(summary.target, 'alice@dev.lan:2222')
    assert.equal(summary.note, 'lab box')
    assert.equal('createdAt' in summary, true)
  })
})

describe('InstanceStore', () => {
  it('returns an empty snapshot when the file is missing', async () => {
    const store = new InstanceStore({ file: join(await workdir(), 'remote-instances.json') })
    const snapshot = await store.load()
    assert.equal(snapshot.exists, false)
    assert.equal(snapshot.instances.size, 0)
  })

  it('writes, reads, and updates atomically with owner-only permissions', async () => {
    const file = join(await workdir(), 'nested', 'remote-instances.json')
    const store = new InstanceStore({ file })
    await store.update(instances => {
      instances.set('dev', validateInstance({ name: 'dev', host: 'dev.lan' }, { now: 5 }))
    })
    const snapshot = await store.load()
    assert.equal(snapshot.exists, true)
    assert.equal(snapshot.instances.get('dev')?.host, 'dev.lan')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1)
    await store.update(instances => { instances.delete('dev') })
    assert.equal((await store.load()).instances.size, 0)
  })

  it('reports invalid rows instead of dropping the whole list', async () => {
    const file = join(await workdir(), 'remote-instances.json')
    await writeFile(file, JSON.stringify({ version: 1, instances: [{ name: 'ok', host: 'h.lan' }, { name: 'Bad Name', host: 'h' }] }))
    const snapshot = await new InstanceStore({ file }).load()
    assert.equal(snapshot.instances.size, 1)
    assert.equal(snapshot.skipped.length, 1)
  })

  it('fails loud on a corrupt file instead of silently emptying the list', async () => {
    const file = join(await workdir(), 'remote-instances.json')
    await writeFile(file, '{ not json')
    await assert.rejects(() => new InstanceStore({ file }).load(), /not valid JSON/)
    await writeFile(file, JSON.stringify({ version: 1 }))
    await assert.rejects(() => new InstanceStore({ file }).load(), /instances/)
  })

  it('serializes concurrent read-modify-write operations', async () => {
    const file = join(await workdir(), 'remote-instances.json')
    const store = new InstanceStore({ file })
    await Promise.all(Array.from({ length: 8 }, (_value, index) => store.update(instances => {
      instances.set(`dev${index}`, validateInstance({ name: `dev${index}`, host: 'h' }, { now: index }))
    })))
    assert.equal((await store.load()).instances.size, 8)
  })
})

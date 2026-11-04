import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  createTaskParser,
  parseProbeOutput,
  remoteProbeCommand,
  remoteTaskCommand,
  shellQuote,
  sshArgv,
} from '../index.js'

const temporary = []
const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-instance-'))
  temporary.push(dir)
  return dir
}

after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true })
})

describe('shellQuote', () => {
  it('keeps a value a single shell word', () => {
    assert.equal(shellQuote('plain'), "'plain'")
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
    assert.equal(shellQuote('a b\tc'), "'a b\tc'")
    assert.equal(shellQuote('$(id); rm -rf /'), "'$(id); rm -rf /'")
    assert.throws(() => shellQuote('bad\0value'), /NUL/)
  })
})

describe('sshArgv', () => {
  it('is non-interactive and bounded', () => {
    const argv = sshArgv({ host: 'dev.lan' }, 'true', { connectTimeoutMs: 9_500 })
    assert.deepEqual(argv.slice(0, 3), ['ssh', '-T', '-o'])
    assert.ok(argv.includes('BatchMode=yes'))
    assert.ok(argv.includes('ConnectTimeout=10'))
    assert.ok(!argv.some(value => value.includes('PasswordAuthentication=yes')))
    assert.equal(argv.at(-2), 'dev.lan')
    assert.equal(argv.at(-1), 'true')
  })

  it('passes identity, jump host, user, and port as options before the target', () => {
    const argv = sshArgv({ host: 'dev.lan', user: 'alice', port: 2222, identityFile: '/home/alice/.ssh/id_ed25519', proxyJump: 'bastion.lan' }, 'true', { connectTimeoutMs: 5_000 })
    const start = argv.indexOf('-p')
    assert.deepEqual(argv.slice(start), ['-p', '2222', '-i', '/home/alice/.ssh/id_ed25519', '-J', 'bastion.lan', '-l', 'alice', '--', 'dev.lan', 'true'])
  })

  it('refuses a host that would become an option', () => {
    assert.throws(() => sshArgv({ host: '-oProxyCommand=evil' }, 'true', { connectTimeoutMs: 1_000 }), /must not start with -/)
  })
})

describe('remoteTaskCommand', () => {
  it('never places user text in the command line', () => {
    const command = remoteTaskCommand({ host: 'h', profile: 'headless', dsh: 'dsh', shell: 'bash' })
    assert.equal(command, `'bash' -lc ${shellQuote(`exec ${['dsh', '--profile', 'headless', '--json'].map(shellQuote).join(' ')}`)}`)
  })

  it('rejects a session id that could leave the argument', () => {
    assert.throws(() => remoteTaskCommand({ host: 'h', profile: 'headless', dsh: 'dsh', shell: 'bash' }, 'session-1; rm -rf /'), /sessionId/)
    assert.doesNotThrow(() => remoteTaskCommand({ host: 'h', profile: 'headless', dsh: 'dsh', shell: 'bash' }, 'session-abc_1'))
  })

  it('quotes the working directory and can skip the login shell', () => {
    const command = remoteTaskCommand({ host: 'h', profile: 'headless', dsh: '/opt/dsh', shell: '', cwd: "/tmp/a b'c" })
    assert.equal(command, `cd -- ${shellQuote("/tmp/a b'c")} && exec ${shellQuote('/opt/dsh')} ${shellQuote('--profile')} ${shellQuote('headless')} ${shellQuote('--json')}`)
  })
})

describe('probe output parsing', () => {
  it('reads tab-separated facts and ignores noise', () => {
    const facts = parseProbeOutput('Warning: something\nprobe\tversion\tdsh 0.2.1\nprobe\tos\tLinux 6.1\nprobe\tpath\t/usr/bin/dsh\nprobe\tprofile\tpresent\n')
    assert.equal(facts.version, 'dsh 0.2.1')
    assert.equal(facts.os, 'Linux 6.1')
    assert.equal(facts.dshPath, '/usr/bin/dsh')
    assert.equal(facts.profile, 'present')
  })
})

describe('real shell execution', { skip: hasBash ? false : 'bash is unavailable' }, () => {
  it('runs the probe script and yields parseable facts', async () => {
    const command = remoteProbeCommand({ host: 'h', profile: 'headless', dsh: 'node', shell: 'bash' })
    const stdout = execFileSync('bash', ['-c', command], { encoding: 'utf8' })
    const facts = parseProbeOutput(stdout)
    assert.match(facts.version ?? '', /^v\d+\./)
    assert.equal(facts.profile, 'missing')
    assert.ok(facts.cwd)
  })

  it('delivers the prompt over stdin and parses the remote event stream', async () => {
    const dir = await workdir()
    const fake = join(dir, 'fake-dsh')
    await writeFile(fake, `#!${process.execPath}
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString('utf8')
const args = process.argv.slice(2)
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-remote-1', cwd: process.cwd() }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'text', text: 'working' }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'final', text: 'answer:' + prompt.trim() + ';args:' + args.join(',') }) + '\\n')
`)
    await chmod(fake, 0o755)
    const command = remoteTaskCommand({ host: 'h', profile: 'headless', dsh: fake, shell: 'bash' })
    const stdout = execFileSync('bash', ['-c', command], { input: 'list the files\n', encoding: 'utf8' })
    const parser = createTaskParser()
    parser.push(stdout)
    const result = parser.finish({ exitCode: 0, aborted: false })
    assert.equal(result.status, 'completed')
    assert.equal(result.sessionId, 'session-remote-1')
    assert.equal(result.answer, 'answer:list the files;args:--profile,headless,--json')
  })
})

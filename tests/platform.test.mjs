import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  askpassEnv,
  encodePowerShell,
  parseProbeOutput,
  powershellCommand,
  psQuote,
  shellQuote,
  sshArgv,
  windowsProbeCommand,
  windowsTaskCommand,
  taskCommand,
  probeCommand,
} from '../index.js'

const windows = { host: 'win.lan', user: '95744', profile: 'headless', dsh: 'dsh', shell: 'bash' }

/** 解回 PowerShell 脚本，便于校验编码后的内容。 / Decode back into the PowerShell script. */
function decodeCommand(command) {
  const base64 = command.slice(command.lastIndexOf(' ') + 1)
  return Buffer.from(base64, 'base64').toString('utf16le')
}

describe('PowerShell quoting and encoding', () => {
  it('doubles single quotes and leaves the rest literal', () => {
    assert.equal(psQuote('plain'), "'plain'")
    assert.equal(psQuote("it's"), "'it''s'")
    assert.equal(psQuote('C:\\Users\\a b'), "'C:\\Users\\a b'")
    assert.throws(() => psQuote('bad\0value'), /NUL/)
  })

  it('encodes UTF-16LE base64 that decodes back exactly', () => {
    const script = 'Write-Output "中文"\r\n'
    const decoded = Buffer.from(encodePowerShell(script), 'base64').toString('utf16le')
    assert.equal(decoded, script)
  })

  it('wraps a script in a non-interactive PowerShell invocation with ASCII only', () => {
    const command = powershellCommand('echo hi')
    assert.match(command, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/)
    assert.equal(decodeCommand(command), 'echo hi')
  })
})

describe('Windows task and probe commands', () => {
  it('changes directory, runs dsh with arguments, and forwards the exit code', () => {
    const script = decodeCommand(windowsTaskCommand({ ...windows, cwd: "C:\\Users\\a b'c" }, 'session-1'))
    assert.match(script, /Set-Location -LiteralPath 'C:\\Users\\a b''c'/)
    assert.match(script, /& 'dsh' '--profile' 'headless' '--json' '--session-id' 'session-1'/)
    assert.match(script, /exit \$LASTEXITCODE/)
  })

  it('omits the directory change when no working directory is configured', () => {
    assert.doesNotMatch(decodeCommand(windowsTaskCommand(windows)), /Set-Location/)
  })

  it('rejects a session id that could leave the argument', () => {
    assert.throws(() => windowsTaskCommand(windows, 'session-1; rm -rf /'), /sessionId/)
    assert.throws(() => windowsTaskCommand(windows, 'a b'), /sessionId/)
  })

  it('probes version, OS, dsh path, home, cwd, profile, and platform', () => {
    const script = decodeCommand(windowsProbeCommand(windows))
    for (const key of ['version', 'os', 'path', 'home', 'cwd', 'profile', 'platform']) {
      assert.match(script, new RegExp(`probe\\$\\{t\\}${key}\\$\\{t\\}`))
    }
    assert.match(script, /\$dsh = 'dsh'/)
  })

  it('dispatches by platform', () => {
    assert.match(taskCommand(windows, 'windows'), /^powershell /)
    assert.match(taskCommand(windows, 'posix'), /^'bash' -lc /)
    assert.match(probeCommand(windows, 'windows'), /^powershell /)
    assert.match(probeCommand(windows, 'posix'), /^'bash' -lc /)
  })
})

describe('authentication modes', () => {
  it('keeps key mode non-interactive and pins a first-seen host key', () => {
    const argv = sshArgv({ host: 'h' }, 'true', { connectTimeoutMs: 5_000 })
    assert.ok(argv.includes('BatchMode=yes'))
    assert.ok(argv.includes('StrictHostKeyChecking=accept-new'))
    assert.ok(!argv.includes('BatchMode=no'))
  })

  it('allows exactly one password prompt in password mode', () => {
    const argv = sshArgv({ host: 'h' }, 'true', { connectTimeoutMs: 5_000, auth: 'password' })
    assert.ok(argv.includes('BatchMode=no'))
    assert.ok(argv.includes('PubkeyAuthentication=no'))
    assert.ok(argv.includes('PreferredAuthentications=password,keyboard-interactive'))
    assert.ok(argv.includes('NumberOfPasswordPrompts=1'))
    assert.ok(!argv.includes('BatchMode=yes'))
  })

  it('points ssh at the askpass helper without carrying the password', () => {
    const env = askpassEnv('/tmp/x/askpass.sh')
    assert.equal(env.SSH_ASKPASS, '/tmp/x/askpass.sh')
    assert.equal(env.SSH_ASKPASS_REQUIRE, 'force')
    assert.equal('DSH_REMOTE_PASSWORD' in env, false)
  })
})

describe('platform facts', () => {
  it('reads the platform line and defaults to undefined when absent', () => {
    assert.equal(parseProbeOutput('probe\tplatform\twindows\n').platform, 'windows')
    assert.equal(parseProbeOutput('probe\tplatform\tposix\n').platform, 'posix')
    assert.equal(parseProbeOutput('probe\tversion\tdsh 1\n').platform, undefined)
  })
})

describe('existing POSIX behaviour', () => {
  it('still quotes a task command exactly as before', () => {
    assert.equal(
      taskCommand({ host: 'h', profile: 'headless', dsh: 'dsh', shell: '' }, 'posix'),
      `exec ${shellQuote('dsh')} ${shellQuote('--profile')} ${shellQuote('headless')} ${shellQuote('--json')}`,
    )
  })
})

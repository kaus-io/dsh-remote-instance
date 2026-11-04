import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { decompressFrames, historyCommand, parseSessionLog } from '../index.js'

const line = value => `${JSON.stringify(value)}\n`

const log = [
  line({ type: 'session', version: 4, id: 'session-1', createdAt: 1_700_000_000_000, cwd: '/work/antares-os' }),
  line({ type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } }),
  line({ type: 'user/message', seq: 2, time: 110, data: { content: [{ type: 'text', text: '部署到墨水屏' }] } }),
  line({ type: 'assistant/message', seq: 3, time: 120, data: { message: { content: [{ type: 'reasoning', text: '先看板子' }, { type: 'text', text: '好的，我查一下设备。' }] } } }),
  line({ type: 'tool/call', seq: 4, time: 130, data: { callId: 'c1', name: 'bash', arguments: '{"command":"lsusb"}' } }),
  line({ type: 'tool/result', seq: 5, time: 140, data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } }),
  line({ type: 'unknown/event', seq: 6, time: 150, data: {} }),
].join('')

describe('parseSessionLog', () => {
  it('reads the header and turns v4 events into messages', () => {
    const parsed = parseSessionLog(log)
    assert.equal(parsed.sessionId, 'session-1')
    assert.equal(parsed.cwd, '/work/antares-os')
    assert.equal(parsed.createdAt, 1_700_000_000_000)
    assert.deepEqual(parsed.messages.map(message => message.role), ['user', 'thought', 'assistant', 'tool'])
    assert.equal(parsed.messages[0].text, '部署到墨水屏')
    assert.equal(parsed.messages[1].text, '先看板子')
    assert.equal(parsed.messages[2].text, '好的，我查一下设备。')
    assert.equal(parsed.messages[3].status, 'done')
    assert.equal(parsed.events, 7)
  })

  it('ignores malformed lines instead of failing the whole history', () => {
    const parsed = parseSessionLog(`${log}not json\n{"type":"user/message","seq":9,"data":{"content":[{"type":"text","text":"after"}]}}\n`)
    assert.equal(parsed.messages.at(-1).text, 'after')
  })
})

describe('decompressFrames', () => {
  it('decodes concatenated zstd frames', () => {
    const first = zstdCompressSync(Buffer.from('{"a":1}\n'))
    const second = zstdCompressSync(Buffer.from('{"b":2}\n'))
    assert.equal(decompressFrames(Buffer.concat([first, second])), '{"a":1}\n{"b":2}\n')
  })

  it('drops a damaged trailing frame but keeps the good ones', () => {
    const good = zstdCompressSync(Buffer.from('{"a":1}\n'))
    const broken = Buffer.concat([zstdCompressSync(Buffer.from('{"b":2}\n')).subarray(0, 8)])
    assert.equal(decompressFrames(Buffer.concat([good, broken])), '{"a":1}\n')
  })

  it('rejects a payload with no frame at all', () => {
    assert.throws(() => decompressFrames(Buffer.from('plain text')), /no zstd frame/)
  })
})

describe('historyCommand', () => {
  it('builds a fixed POSIX read and rejects unsafe session ids', () => {
    const command = historyCommand('posix', undefined, 'session-1')
    assert.match(command, /find "\$home\/sessions" -mindepth 2 -maxdepth 2 -type d -name 'session-1'/)
    assert.match(command, /base64/)
    assert.throws(() => historyCommand('posix', undefined, 'x; rm -rf /'), /sessionId/)
  })

  it('uses a PowerShell read on Windows', () => {
    const command = historyCommand('windows', 'C:\\Users\\a', 'session-1')
    assert.match(command, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand /)
  })
})

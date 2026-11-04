import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTaskParser } from '../index.js'

const line = value => `${JSON.stringify(value)}\n`

describe('createTaskParser', () => {
  it('uses the terminal final event as the answer and streams committed text', () => {
    const parser = createTaskParser()
    const updates = parser.push(
      line({ type: 'session', sessionId: 'session-1', cwd: '/work' })
      + line({ type: 'status', phase: 'turn_start', turn: 1 })
      + line({ type: 'text', text: 'hello ' })
      + line({ type: 'text', text: 'world' })
      + line({ type: 'final', text: 'hello world' }),
    )
    assert.deepEqual(updates.filter(update => update.kind === 'progress').map(update => update.text), ['session session-1', 'turn 1'])
    assert.deepEqual(updates.filter(update => update.kind === 'log').map(update => update.text), ['hello ', 'world'])
    assert.deepEqual(parser.finish({ exitCode: 0, aborted: false }), { status: 'completed', answer: 'hello world', sessionId: 'session-1', toolCalls: 0 })
  })

  it('falls back to plain stdout when the remote dsh has no --json support', () => {
    const parser = createTaskParser()
    parser.push('plain answer line 1\nline 2\n')
    const result = parser.finish({ exitCode: 0, aborted: false })
    assert.equal(result.status, 'completed')
    assert.equal(result.answer, 'plain answer line 1\nline 2')
    assert.equal(result.sessionId, undefined)
  })

  it('reassembles events split across chunks and keeps a partial line for finish', () => {
    const parser = createTaskParser()
    const first = parser.push('{"type":"final","text":"split')
    assert.deepEqual(first, [])
    parser.push(' answer"}\n')
    assert.equal(parser.finish({ exitCode: 0, aborted: false }).answer, 'split answer')
    const trailing = createTaskParser()
    trailing.push('{"type":"final","text":"no newline"}')
    assert.equal(trailing.finish({ exitCode: 0, aborted: false }).answer, 'no newline')
  })

  it('reports an error event as a failed run', () => {
    const parser = createTaskParser()
    const updates = parser.push(line({ type: 'error', message: 'no API key' }))
    assert.equal(updates.some(update => update.kind === 'error'), true)
    const result = parser.finish({ exitCode: 1, aborted: false })
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /no API key/)
  })

  it('reports a non-zero exit without an error event using stderr', () => {
    const parser = createTaskParser()
    parser.push(line({ type: 'session', sessionId: 'session-2' }))
    const result = parser.finish({ exitCode: 255, aborted: false, stderr: 'ssh: connect to host dev.lan port 22: Connection refused' })
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /Connection refused/)
  })

  it('reports cancellation as killed regardless of the exit code', () => {
    const parser = createTaskParser()
    parser.push(line({ type: 'text', text: 'partial' }))
    const result = parser.finish({ exitCode: null, aborted: true })
    assert.equal(result.status, 'killed')
  })

  it('counts tool calls and surfaces failed tool results', () => {
    const parser = createTaskParser()
    const updates = parser.push(
      line({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'ls' } })
      + line({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' })
      + line({ type: 'tool_call', callId: 'c2', tool: 'read', input: { path: '/nope' } })
      + line({ type: 'tool_result', callId: 'c2', status: 'error', result: 'EACCES' })
      + line({ type: 'final', text: 'done' }),
    )
    assert.equal(updates.filter(update => update.kind === 'log').length, 2)
    assert.equal(updates.filter(update => update.kind === 'error').length, 1)
    assert.equal(parser.finish({ exitCode: 0, aborted: false }).toolCalls, 2)
  })

  it('caps a runaway answer instead of growing without bound', () => {
    const parser = createTaskParser()
    parser.push(line({ type: 'final', text: 'x'.repeat(400_000) }))
    assert.equal(parser.finish({ exitCode: 0, aborted: false }).answer.length, 200_000)
  })
})

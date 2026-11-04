import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AcpClient } from '../index.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 一个可手动喂给客户端的行通道。 / A line channel the test feeds by hand. */
function channel() {
  const lines = []
  let wake = null
  let ended = false
  return {
    push(line) { lines.push(line); wake?.(); wake = null },
    end() { ended = true; wake?.(); wake = null },
    async *iterate() {
      while (true) {
        if (lines.length > 0) { yield lines.shift(); continue }
        if (ended) return
        await new Promise(resolve => { wake = resolve })
      }
    },
  }
}

/** 记录出站帧、按需回帧的连接。 / A transport capturing outbound frames and replying on demand. */
function harness(handler) {
  const inbound = channel()
  const sent = []
  const tools = {
    reply: (id, result) => inbound.push(JSON.stringify({ jsonrpc: '2.0', id, result })),
    fail: (id, message) => inbound.push(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })),
    notify: (method, params) => inbound.push(JSON.stringify({ jsonrpc: '2.0', method, params })),
    request: (id, method, params) => inbound.push(JSON.stringify({ jsonrpc: '2.0', id, method, params })),
  }
  // closed 在连接结束时兑现，dispose 才不会等满兜底超时。 / closed settles on teardown so dispose does not wait for its fallback.
  let settleClosed
  const closed = new Promise(resolve => { settleClosed = resolve })
  const transport = {
    stdin: {
      write(text) {
        const message = JSON.parse(text)
        sent.push(message)
        handler(message, tools)
      },
      end() { inbound.end() },
    },
    lines: inbound.iterate(),
    closed,
    terminate() { inbound.end(); settleClosed() },
  }
  return { transport, sent, ...tools }
}

/** 只应答 initialize。 / Answer the handshake only. */
const ready = (message, tools) => {
  if (message.method === 'initialize') tools.reply(message.id, { protocolVersion: 1 })
}

describe('AcpClient', () => {
  it('handshakes, lists sessions, and drops malformed rows', async () => {
    const { transport } = harness((message, tools) => {
      ready(message, tools)
      if (message.method === 'session/list') {
        tools.reply(message.id, {
          sessions: [
            { sessionId: 's-1', cwd: '/work/a', title: 'alpha', updatedAt: '2026-11-05T00:00:00Z' },
            { sessionId: 's-2', cwd: '/work/b' },
            { sessionId: 's-3' },
            null,
          ],
        })
      }
    })
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000 })
    assert.deepEqual(await client.listSessions(), [
      { sessionId: 's-1', cwd: '/work/a', title: 'alpha', updatedAt: '2026-11-05T00:00:00Z' },
      { sessionId: 's-2', cwd: '/work/b' },
    ])
    await client.dispose()
  })

  it('opens a session and posts a text prompt with the exact ACP shape', async () => {
    const { transport, sent } = harness((message, tools) => {
      ready(message, tools)
      if (message.method === 'session/new') tools.reply(message.id, { sessionId: 's-new' })
      if (message.method === 'session/prompt') tools.reply(message.id, { stopReason: 'end_turn' })
    })
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000 })
    assert.equal(await client.newSession('/work/a'), 's-new')
    assert.deepEqual(await client.prompt('s-new', 'hello'), { stopReason: 'end_turn' })
    assert.deepEqual(sent.find(message => message.method === 'session/prompt').params, {
      sessionId: 's-new',
      prompt: [{ type: 'text', text: 'hello' }],
    })
    assert.equal(sent.find(message => message.method === 'session/new').params.cwd, '/work/a')
    await client.dispose()
  })

  it('resumes an inactive session before its first prompt, once', async () => {
    const { transport, sent } = harness((message, tools) => {
      ready(message, tools)
      if (message.method === 'session/resume') tools.reply(message.id, {})
      if (message.method === 'session/prompt') tools.reply(message.id, { stopReason: 'end_turn' })
    })
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000 })
    await client.prompt('s-1', 'one')
    await client.prompt('s-1', 'two')
    assert.equal(sent.filter(message => message.method === 'session/resume').length, 1)
    await client.dispose()
  })

  it('folds session/update notifications into the callback', async () => {
    const updates = []
    const { transport, notify } = harness((message, tools) => ready(message, tools))
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000, onUpdate: event => updates.push(event) })
    notify('session/update', { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } })
    await sleep(20)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].sessionId, 's-1')
    assert.equal(updates[0].update.sessionUpdate, 'agent_message_chunk')
    await client.dispose()
  })

  it('answers a permission request with an allow_once option', async () => {
    const { transport, request, sent } = harness((message, tools) => ready(message, tools))
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000, onPermission: () => 'allow' })
    request(900, 'session/request_permission', {
      sessionId: 's-1',
      toolCall: { title: 'run a command' },
      options: [
        { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
      ],
    })
    await sleep(20)
    const answer = sent.find(message => message.id === 900)
    assert.deepEqual(answer.result, { outcome: { outcome: 'selected', optionId: 'a1' } })
    await client.dispose()
  })

  it('answers a permission request with reject_once when the policy denies', async () => {
    const { transport, request, sent } = harness((message, tools) => ready(message, tools))
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000, onPermission: () => 'deny' })
    request(901, 'session/request_permission', {
      sessionId: 's-1',
      toolCall: { title: 'run a command' },
      options: [
        { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
      ],
    })
    await sleep(20)
    assert.deepEqual(sent.find(message => message.id === 901).result, { outcome: { outcome: 'selected', optionId: 'r1' } })
    await client.dispose()
  })

  it('answers an unsupported agent request with method-not-found', async () => {
    const { transport, request, sent } = harness((message, tools) => ready(message, tools))
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000 })
    request(902, 'fs/read_text_file', { path: '/etc/passwd' })
    await sleep(20)
    assert.equal(sent.find(message => message.id === 902).error.code, -32601)
    await client.dispose()
  })

  it('sends session/cancel as a notification', async () => {
    const { transport, sent } = harness((message, tools) => ready(message, tools))
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000 })
    await client.cancel('s-1')
    const cancel = sent.find(message => message.method === 'session/cancel')
    assert.equal(cancel.id, undefined)
    assert.deepEqual(cancel.params, { sessionId: 's-1' })
    await client.dispose()
  })

  it('reports a JSON-RPC error as a rejection', async () => {
    const { transport } = harness((message, tools) => {
      ready(message, tools)
      if (message.method === 'session/list') tools.fail(message.id, 'session list unavailable')
    })
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 1_000 })
    await assert.rejects(() => client.listSessions(), /session list unavailable/)
    await client.dispose()
  })

  it('times out an unanswered request', async () => {
    const { transport } = harness((message, tools) => ready(message, tools))
    const client = await AcpClient.connect(transport, { requestTimeoutMs: 40 })
    await assert.rejects(() => client.listSessions(), /timed out/)
    await client.dispose()
  })
})

/**
 * ACP（Agent Client Protocol）客户端：走 ssh 上的 JSON-RPC stdio，把远端 DSH 的会话列出来、打开并对话。
 * 协议字段以 `@agentclientprotocol/sdk` 的 schema 为准：换行分隔的 JSON-RPC 2.0。
 *
 * ACP client: JSON-RPC over the ssh stdio of a remote DSH, used to list its
 * sessions, open one, and talk to it. Frames are newline-delimited JSON-RPC
 * 2.0, matching the `@agentclientprotocol/sdk` schema.
 */

/** 远端会话摘要。 / One remote session summary. */
export interface AcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly title?: string
  readonly updatedAt?: string
}

/** 一条已解码的会话更新。 / One decoded session update. */
export interface AcpUpdate {
  readonly sessionId: string
  readonly update: Record<string, unknown>
}

/** ACP 连接对服务暴露的能力。 / The capability face the service uses. */
export interface AcpSessionClient {
  listSessions(cwd?: string): Promise<readonly AcpSession[]>
  newSession(cwd: string): Promise<string>
  resumeSession(sessionId: string, cwd?: string): Promise<void>
  prompt(sessionId: string, text: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly stopReason: string }>
  cancel(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  dispose(): Promise<void>
}

/** 一条连接的字节通道。 / The byte channel of one connection. */
export interface AcpTransport {
  readonly stdin: { write(text: string): void; end(): void }
  readonly lines: AsyncIterable<string>
  readonly closed: Promise<unknown>
  terminate(): void
}

/** 客户端选项。 / Client options. */
export interface AcpClientOptions {
  /** 单个请求的超时；prompt 自己传更长的值。 / Per-request deadline; prompt passes a longer one. */
  readonly requestTimeoutMs?: number
  /** 会话更新回调。 / Session-update callback. */
  readonly onUpdate?: (event: AcpUpdate) => void
  /** 权限请求的答复策略；缺省一律拒绝。 / Permission policy; the default rejects. */
  readonly onPermission?: (request: { readonly sessionId: string; readonly title: string; readonly options: readonly string[] }) => 'allow' | 'deny'
  /** 非致命诊断。 / Non-fatal diagnostics. */
  readonly onWarning?: (message: string) => void
}

const CLIENT_NAME = 'dsh-remote-instance'
const CLIENT_VERSION = '1.0.0'

/** 连接错误：进程退出或流关闭。 / Connection error: the process exited or the stream closed. */
export class AcpConnectionError extends Error {}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/**
 * 一条 ACP 连接。请求 id 递增，响应按 id 归位；agent 发来的请求（权限）就地答复。
 * One ACP connection. Request ids increase, responses are matched by id, and
 * agent-initiated requests (permissions) are answered in place.
 */
export class AcpClient implements AcpSessionClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly live = new Set<string>()
  private disposed = false

  private constructor(
    private readonly transport: AcpTransport,
    private readonly options: AcpClientOptions,
  ) {}

  /** 建立连接并完成 `initialize` 握手。 / Connect and complete the `initialize` handshake. */
  static async connect(transport: AcpTransport, options: AcpClientOptions = {}): Promise<AcpClient> {
    const client = new AcpClient(transport, options)
    client.read()
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    })
    return client
  }

  async listSessions(cwd?: string): Promise<readonly AcpSession[]> {
    const result = (await this.request('session/list', cwd === undefined ? {} : { cwd })) as { sessions?: unknown }
    const rows = Array.isArray(result?.sessions) ? result.sessions : []
    const sessions: AcpSession[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const source = row as Record<string, unknown>
      if (typeof source.sessionId !== 'string' || !source.sessionId) continue
      if (typeof source.cwd !== 'string' || !source.cwd) continue
      sessions.push({
        sessionId: source.sessionId,
        cwd: source.cwd,
        ...(typeof source.title === 'string' && source.title ? { title: source.title } : {}),
        ...(typeof source.updatedAt === 'string' && source.updatedAt ? { updatedAt: source.updatedAt } : {}),
      })
    }
    return sessions
  }

  async newSession(cwd: string): Promise<string> {
    const result = (await this.request('session/new', { cwd, mcpServers: [] })) as { sessionId?: unknown }
    if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new AcpConnectionError('session/new returned no session id')
    this.live.add(result.sessionId)
    return result.sessionId
  }

  async resumeSession(sessionId: string, cwd?: string): Promise<void> {
    if (this.live.has(sessionId)) return
    await this.request('session/resume', { sessionId, ...(cwd === undefined ? {} : { cwd }), mcpServers: [] })
    this.live.add(sessionId)
  }

  async prompt(sessionId: string, text: string, promptOptions: { readonly signal?: AbortSignal } = {}): Promise<{ readonly stopReason: string }> {
    await this.resumeSession(sessionId)
    const result = (await this.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text }] },
      { timeoutMs: 0, signal: promptOptions.signal },
    )) as { stopReason?: unknown }
    return { stopReason: typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn' }
  }

  async cancel(sessionId: string): Promise<void> {
    this.notify('session/cancel', { sessionId })
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.request('session/close', { sessionId })
    } finally {
      this.live.delete(sessionId)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new AcpConnectionError('the ACP connection closed'))
      this.pending.delete(id)
    }
    try { this.transport.stdin.end() } catch { /* the child may already be gone / 子进程可能已退出。 */ }
    try { this.transport.terminate() } catch { /* ignore / 忽略。 */ }
    await Promise.race([this.transport.closed, new Promise(resolve => setTimeout(resolve, 3_000))]).catch(() => undefined)
  }

  private write(message: Record<string, unknown>): void {
    if (this.disposed) throw new AcpConnectionError('the ACP connection closed')
    this.transport.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private request(method: string, params: Record<string, unknown>, options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new AcpConnectionError('the ACP connection closed'))
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000
    return new Promise<unknown>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(entry.timer)
        this.pending.delete(id)
        options.signal?.removeEventListener('abort', abort)
      }
      const entry: Pending = {
        resolve: value => { settle(); resolve(value) },
        reject: error => { settle(); reject(error) },
        timer: setTimeout(() => entry.reject(new AcpConnectionError(`ACP request timed out: ${method}`)), timeoutMs),
      }
      const abort = (): void => {
        entry.reject(new AcpConnectionError(`ACP request cancelled: ${method}`))
        try { this.notify('session/cancel', params) } catch { /* ignore / 忽略。 */ }
      }
      if (timeoutMs > 0) entry.timer.unref?.()
      else clearTimeout(entry.timer)
      this.pending.set(id, entry)
      if (options.signal?.aborted) { abort(); return }
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private read(): void {
    void (async () => {
      try {
        for await (const line of this.transport.lines) {
          if (this.disposed) break
          const text = line.trim()
          if (!text) continue
          let message: unknown
          try {
            message = JSON.parse(text)
          } catch {
            this.options.onWarning?.('ignored an ACP line that was not JSON')
            continue
          }
          if (!message || typeof message !== 'object') continue
          this.dispatch(message as Record<string, unknown>)
        }
      } catch (error) {
        if (!this.disposed) this.options.onWarning?.(`ACP stream ended: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (!this.disposed) {
          for (const [, entry] of this.pending) entry.reject(new AcpConnectionError('the ACP connection closed'))
          this.pending.clear()
        }
      }
    })()
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = typeof message.id === 'number' ? message.id : undefined
    const method = typeof message.method === 'string' ? message.method : undefined
    if (id !== undefined && method === undefined) {
      const entry = this.pending.get(id)
      if (!entry) return
      if (message.error && typeof message.error === 'object') {
        const failure = message.error as { message?: unknown; code?: unknown }
        entry.reject(new AcpConnectionError(typeof failure.message === 'string' ? failure.message : `ACP error ${String(failure.code ?? 'unknown')}`))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (method === undefined) return
    if (id !== undefined) {
      this.answer(id, method, message.params)
      return
    }
    this.notification(method, message.params)
  }

  private answer(id: number, method: string, params: unknown): void {
    if (method !== 'session/request_permission') {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported agent request: ${method}` } })
      return
    }
    const request = (params ?? {}) as Record<string, unknown>
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
    const toolCall = (request.toolCall ?? {}) as Record<string, unknown>
    const title = typeof toolCall.title === 'string' ? toolCall.title : 'tool call'
    const options = Array.isArray(request.options) ? request.options : []
    const kinds = options.map(option => (option && typeof option === 'object' ? String((option as { kind?: unknown }).kind ?? '') : ''))
    const decision = this.options.onPermission?.({ sessionId, title, options: kinds }) ?? 'deny'
    const wanted = decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
    const index = kinds.findIndex(kind => wanted.includes(kind))
    const chosen = index >= 0 ? options[index] as Record<string, unknown> : undefined
    const optionId = typeof chosen?.optionId === 'string' ? chosen.optionId : undefined
    this.write({
      jsonrpc: '2.0',
      id,
      result: optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } },
    })
  }

  private notification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const request = (params ?? {}) as Record<string, unknown>
    if (typeof request.sessionId !== 'string' || !request.update || typeof request.update !== 'object') return
    this.options.onUpdate?.({ sessionId: request.sessionId, update: request.update as Record<string, unknown> })
  }
}

/**
 * 设置面板使用的两个 HTTP 端点：读清单与显式用户操作。两者都只接受已认证浏览器 Peer，并校验同源 Origin。
 * The two HTTP endpoints the Settings panel uses: read the list, and run an
 * explicit user action. Both accept only the authenticated browser peer and
 * check the same-origin `Origin`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RemoteInstanceService } from './service.js'

/** 只读清单端点。 / The read-only list endpoint. */
export const OBSERVE_PATH = '/remote-instance/observe'
/** 显式用户操作端点。 / The explicit user-action endpoint. */
export const ACTION_PATH = '/remote-instance/action'
/** 只读端点允许的动作。 / Actions the read-only endpoint allows. */
export const UI_READ_ACTIONS = new Set(['instances'])
/** 操作端点允许的动作；探测也在这里，因为它可能写入 known_hosts 与探测缓存。 / Actions the action endpoint allows; probe sits here because it may write known_hosts and the probe cache. */
export const UI_ACTION_ACTIONS = new Set(['add', 'remove', 'probe'])
const BODY_LIMIT = 65_536

function sendJson(res: ServerResponse, status: number, value: unknown): undefined {
  if (res.writableEnded || res.destroyed) return undefined
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
  return undefined
}

function readBody(req: IncomingMessage, limit: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    const cleanup = (): void => {
      req.off('data', data); req.off('end', end); req.off('aborted', aborted)
      signal?.removeEventListener('abort', cancelled)
    }
    const finish = (failure: Error | null, value?: string): void => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) reject(failure)
      else resolve(value ?? '')
    }
    const data = (chunk: Buffer): void => {
      size += chunk.length
      if (size > limit) {
        finish(new Error('Remote instance request is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    const end = (): void => finish(null, Buffer.concat(chunks).toString('utf8'))
    const error = (failure: Error): void => finish(failure)
    const aborted = (): void => finish(new Error('Remote instance request was aborted'))
    const cancelled = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error('Remote instance request was cancelled'))
    req.on('data', data)
    req.on('end', end)
    req.on('error', error)
    req.on('aborted', aborted)
    req.once('close', () => req.off('error', error))
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
  })
}

/** 只放行已认证的浏览器 Peer；原始路由没有全局鉴权，模型/API Peer 不算人工授权。 / Only the authenticated browser peer may enter. */
function admitBrowser(service: RemoteInstanceService, req: IncomingMessage, res: ServerResponse): boolean {
  const connection = service.ctx.connection
  if (!connection?.admit || !connection.browserPeer) {
    sendJson(res, 503, { ok: false, error: 'Browser authentication is unavailable' })
    return false
  }
  const admission = connection.admit(req)
  if (admission.rejection) {
    sendJson(res, admission.rejection.status ?? 403, { ok: false, error: 'Browser authentication required' })
    return false
  }
  if (admission.peer?.id !== connection.browserPeer.id) {
    sendJson(res, 403, { ok: false, error: 'This endpoint requires the authenticated browser' })
    return false
  }
  return true
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** GUI 可能以 127.0.0.1 或 localhost 打开；其它 Origin 一律拒绝。 / The GUI may be 127.0.0.1 or localhost; any other origin is foreign. */
export function sameLoopbackOrigin(origin: string | undefined, expected: string): boolean {
  if (!origin) return true
  try {
    const actual = new URL(origin)
    const target = new URL(expected)
    if (actual.protocol !== target.protocol) return false
    if (actual.port !== target.port) return false
    return LOOPBACK_HOSTS.has(actual.hostname) && LOOPBACK_HOSTS.has(target.hostname)
  } catch {
    return false
  }
}

function envelope(raw: string): Record<string, unknown> {
  let request: unknown
  try {
    request = JSON.parse(raw)
  } catch {
    throw new Error('Invalid remote instance JSON')
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid remote instance request')
  const args = (request as { args?: unknown }).args
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('The request needs an args object')
  return args as Record<string, unknown>
}

/** 只读清单端点处理器。 / Handler for the read-only list endpoint. */
export function createObserveHandler(service: RemoteInstanceService, originOf: () => string) {
  return async function observe(req: IncomingMessage, res: ServerResponse): Promise<undefined> {
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('Client closed the remote instance observation')) })
    try {
      if (req.method !== 'POST') throw new Error('Remote instance observation requires POST')
      // 先认证再谈请求头：未认证的调用不能借错误码探测路由细节。 / Authenticate first, then inspect headers.
      if (!admitBrowser(service, req, res)) return undefined
      if (req.headers['x-ri-observe'] !== '1') throw new Error('Missing remote instance observation header')
      const origin = originOf()
      if (origin && !sameLoopbackOrigin(req.headers.origin, origin)) throw new Error('Foreign origin')
      const args = envelope(await readBody(req, BODY_LIMIT, controller.signal))
      if (!UI_READ_ACTIONS.has(String(args.action))) throw new Error('This remote instance observation is not read-only')
      const value = await service.execute(args, { source: 'ui', signal: controller.signal })
      return sendJson(res, 200, { ok: true, value })
    } catch (error) {
      if (res.writableEnded || res.destroyed) return undefined
      return sendJson(res, 400, { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4_000) })
    }
  }
}

/** 显式用户操作端点处理器。 / Handler for the explicit user-action endpoint. */
export function createActionHandler(service: RemoteInstanceService, originOf: () => string) {
  return async function action(req: IncomingMessage, res: ServerResponse): Promise<undefined> {
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('Client closed the remote instance action')) })
    try {
      if (req.method !== 'POST') throw new Error('Remote instance action requires POST')
      // 先认证再校验请求头与 Origin。 / Authenticate before header and origin checks.
      if (!admitBrowser(service, req, res)) return undefined
      if (req.headers['x-ri-action'] !== '1') throw new Error('Missing remote instance action header')
      if ((req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new Error('Remote instance action requires JSON')
      if (!req.headers.origin) throw new Error('Missing remote instance action origin')
      const origin = originOf()
      if (origin && !sameLoopbackOrigin(req.headers.origin, origin)) throw new Error('Foreign origin')
      const args = envelope(await readBody(req, BODY_LIMIT, controller.signal))
      if (!UI_ACTION_ACTIONS.has(String(args.action))) throw new Error('This action is not available from the Settings panel')
      const value = await service.execute(args, { source: 'ui', signal: controller.signal })
      return sendJson(res, 200, { ok: true, value })
    } catch (error) {
      if (res.writableEnded || res.destroyed) return undefined
      return sendJson(res, 400, { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4_000) })
    }
  }
}

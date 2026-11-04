/**
 * 托管子进程运行器：始终通过 Harness 的 `ctx.subprocess` 启动，绝不经过本地 shell，并在取消或超时时等待整棵进程树退出。
 * Managed process runner: always spawned through Harness `ctx.subprocess`,
 * never through a local shell, and it waits for the whole process range on
 * cancellation or deadline.
 */
import { StringDecoder } from 'node:string_decoder'
import type { SubprocessHandle, SubprocessRuntime } from './contracts.js'

/** 一次运行的可选项。 / Options for one run. */
export interface RunOptions {
  readonly signal?: AbortSignal
  readonly stdin?: string
  readonly timeoutMs?: number
  /** 显式环境；密码认证的 askpass 变量在这里注入。 / Explicit environment carrying the askpass variables. */
  readonly env?: Record<string, string>
  readonly onOutput?: (chunk: { readonly stream: 'stdout' | 'stderr'; readonly text: string }) => void
}

/** 一次运行的收尾事实。 / The facts one run settles with. */
export interface RunResult {
  readonly exitCode: number | null
  readonly signal?: string | null
  readonly stdout: string
  readonly stderr: string
}

/** 运行器签名；测试注入替身，生产走托管 provider。 / Runner signature; tests inject a double. */
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>

/**
 * 创建运行器。stdout/stderr 边读边回调，同时保留有界尾部；超时与取消都会终止整个进程范围。
 * Create the runner. stdout/stderr stream to the callback while a bounded tail
 * is retained; both the deadline and cancellation terminate the range.
 */
export function createRunner(subprocess: SubprocessRuntime, options: { readonly active?: Set<SubprocessHandle>; readonly maxOutput?: number } = {}): Runner {
  const active = options.active ?? new Set<SubprocessHandle>()
  const maxOutput = Math.min(Math.max(options.maxOutput ?? 262_144, 4_096), 4_194_304)
  return async function run(argv, runOptions = {}) {
    const { signal, stdin, timeoutMs = 120_000, onOutput, env } = runOptions
    signal?.throwIfAborted()
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string' || value.includes('\0'))) {
      throw new Error('Invalid process argv')
    }
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('Remote process deadline exceeded'))
    }, Math.min(Math.max(timeoutMs, 1_000), 86_400_000))
    timer.unref?.()
    let child: SubprocessHandle | undefined
    try {
      const executable = await subprocess.resolveExecutable(argv[0], undefined, controller.signal)
      child = subprocess.spawn({
        argv: [executable, ...argv.slice(1)],
        ...(env === undefined ? {} : { env }),
        signal: controller.signal,
        graceMs: 3_000,
        stdio: { stdin: stdin === undefined ? 'ignore' : { data: stdin }, stdout: 'pipe', stderr: 'pipe' },
      })
      active.add(child)
      const outputs: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
      const readers = (['stdout', 'stderr'] as const).map(async stream => {
        const source = child?.[stream]
        const decoder = new StringDecoder('utf8')
        const consume = (text: string) => {
          if (!text) return
          outputs[stream] = (outputs[stream] + text).slice(-maxOutput)
          onOutput?.({ stream, text })
        }
        try {
          if (source) for await (const bytes of source) consume(decoder.write(Buffer.from(bytes)))
          consume(decoder.end())
        } catch (error) {
          child?.terminate()
          throw error
        }
      })
      // 无论成功或失败都先把 stdout/stderr 和进程读完。 / Drain streams and the process even on failure.
      const settled = await Promise.allSettled([child.done, ...readers])
      const rejected = settled.find(item => item.status === 'rejected')
      if (rejected && rejected.status === 'rejected') throw rejected.reason
      if (timedOut) throw new Error(`Remote process timed out after ${timeoutMs} ms`)
      signal?.throwIfAborted()
      const outcome = settled[0].status === 'fulfilled' ? settled[0].value : { exitCode: null }
      return { exitCode: outcome.exitCode, signal: outcome.signal, stdout: outputs.stdout, stderr: outputs.stderr }
    } finally {
      // 托管范围必须确认静默退出后才算结束。 / Wait for the whole managed range to quiesce.
      try {
        if (child) await child.waitForExit()
        if (timedOut) throw new Error(`Remote process timed out after ${timeoutMs} ms`)
        signal?.throwIfAborted()
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', forwardAbort)
        if (child) active.delete(child)
      }
    }
  }
}

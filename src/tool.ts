/**
 * `remote_instance` 的模型面：动作集合、参数字段、严格校验与工具描述。
 * The model-facing `remote_instance` surface: action set, parameter fields,
 * strict validation, and the tool description.
 */

/** 全部动作；只读动作不索取审批。 / Every action; read-only actions need no approval. */
export const ACTIONS = ['instances', 'add', 'remove', 'probe', 'ask', 'jobs', 'status', 'cancel'] as const
/** 只读动作。 / Read-only actions. */
export const READ_ACTIONS = new Set<string>(['instances', 'probe', 'jobs', 'status'])
/** 会改动本地清单或触发远程执行的动作。 / Actions that mutate the list or start remote work. */
export const NATIVE_ACTIONS = new Set<string>(['add', 'remove', 'ask'])

export type Action = (typeof ACTIONS)[number]

const FIELDS: Record<string, { readonly type: 'string' | 'integer' | 'boolean'; readonly enum?: readonly string[]; readonly description: string }> = {
  action: {
    type: 'string',
    enum: ACTIONS,
    description: 'instances lists registered devices with their last probe; add/remove edit the device list; probe checks ssh reachability, remote dsh version, and the profile directory; ask dispatches a task to the remote DSH agent as a background job; jobs lists this session’s remote jobs; status/cancel use a jobId.',
  },
  name: { type: 'string', description: 'Device name from instances, e.g. laptop. Required by remove/probe/ask; `add` creates or replaces it and derives a name from the host when omitted.' },
  host: { type: 'string', description: 'For add: remote host name, IP address, or ssh config alias. Never a URL.' },
  user: { type: 'string', description: 'For add: ssh login name. Omit to let ssh config decide.' },
  port: { type: 'integer', description: 'For add: ssh port, 1-65535. Omit for the ssh default.' },
  identityFile: { type: 'string', description: 'For add: absolute path to a local private key for `ssh -i`. Omit to let ssh config and the agent decide. Key contents are never read.' },
  proxyJump: { type: 'string', description: 'For add: `ssh -J` jump target as [user@]host[:port].' },
  profile: { type: 'string', description: 'For add: remote dsh profile to run, default headless. That profile must exist on the remote device.' },
  dsh: { type: 'string', description: 'For add: remote dsh executable name or absolute path, default dsh. Use an absolute path when a login shell cannot see it.' },
  shell: { type: 'string', description: 'For add: login shell that wraps the remote command, default bash; an empty string runs it directly.' },
  cwd: { type: 'string', description: 'For add: remote working directory for dispatched tasks. Default is the ssh login directory.' },
  note: { type: 'string', description: 'For add: short human note shown in the Settings panel.' },
  password: { type: 'string', description: 'For add: the ssh password for this device. Stored in a 0600 file beside the device list and never returned; prefer the Settings panel, because a tool argument is recorded in the conversation log.' },
  prompt: { type: 'string', description: 'For ask: the task text handed to the remote DSH agent. It travels over stdin, never inside a shell command line.' },
  sessionId: { type: 'string', description: 'For ask: continue an existing remote dsh session id instead of starting a fresh one.' },
  jobId: { type: 'string', description: 'For status/cancel: the jobId returned by ask or listed by jobs.' },
  from: { type: 'integer', description: 'For status: output byte cursor; default 0. Continue with output.next.' },
}

export const parameters = {
  type: 'object',
  properties: Object.fromEntries(Object.entries(FIELDS).map(([key, spec]) => [key, {
    type: spec.type,
    ...(spec.enum === undefined ? {} : { enum: spec.enum }),
    description: spec.description,
  }])),
  required: ['action'],
  additionalProperties: false,
}

export const TOOL_DESCRIPTION = [
  'Connect to other devices’ DSH instances over SSH and dispatch work to them.',
  'Each registered instance is a device running dsh on Linux, macOS, or Windows; ask hands one prompt to that device’s DSH agent (dsh --profile <profile> --json) and streams its progress as an ordinary background job, so several instances and several tasks can run in parallel.',
  'instances lists devices, add/remove edit the list, probe checks ssh reachability plus remote dsh version and profile directory, ask starts a job, and jobs/status/cancel track or stop that job.',
  'The prompt is piped over stdin, so no task text reaches a remote shell command line. add/remove/ask are native operations and need Full Access or a one-shot user approval; read-only actions do not.',
  'Authentication is either a password (stored in a 0600 file beside the list, answered by SSH_ASKPASS, never placed in argv or a log) or a key from ssh config or an ssh-agent. A first-seen host key is accepted on the first connection and pinned; a changed key still fails.',
].join(' ')

/**
 * 校验一次工具请求：未知字段、类型、长度和控制字符全部拒绝。
 * Validate one tool request: unknown fields, wrong types, over-long values, and
 * control characters are all rejected.
 */
export function validateRequest(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A remote instance request must be an object')
  const source = input as Record<string, unknown>
  if (typeof source.action !== 'string' || !(ACTIONS as readonly string[]).includes(source.action)) throw new Error('Unknown remote instance action')
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const spec = FIELDS[key]
    if (!spec) throw new Error('Unknown remote instance request field')
    if (spec.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== spec.type) throw new Error(`Invalid remote instance field: ${key}`)
    if (typeof value === 'string' && (value.length > 65_536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new Error(`Invalid remote instance field: ${key}`)
    result[key] = value
  }
  return result
}

/** 审批理由里的一行摘要，不含 prompt 正文。 / One-line approval summary that never contains the prompt body. */
export function approvalSubject(args: Record<string, unknown>): string {
  if (args.action === 'ask') return `ask ${String(args.name)}${args.sessionId ? ` session=${String(args.sessionId)}` : ''}`
  if (args.action === 'add') return `add ${String(args.name)} -> ${String(args.user ?? '')}${String(args.user) ? '@' : ''}${String(args.host)}${args.port ? `:${String(args.port)}` : ''}`
  return `${String(args.action)} ${String(args.name)}`
}

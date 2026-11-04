/**
 * 设置面板的「远程实例」分区：登记设备、探测连通性、移除设备。数据全部来自 Host 的两个鉴权端点。
 * The "Remote Instance" Settings section: register devices, probe them, and
 * remove them. All data comes from the Host's two authenticated endpoints.
 *
 * 视觉只使用 `--dsw-alias-*` / `--dsw-font-*` / `--dsw-radius-*` / `--dsw-focus-ring-*` 令牌，明暗主题随宿主。
 * Visuals use only the host's design tokens, so light and dark follow the host.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactElement, ReactNode } from 'react'

/** 本插件的词典命名空间。 / Dictionary namespace owned by this plugin. */
const NS = 'remoteInstance'
/** 样式标签身份；一个已安装代次一个标签。 / Stable style-tag identity. */
const STYLE_ID = '@kaus-io/dsh-remote-instance/RemoteInstances.css'
const OBSERVE_PATH = '/remote-instance/observe'
const ACTION_PATH = '/remote-instance/action'
const ARM_TIMEOUT_MS = 3_000

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** 最近一次探测的展示字段。 / Display fields of the latest probe. */
interface ProbeView {
  readonly at: number
  readonly ok: boolean
  readonly version?: string
  readonly os?: string
  readonly message?: string
}

/** 一台已登记设备的展示字段。 / Display fields of one registered device. */
interface InstanceView {
  readonly name: string
  readonly target: string
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly identityFile?: string
  readonly proxyJump?: string
  readonly profile: string
  readonly dsh: string
  readonly shell: string
  readonly auth?: 'password' | 'key'
  readonly platform?: 'posix' | 'windows'
  readonly cwd?: string
  readonly note?: string
  readonly lastProbe?: ProbeView
}

/** 表单草稿；端口保留字符串以便区分留空。 / Form draft; the port stays a string so blank is distinguishable. */
interface Draft {
  readonly name: string
  readonly host: string
  readonly user: string
  readonly port: string
  readonly profile: string
  readonly cwd: string
  readonly note: string
  readonly identityFile: string
  readonly proxyJump: string
  readonly dsh: string
  readonly shell: string
  readonly password: string
}

const EMPTY_DRAFT: Draft = {
  name: '', host: '', user: '', port: '', profile: 'headless', cwd: '', note: '', identityFile: '', proxyJump: '', dsh: 'dsh', shell: 'bash', password: '',
}

/** 面板从 `inject` 拿到的 Host 访问方式。 / Host access handed to the panel through `inject`. */
interface PanelApi {
  read(args: Record<string, unknown>, sessionId?: string): Promise<unknown>
  act(args: Record<string, unknown>, sessionId?: string): Promise<unknown>
}

interface SectionProps {
  readonly t: Translate
  readonly api: PanelApi
}

/** 本插件用到的 Client 服务。 / Client services this plugin uses. */
interface ClientContext {
  effect(factory: () => (() => void) | void, label?: string): void
  locale: {
    register(namespace: string, dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> }): () => void
    bind(namespace: string): Translate
  }
  slots: {
    inject(key: string, callback: () => () => void): void
    register(options: Record<string, unknown>, component: (props: SectionProps) => ReactElement): () => void
  }
}

const ZH: Record<string, string> = {
  nav: '远程实例',
  title: '远程实例',
  subtitle: '通过 SSH 使用其他设备上的 DSH：登记设备后，agent 可以调用 remote_instance 把任务并行派发给远程 agent。',
  refresh: '刷新',
  devices: '已登记设备',
  empty: '还没有设备。用下面的表单登记，或让 agent 调用 remote_instance。',
  addTitle: '登记设备',
  replaceHint: '名字已存在时会替换该设备。',
  fieldName: '名字',
  fieldHost: '主机',
  fieldUser: '用户',
  fieldPort: '端口',
  fieldProfile: '远程 profile',
  fieldCwd: '工作目录',
  fieldNote: '备注',
  fieldPassword: '密码',
  hintPassword: '用于 ssh 密码登录；留空表示沿用已保存的密码，新设备留空则改用密钥',
  authPassword: '密码',
  authKey: '密钥',
  remote: '远程',
  panelTitle: '远程实例',
  deviceLabel: '设备',
  noDevice: '还没有设备，先在设置 → 远程实例里添加。',
  sessionsLabel: '会话',
  noSessions: '这台设备上还没有会话。',
  newSession: '新会话',
  cwdLabel: '工作目录',
  cwdHint: '远端绝对路径，例如 /home/me/project',
  chatLabel: '对话',
  emptyChat: '选一个会话，或新建一个。',
  promptPlaceholder: '给远端 agent 发消息…（Enter 发送，Shift+Enter 换行）',
  send: '发送',
  sending: '发送中…',
  stop: '停止',
  sourceLog: '历史来自远端日志',
  sourceLive: '仅显示打开后的消息',
  running: '运行中',
  idle: '空闲',
  advanced: '高级',
  fieldIdentity: '私钥路径',
  fieldJump: '跳板机（-J）',
  fieldDsh: 'dsh 可执行文件',
  fieldShell: '登录 shell',
  hintName: '留空则按 IP 自动生成；允许 a-z、0-9、- 和 _',
  hintHost: '主机名、IP，或 ~/.ssh/config 里的别名',
  hintPort: '留空使用 ssh 默认端口',
  hintProfile: '远端须已存在该 profile，默认 headless',
  hintCwd: '留空使用 ssh 登录目录',
  hintIdentity: '留空交给 ssh config 或 ssh-agent',
  hintJump: '留空为直连',
  hintDsh: '登录 shell 找不到 dsh 时填绝对路径',
  hintShell: '留空则直接执行，不套 -lc',
  save: '登记',
  saving: '登记中…',
  reset: '清空',
  probe: '探测',
  probing: '探测中…',
  remove: '移除',
  confirmRemove: '确认移除',
  profileTag: 'profile',
  neverProbed: '尚未探测',
  probeOk: '连接正常 · {version}',
  probeFailed: '探测失败',
  loadFailed: '读取设备清单失败',
  saved: '已登记 {name}',
  removed: '已移除 {name}',
  store: '清单文件：{path}',
  authHint: 'SSH 认证必须免交互（密钥或 ssh-agent）；未知主机指纹需要先在终端执行一次 ssh 确认。',
  invalidPort: '端口必须是 1-65535 的整数',
  nameRequired: '需要设备名字',
  hostRequired: '需要主机名或 IP',
  busy: '处理中…',
}

const EN: Record<string, string> = {
  nav: 'Remote instances',
  title: 'Remote instances',
  subtitle: 'Use another device\'s DSH over SSH: register the device, then let the agent dispatch tasks to its DSH agent in parallel through remote_instance.',
  refresh: 'Refresh',
  devices: 'Registered devices',
  empty: 'No devices yet. Add one below, or let the agent call remote_instance.',
  addTitle: 'Register a device',
  replaceHint: 'Reusing a name replaces that device.',
  fieldName: 'Name',
  fieldHost: 'Host',
  fieldUser: 'User',
  fieldPort: 'Port',
  fieldProfile: 'Remote profile',
  fieldCwd: 'Working directory',
  fieldNote: 'Note',
  fieldPassword: 'Password',
  hintPassword: 'Used for ssh password login; blank keeps a saved password, and a new device with no password falls back to a key',
  authPassword: 'password',
  authKey: 'key',
  remote: 'Remote',
  panelTitle: 'Remote instances',
  deviceLabel: 'Device',
  noDevice: 'No device yet. Add one in Settings → Remote instances.',
  sessionsLabel: 'Conversations',
  noSessions: 'This device has no conversation yet.',
  newSession: 'New conversation',
  cwdLabel: 'Working directory',
  cwdHint: 'An absolute remote path, e.g. /home/me/project',
  chatLabel: 'Conversation',
  emptyChat: 'Pick a conversation, or start one.',
  promptPlaceholder: 'Message the remote agent… (Enter sends, Shift+Enter adds a line)',
  send: 'Send',
  sending: 'Sending…',
  stop: 'Stop',
  sourceLog: 'History from the remote log',
  sourceLive: 'Only messages seen since opening',
  running: 'running',
  idle: 'idle',
  advanced: 'Advanced',
  fieldIdentity: 'Identity file',
  fieldJump: 'Jump host (-J)',
  fieldDsh: 'dsh executable',
  fieldShell: 'Login shell',
  hintName: 'Blank derives a name from the IP; a-z, 0-9, - and _ only',
  hintHost: 'Host name, IP address, or an ssh config alias',
  hintPort: 'Blank uses the ssh default port',
  hintProfile: 'That profile must exist remotely; headless by default',
  hintCwd: 'Blank uses the ssh login directory',
  hintIdentity: 'Blank lets ssh config or ssh-agent decide',
  hintJump: 'Blank connects directly',
  hintDsh: 'Use an absolute path when the login shell cannot find dsh',
  hintShell: 'Blank runs the command directly, without -lc',
  save: 'Register',
  saving: 'Registering…',
  reset: 'Clear',
  probe: 'Probe',
  probing: 'Probing…',
  remove: 'Remove',
  confirmRemove: 'Confirm remove',
  profileTag: 'profile',
  neverProbed: 'Never probed',
  probeOk: 'Reachable · {version}',
  probeFailed: 'Probe failed',
  loadFailed: 'Could not read the device list',
  saved: 'Registered {name}',
  removed: 'Removed {name}',
  store: 'Device list: {path}',
  authHint: 'SSH must authenticate non-interactively (key or ssh-agent); accept an unknown host key once in a terminal first.',
  invalidPort: 'Port must be an integer between 1 and 65535',
  nameRequired: 'A device name is required',
  hostRequired: 'A host name or IP address is required',
  busy: 'Working…',
}

const CSS = `
.ri-page { display:flex; flex-direction:column; gap:20px; height:100%; min-height:0; overflow:auto; padding:24px; box-sizing:border-box; color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family); font-size:13px; }
.ri-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.ri-head h2 { margin:0 0 6px; font-size:18px; font-weight:600; }
.ri-head p { margin:0; max-width:64ch; }
.ri-muted { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; }
.ri-hint { color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:1.4; }
.ri-error { margin:0; color:var(--dsw-alias-state-error-primary); font-size:12px; }
.ri-notice { margin:0; color:var(--dsw-alias-state-success-primary); font-size:12px; }
.ri-list { display:flex; flex-direction:column; gap:8px; margin:0; padding:0; list-style:none; }
.ri-row { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; padding:12px 14px; border:1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); }
.ri-rowmain { display:flex; flex-direction:column; gap:4px; min-width:0; }
.ri-rowtitle { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ri-name { font-weight:600; font-size:13px; }
.ri-target { font-family:var(--dsw-font-mono); font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.ri-tag { font-size:11px; padding:1px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.ri-rowactions { display:flex; gap:6px; flex:0 0 auto; }
.ri-button { font:inherit; font-size:12px; line-height:1; padding:7px 12px; border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); cursor:pointer; transition:background-color .12s ease, border-color .12s ease; }
.ri-button:hover:enabled { background:var(--dsw-alias-interactive-bg-hover); }
.ri-button:disabled { opacity:.55; cursor:default; }
.ri-button:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:2px; }
.ri-primary { background:var(--dsw-alias-button-primary-fill); border-color:transparent; color:var(--dsw-alias-label-primary-foreground); }
.ri-primary:hover:enabled { background:var(--dsw-alias-button-primary-hover); }
.ri-danger { color:var(--dsw-alias-state-error-primary); }
.ri-danger.ri-armed { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.ri-ok { color:var(--dsw-alias-state-success-primary); font-size:11px; }
.ri-bad { color:var(--dsw-alias-state-error-primary); font-size:11px; }
.ri-form { display:flex; flex-direction:column; gap:12px; padding:16px; border:1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); }
.ri-form h3 { margin:0; font-size:14px; font-weight:600; }
.ri-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; }
.ri-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.ri-field label { font-size:12px; color:var(--dsw-alias-label-secondary); }
.ri-input { font:inherit; font-size:13px; padding:7px 10px; border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); min-width:0; }
.ri-input:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:1px; }
.ri-actions { display:flex; gap:8px; justify-content:flex-end; }
.ri-advanced summary { cursor:pointer; font-size:12px; color:var(--dsw-alias-label-secondary); }
.ri-advanced { display:flex; flex-direction:column; gap:12px; }
.ri-advanced summary:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:2px; border-radius:var(--dsw-radius-sm); }
.ri-foot { display:flex; flex-wrap:wrap; gap:8px; justify-content:space-between; }
.ri-store code { font-family:var(--dsw-font-mono); }
@media (prefers-reduced-motion: reduce) { .ri-page *, .ri-page *::before, .ri-page *::after { transition:none !important; animation:none !important; } }
.ri-toolbar { position: relative; display: inline-flex; }
.ri-panel { position: fixed; z-index: 60; width: min(560px, calc(100vw - 24px)); max-height: min(72vh, 760px); display: flex; flex-direction: column; gap: 10px; padding: 14px; box-sizing: border-box; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary); }
.ri-panelbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ri-panelhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ri-panelhead strong { font-size: 13px; }
.ri-select { font: inherit; font-size: 12px; padding: 5px 8px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: inherit; }
.ri-textarea { font: inherit; font-size: 12px; padding: 7px 9px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: inherit; resize: vertical; min-height: 60px; width: 100%; box-sizing: border-box; }
.ri-sessions { display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow: auto; }
.ri-session { display: flex; flex-direction: column; gap: 2px; text-align: left; font: inherit; font-size: 12px; padding: 6px 8px; border-radius: var(--dsw-radius-md); border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; }
.ri-session:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ri-session[aria-pressed='true'] { border-color: var(--dsw-alias-brand-primary); }
.ri-chat { flex: 1; min-height: 120px; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
.ri-msg { max-width: 92%; padding: 6px 9px; border-radius: var(--dsw-radius-md); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.ri-msg-user { align-self: flex-end; background: var(--dsw-alias-bg-layer-2); }
.ri-msg-assistant { align-self: flex-start; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); }
.ri-msg-thought { align-self: flex-start; color: var(--dsw-alias-label-tertiary); font-style: italic; }
.ri-msg-tool { align-self: flex-start; font-family: var(--dsw-font-mono); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ri-msg-notice { align-self: flex-start; font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
.ri-compose { display: flex; flex-direction: column; gap: 6px; }
.ri-composebar { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
@media (prefers-reduced-motion: reduce) { .ri-toolbar *, .ri-panel * { transition: none !important; animation: none !important; } }
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function probeOf(value: unknown): ProbeView | undefined {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined
  return {
    at: numberOf(value.at) ?? 0,
    ok: value.ok,
    version: textOf(value.version),
    os: textOf(value.os),
    message: textOf(value.message),
  }
}

function asInstances(value: unknown): { store: string; instances: InstanceView[] } {
  const record = isRecord(value) ? value : {}
  const rows = Array.isArray(record.instances) ? record.instances : []
  const instances: InstanceView[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const name = textOf(row.name)
    const target = textOf(row.target)
    if (!name || !target) continue
    instances.push({
      name,
      target,
      host: textOf(row.host) ?? '',
      user: textOf(row.user),
      port: numberOf(row.port),
      identityFile: textOf(row.identityFile),
      proxyJump: textOf(row.proxyJump),
      profile: textOf(row.profile) ?? 'headless',
      dsh: textOf(row.dsh) ?? 'dsh',
      shell: textOf(row.shell) ?? 'bash',
      auth: row.auth === 'password' ? 'password' : row.auth === 'key' ? 'key' : undefined,
      platform: row.platform === 'windows' ? 'windows' : row.platform === 'posix' ? 'posix' : undefined,
      cwd: textOf(row.cwd),
      note: textOf(row.note),
      lastProbe: probeOf(row.lastProbe),
    })
  }
  return { store: textOf(record.store) ?? '~/.dsh/remote-instances.json', instances }
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

async function postJson(path: string, header: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...header },
    body: JSON.stringify(body),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(isRecord(payload) ? textOf(payload.error) ?? `Request failed (${response.status})` : `Request failed (${response.status})`)
  if (!isRecord(payload) || payload.ok !== true) throw new Error(isRecord(payload) ? textOf(payload.error) ?? 'Request failed' : 'Request failed')
  return payload.value
}

function draftToArgs(draft: Draft, t: Translate): Record<string, unknown> {
  const host = draft.host.trim()
  if (!host) throw new Error(t('hostRequired'))
  const name = draft.name.trim()
  const args: Record<string, unknown> = { action: 'add', host, ...(name ? { name } : {}) }
  for (const key of ['user', 'cwd', 'note', 'identityFile', 'proxyJump'] as const) {
    const value = draft[key].trim()
    if (value) args[key] = value
  }
  const profile = draft.profile.trim()
  if (profile) args.profile = profile
  const dsh = draft.dsh.trim()
  if (dsh) args.dsh = dsh
  args.shell = draft.shell.trim()
  if (draft.password) args.password = draft.password
  if (draft.port.trim()) {
    const port = Number(draft.port.trim())
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(t('invalidPort'))
    args.port = port
  }
  return args
}

/** 一行表单字段。 / One form field. */
function Field(props: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly hint?: string
  readonly type?: string
  readonly inputMode?: 'numeric' | 'text'
  readonly placeholder?: string
  readonly onChange: (value: string) => void
}): ReactElement {
  const hintId = props.hint ? `${props.id}-hint` : undefined
  return (
    <div className="ri-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        className="ri-input"
        type={props.type ?? 'text'}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        value={props.value}
        aria-describedby={hintId}
        onChange={event => props.onChange(event.target.value)}
      />
      {props.hint ? <span className="ri-hint" id={hintId}>{props.hint}</span> : null}
    </div>
  )
}

/** 一个设备行。 / One device row. */
function InstanceRow(props: {
  readonly instance: InstanceView
  readonly t: Translate
  readonly busy: string
  readonly armed: boolean
  readonly note?: string
  readonly onProbe: (name: string) => void
  readonly onRemove: (name: string) => void
}): ReactElement {
  const { instance, t, busy, armed, note } = props
  const probing = busy === `probe:${instance.name}`
  const last = instance.lastProbe
  return (
    <li className="ri-row">
      <div className="ri-rowmain">
        <div className="ri-rowtitle">
          <span className="ri-name">{instance.name}</span>
          <span className="ri-target">{instance.target}</span>
          <span className="ri-tag">{t('profileTag')} {instance.profile}</span>
          <span className="ri-tag">{instance.auth === 'password' ? t('authPassword') : t('authKey')}</span>
          {instance.platform ? <span className="ri-tag">{instance.platform}</span> : null}
          {instance.cwd ? <span className="ri-muted">{instance.cwd}</span> : null}
        </div>
        {instance.note ? <span className="ri-muted">{instance.note}</span> : null}
        {last ? (
          <span className={last.ok ? 'ri-ok' : 'ri-bad'} role="status">
            {last.ok ? t('probeOk', { version: last.version ?? 'dsh' }) : `${t('probeFailed')}${last.message ? ` · ${last.message}` : ''}`}
            {last.at ? ` · ${new Date(last.at).toLocaleString()}` : ''}
          </span>
        ) : <span className="ri-hint">{t('neverProbed')}</span>}
        {note ? <span className="ri-muted" role="status">{note}</span> : null}
      </div>
      <div className="ri-rowactions">
        <button type="button" className="ri-button" disabled={Boolean(busy)} onClick={() => props.onProbe(instance.name)}>
          {probing ? t('probing') : t('probe')}
        </button>
        <button
          type="button"
          className={armed ? 'ri-button ri-danger ri-armed' : 'ri-button ri-danger'}
          disabled={Boolean(busy)}
          aria-pressed={armed}
          onClick={() => props.onRemove(instance.name)}
        >
          {armed ? t('confirmRemove') : t('remove')}
        </button>
      </div>
    </li>
  )
}

/** 设置面板分区本体。 / The Settings section itself. */
function RemoteInstancesSection({ t, api }: SectionProps): ReactElement {
  const [store, setStore] = useState('')
  const [instances, setInstances] = useState<readonly InstanceView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [armed, setArmed] = useState('')
  const armedTimer = useRef<number | undefined>(undefined)
  const translate = useRef(t)
  translate.current = t
  const host = useRef(api)
  host.current = api
  const fieldId = useId()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const snapshot = asInstances(await host.current.read({ action: 'instances' }))
      setInstances(snapshot.instances)
      setStore(snapshot.store)
      setError('')
    } catch (failure) {
      setError(`${translate.current('loadFailed')}: ${messageOf(failure)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => window.clearTimeout(armedTimer.current), [])

  const act = async (label: string, args: Record<string, unknown>): Promise<unknown | undefined> => {
    setBusy(label)
    setError('')
    setNotice('')
    try {
      return await host.current.act(args)
    } catch (failure) {
      setError(messageOf(failure))
      return undefined
    } finally {
      setBusy('')
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    let args: Record<string, unknown>
    try {
      args = draftToArgs(draft, translate.current)
    } catch (failure) {
      setError(messageOf(failure))
      return
    }
    const value = await act('save', args)
    if (value === undefined) return
    const name = isRecord(value) && isRecord(value.instance) ? textOf(value.instance.name) ?? draft.name.trim() : draft.name.trim()
    setNotice(translate.current('saved', { name }))
    setDraft(EMPTY_DRAFT)
    setNotes({})
    await load()
  }

  const probe = async (name: string): Promise<void> => {
    setBusy(`probe:${name}`)
    setError('')
    try {
      const value = await host.current.act({ action: 'probe', name })
      const facts = isRecord(value) ? value : {}
      const ok = facts.ok === true
      const version = textOf(facts.version) ?? 'dsh'
      const message = textOf(facts.message)
      setNotes(current => ({ ...current, [name]: ok ? translate.current('probeOk', { version }) : `${translate.current('probeFailed')}${message ? ` · ${message}` : ''}` }))
      await load()
    } catch (failure) {
      setNotes(current => ({ ...current, [name]: `${translate.current('probeFailed')} · ${messageOf(failure)}` }))
    } finally {
      setBusy('')
    }
  }

  const remove = (name: string): void => {
    if (armed !== name) {
      setArmed(name)
      window.clearTimeout(armedTimer.current)
      armedTimer.current = window.setTimeout(() => setArmed(''), ARM_TIMEOUT_MS)
      return
    }
    setArmed('')
    window.clearTimeout(armedTimer.current)
    void (async () => {
      const value = await act('remove', { action: 'remove', name })
      if (value === undefined) return
      setNotice(translate.current('removed', { name }))
      setNotes(current => {
        const next = { ...current }
        delete next[name]
        return next
      })
      await load()
    })()
  }

  const update = (key: keyof Draft) => (value: string): void => setDraft(current => ({ ...current, [key]: value }))

  return (
    <div className="ri-page">
      <style id={STYLE_ID}>{CSS}</style>
      <header className="ri-head">
        <div>
          <h2>{t('title')}</h2>
          <p className="ri-muted">{t('subtitle')}</p>
        </div>
        <button type="button" className="ri-button" onClick={() => void load()} disabled={loading || Boolean(busy)}>
          {loading ? t('busy') : t('refresh')}
        </button>
      </header>
      {error ? <p className="ri-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="ri-notice" role="status">{notice}</p> : null}
      <section aria-label={t('devices')}>
        {instances.length === 0
          ? <p className="ri-muted">{t('empty')}</p>
          : (
            <ul className="ri-list">
              {instances.map(instance => (
                <InstanceRow
                  key={instance.name}
                  instance={instance}
                  t={t}
                  busy={busy}
                  armed={armed === instance.name}
                  note={notes[instance.name]}
                  onProbe={name => void probe(name)}
                  onRemove={remove}
                />
              ))}
            </ul>
          )}
      </section>
      <form className="ri-form" aria-label={t('addTitle')} onSubmit={event => void save(event)}>
        <h3>{t('addTitle')}</h3>
        <p className="ri-muted">{t('replaceHint')} {t('authHint')}</p>
        <div className="ri-grid">
          <Field id={`${fieldId}-name`} label={t('fieldName')} value={draft.name} hint={t('hintName')} onChange={update('name')} />
          <Field id={`${fieldId}-host`} label={t('fieldHost')} value={draft.host} hint={t('hintHost')} onChange={update('host')} />
          <Field id={`${fieldId}-user`} label={t('fieldUser')} value={draft.user} onChange={update('user')} />
          <Field id={`${fieldId}-port`} label={t('fieldPort')} value={draft.port} hint={t('hintPort')} inputMode="numeric" onChange={update('port')} />
          <Field id={`${fieldId}-profile`} label={t('fieldProfile')} value={draft.profile} hint={t('hintProfile')} onChange={update('profile')} />
          <Field id={`${fieldId}-cwd`} label={t('fieldCwd')} value={draft.cwd} hint={t('hintCwd')} onChange={update('cwd')} />
          <Field id={`${fieldId}-note`} label={t('fieldNote')} value={draft.note} onChange={update('note')} />
          <Field id={`${fieldId}-password`} label={t('fieldPassword')} value={draft.password} hint={t('hintPassword')} type="password" onChange={update('password')} />
        </div>
        <details className="ri-advanced">
          <summary>{t('advanced')}</summary>
          <div className="ri-grid">
            <Field id={`${fieldId}-identity`} label={t('fieldIdentity')} value={draft.identityFile} hint={t('hintIdentity')} onChange={update('identityFile')} />
            <Field id={`${fieldId}-jump`} label={t('fieldJump')} value={draft.proxyJump} hint={t('hintJump')} onChange={update('proxyJump')} />
            <Field id={`${fieldId}-dsh`} label={t('fieldDsh')} value={draft.dsh} hint={t('hintDsh')} onChange={update('dsh')} />
            <Field id={`${fieldId}-shell`} label={t('fieldShell')} value={draft.shell} hint={t('hintShell')} onChange={update('shell')} />
          </div>
        </details>
        <div className="ri-actions">
          <button type="button" className="ri-button" onClick={() => setDraft(EMPTY_DRAFT)} disabled={Boolean(busy)}>{t('reset')}</button>
          <button type="submit" className="ri-button ri-primary" disabled={Boolean(busy)}>{busy === 'save' ? t('saving') : t('save')}</button>
        </div>
      </form>
      <footer className="ri-foot">
        <span className="ri-muted ri-store"><code>{t('store', { path: store })}</code></span>
      </footer>
    </div>
  )
}

const TOOLBAR_STYLE_ID = '@kaus-io/dsh-remote-instance/RemoteToolbar.css'

/** 远端会话摘要。 / One remote conversation summary. */
interface RemoteSessionView {
  readonly sessionId: string
  readonly cwd: string
  readonly title?: string
  readonly updatedAt?: string
}

/** 一条历史消息。 / One history message. */
interface HistoryMessageView {
  readonly role: 'user' | 'assistant' | 'thought' | 'tool' | 'notice'
  readonly text: string
  readonly status?: string
}

/** 历史读取结果。 / A history read. */
interface HistoryView {
  readonly source: 'log' | 'live'
  readonly messages: readonly HistoryMessageView[]
  readonly running: boolean
  readonly note?: string
  readonly title?: string
  readonly cwd?: string
}

function asSessions(value: unknown): RemoteSessionView[] {
  const record = isRecord(value) ? value : {}
  const rows = Array.isArray(record.sessions) ? record.sessions : []
  const sessions: RemoteSessionView[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const sessionId = textOf(row.sessionId)
    if (!sessionId) continue
    sessions.push({
      sessionId,
      cwd: textOf(row.cwd) ?? '',
      ...(textOf(row.title) === undefined ? {} : { title: textOf(row.title) }),
      ...(textOf(row.updatedAt) === undefined ? {} : { updatedAt: textOf(row.updatedAt) }),
    })
  }
  return sessions
}

function asHistory(value: unknown): HistoryView {
  const record = isRecord(value) ? value : {}
  const rows = Array.isArray(record.messages) ? record.messages : []
  const messages: HistoryMessageView[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const role = row.role
    if (role !== 'user' && role !== 'assistant' && role !== 'thought' && role !== 'tool' && role !== 'notice') continue
    const body = textOf(row.text)
    if (!body) continue
    messages.push({ role, text: body, ...(textOf(row.status) === undefined ? {} : { status: textOf(row.status) }) })
  }
  return {
    source: record.source === 'log' ? 'log' : 'live',
    messages,
    running: record.running === true,
    ...(textOf(record.note) === undefined ? {} : { note: textOf(record.note) }),
    ...(textOf(record.title) === undefined ? {} : { title: textOf(record.title) }),
    ...(textOf(record.cwd) === undefined ? {} : { cwd: textOf(record.cwd) }),
  }
}

function shortCwd(path: string): string {
  return path.length > 60 ? `…${path.slice(-58)}` : path
}

/** 会话卡片上的「远程」入口：设备 → 会话 → 对话。 / The session-header remote entry: device → conversation → chat. */
function RemoteToolbar({ sessionId = '', t, api }: SectionProps & { readonly sessionId?: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const [instances, setInstances] = useState<readonly InstanceView[]>([])
  const [device, setDevice] = useState('')
  const [sessions, setSessions] = useState<readonly RemoteSessionView[]>([])
  const [current, setCurrent] = useState('')
  const [history, setHistory] = useState<HistoryView | null>(null)
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [rect, setRect] = useState<{ top: number; right: number } | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const tRef = useRef(t)
  tRef.current = t
  const apiRef = useRef(api)
  apiRef.current = api
  const chatRef = useRef<HTMLDivElement | null>(null)

  const loadInstances = useCallback(async (): Promise<void> => {
    try {
      const snapshot = asInstances(await apiRef.current.read({ action: 'instances' }, sessionId))
      setInstances(snapshot.instances)
      setDevice(value => value || snapshot.instances[0]?.name || '')
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [sessionId])

  const loadSessions = useCallback(async (name: string): Promise<void> => {
    if (!name) return
    try {
      const rows = asSessions(await apiRef.current.read({ action: 'sessions', name }, sessionId))
      setSessions(rows)
      setCurrent(value => (rows.some(row => row.sessionId === value) ? value : rows[0]?.sessionId ?? ''))
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [sessionId])

  const loadHistory = useCallback(async (name: string, remoteSession: string, refresh: boolean): Promise<void> => {
    if (!name || !remoteSession) return
    try {
      setHistory(asHistory(await apiRef.current.read({ action: 'history', name, sessionId: remoteSession, refresh }, sessionId)))
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [sessionId])

  // 打开面板时定位到按钮下方，并夹在视口内。 / Anchor the panel under the button, clamped to the viewport.
  useEffect(() => {
    if (!open) return undefined
    const place = (): void => {
      const box = anchorRef.current?.getBoundingClientRect()
      if (!box) return
      setRect({ top: Math.max(8, Math.min(box.bottom + 6, window.innerHeight - 420)), right: Math.max(8, Math.min(window.innerWidth - box.right, window.innerWidth - 320)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    void loadInstances()
    return undefined
  }, [open, loadInstances])

  useEffect(() => {
    if (!open || !device) return undefined
    void loadSessions(device)
    return undefined
  }, [open, device, loadSessions])

  // 选中会话时读一次带刷新的历史，之后只轮询增量。 / Read fresh on selection, then poll.
  useEffect(() => {
    if (!open || !device || !current) return undefined
    void loadHistory(device, current, true)
    const timer = window.setInterval(() => { void loadHistory(device, current, false) }, 2500)
    return () => window.clearInterval(timer)
  }, [open, device, current, loadHistory])

  useEffect(() => {
    const node = chatRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [history])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (anchorRef.current?.contains(target)) return
      if ((event.target as Element | null)?.closest?.('.ri-panel')) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const act = async (label: string, args: Record<string, unknown>): Promise<unknown | undefined> => {
    setBusy(label)
    setError('')
    try {
      return await apiRef.current.act(args, sessionId)
    } catch (failure) {
      setError(messageOf(failure))
      return undefined
    } finally {
      setBusy('')
    }
  }

  const send = async (): Promise<void> => {
    const body = prompt.trim()
    if (!body || !device || !current) return
    const done = await act('send', { action: 'send', name: device, sessionId: current, prompt: body, wait: false })
    if (done === undefined) return
    setPrompt('')
    await loadHistory(device, current, true)
  }

  const stop = async (): Promise<void> => {
    if (!device || !current) return
    await act('stop', { action: 'stop', name: device, sessionId: current })
    await loadHistory(device, current, true)
  }

  const create = async (): Promise<void> => {
    if (!device) return
    const value = await act('new', { action: 'new', name: device, ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(prompt.trim() ? { prompt: prompt.trim(), wait: false } : {}) })
    if (!isRecord(value) || typeof value.sessionId !== 'string') return
    setPrompt('')
    setCurrent(value.sessionId)
    await loadSessions(device)
    await loadHistory(device, value.sessionId, true)
  }

  const footer = history?.note ? <p className="ri-hint">{history.note}</p> : null

  return (
    <span className="ri-toolbar">
      <button
        ref={anchorRef}
        type="button"
        className="ri-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {t('remote')}
        {history?.running ? ' •' : ''}
      </button>
      {open && rect ? (
        <div className="ri-panel" style={{ top: rect.top, right: rect.right }} role="dialog" aria-label={t('panelTitle')}>
          <style id={TOOLBAR_STYLE_ID}>{CSS}</style>
          <div className="ri-panelhead">
            <strong>{t('panelTitle')}</strong>
            <button type="button" className="ri-button" onClick={() => setOpen(false)}>{t('close')}</button>
          </div>
          {error ? <p className="ri-error" role="alert">{error}</p> : null}
          {instances.length === 0 ? <p className="ri-muted">{t('noDevice')}</p> : null}
          <div className="ri-panelbar">
            <label className="ri-hint" htmlFor="ri-device">{t('deviceLabel')}</label>
            <select id="ri-device" className="ri-select" value={device} onChange={event => { setDevice(event.target.value); setCurrent(''); setHistory(null) }}>
              {instances.map(instance => <option key={instance.name} value={instance.name}>{instance.name} · {instance.target}{instance.platform ? ` · ${instance.platform}` : ''}</option>)}
            </select>
            <button type="button" className="ri-button" onClick={() => { void loadInstances(); if (device) void loadSessions(device) }}>{t('refresh')}</button>
          </div>
          <div className="ri-sessions" aria-label={t('sessionsLabel')}>
            {sessions.length === 0 ? <span className="ri-hint">{t('noSessions')}</span> : sessions.map(row => (
              <button
                key={row.sessionId}
                type="button"
                className="ri-session"
                aria-pressed={row.sessionId === current}
                onClick={() => setCurrent(row.sessionId)}
              >
                <span>{row.title ?? row.sessionId}</span>
                <span className="ri-hint">{shortCwd(row.cwd)}{row.updatedAt ? ` · ${row.updatedAt}` : ''}</span>
              </button>
            ))}
          </div>
          <div className="ri-chat" ref={chatRef} aria-label={t('chatLabel')}>
            {history === null || history.messages.length === 0
              ? <span className="ri-hint">{t('emptyChat')}</span>
              : history.messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`ri-msg ${message.role === 'user' ? 'ri-msg-user' : message.role === 'assistant' ? 'ri-msg-assistant' : message.role === 'thought' ? 'ri-msg-thought' : message.role === 'tool' ? 'ri-msg-tool' : 'ri-msg-notice'}`}
                >
                  {message.text}
                  {message.status ? ` · ${message.status}` : ''}
                </div>
              ))}
          </div>
          {footer}
          <div className="ri-compose">
            <textarea
              className="ri-textarea"
              value={prompt}
              placeholder={t('promptPlaceholder')}
              aria-label={t('chatLabel')}
              onChange={event => setPrompt(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="ri-panelbar">
              <input className="ri-input" style={{ flex: 1 }} value={cwd} placeholder={t('cwdHint')} aria-label={t('cwdLabel')} onChange={event => setCwd(event.target.value)} />
              <button type="button" className="ri-button" disabled={Boolean(busy) || !device} onClick={() => void create()}>{t('newSession')}</button>
            </div>
            <div className="ri-composebar">
              <span className="ri-hint">{history?.running ? t('running') : t('idle')}{history ? ` · ${history.source === 'log' ? t('sourceLog') : t('sourceLive')}` : ''}</span>
              <button type="button" className="ri-button" disabled={Boolean(busy) || !history?.running} onClick={() => void stop()}>{t('stop')}</button>
              <button type="button" className="ri-button ri-primary" disabled={Boolean(busy) || !prompt.trim() || !current} onClick={() => void send()}>
                {busy === 'send' ? t('sending') : t('send')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  )
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'remote-instance.locale')
  ctx.effect(() => {
    const t = ctx.locale.bind(NS)
    const api: PanelApi = {
      read: (args, sessionId) => postJson(OBSERVE_PATH, { 'x-ri-observe': '1' }, sessionId ? { args, sessionId } : { args }),
      act: (args, sessionId) => postJson(ACTION_PATH, { 'x-ri-action': '1' }, sessionId ? { args, sessionId } : { args }),
    }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'remote-instance',
      order: 45,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ api }),
    }, RemoteInstancesSection))
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'remote-instance-toolbar',
      order: 40,
      locale: NS,
      inject: () => ({ api }),
    }, RemoteToolbar))
  }, 'remote-instance.settings')
}

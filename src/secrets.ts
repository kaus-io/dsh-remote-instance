/**
 * 密码存储：与设备清单分离的文件，权限 0600、原子写、写入串行化。
 * 密码永远不进入设备清单、工具结果、作业输出或日志。
 *
 * Password storage: a file separate from the device list, mode 0600, atomic
 * writes, serialized. A password never enters the device list, a tool result,
 * job output, or a log.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 单个密码的长度上限。 / Upper bound on one password. */
const MAX_SECRET = 4096

/** 从清单路径推导密码文件路径。 / Derive the secrets path from the list path. */
export function secretsPathFor(storeFile: string): string {
  return storeFile.endsWith('.json') ? `${storeFile.slice(0, -5)}.secrets.json` : `${storeFile}.secrets.json`
}

export class SecretStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  /** 读取全部密码；文件缺失视为空，结构损坏抛错。 / Read every password; a missing file is empty, a broken one throws. */
  async load(): Promise<Map<string, string>> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw new Error(`Cannot read the remote instance passwords: ${(error as Error).message}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('The remote instance password file is not valid JSON; fix or delete it before retrying')
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { passwords?: unknown }).passwords !== 'object') {
      throw new Error('The remote instance password file has no `passwords` object')
    }
    const result = new Map<string, string>()
    for (const [name, value] of Object.entries((parsed as { passwords: Record<string, unknown> }).passwords)) {
      if (typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET) result.set(name, value)
    }
    return result
  }

  /** 读一个密码。 / Read one password. */
  async get(name: string): Promise<string | undefined> {
    return (await this.load()).get(name)
  }

  /** 写入或替换一个密码。 / Store or replace one password. */
  async set(name: string, password: string): Promise<void> {
    await this.serialize(async () => {
      const passwords = await this.load()
      passwords.set(name, assertSecret(password))
      await this.write(passwords)
    })
  }

  /** 删除一个密码；不存在时忽略。 / Remove one password; a missing name is ignored. */
  async delete(name: string): Promise<void> {
    await this.serialize(async () => {
      const passwords = await this.load()
      if (passwords.delete(name)) await this.write(passwords)
    })
  }

  private async write(passwords: ReadonlyMap<string, string>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    const body = JSON.stringify({ version: 1, passwords: Object.fromEntries(passwords) }, null, 2) + '\n'
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.file)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => undefined)
    return next
  }
}

/** 校验密码形状；只拒绝空值与超长，不限制字符集。 / Validate shape only; never restrict the character set. */
export function assertSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('password must be a non-empty string')
  if (value.length > MAX_SECRET) throw new Error(`password is too long (max ${MAX_SECRET} characters)`)
  if (value.includes('\0')) throw new Error('password must not contain NUL characters')
  return value
}

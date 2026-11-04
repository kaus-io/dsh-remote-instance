/**
 * 把 `docs/releases/<tag>.md` 同步成 GitHub Release 的描述。
 * 只更新已经存在的 release；不会创建 release（创建会触发发布 workflow）。
 *
 * Sync `docs/releases/<tag>.md` into the description of an existing GitHub
 * Release. Existing releases only: creating one would fire the publish workflow.
 *
 * 用法 / Usage:
 *   GITHUB_TOKEN=... node scripts/sync-release-notes.mjs            # 更新全部
 *   GITHUB_TOKEN=... node scripts/sync-release-notes.mjs --dry-run  # 只打印
 *   GITHUB_TOKEN=... node scripts/sync-release-notes.mjs 1.0.0-alpha03
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = join(root, 'docs', 'releases')
const repository = process.env.GITHUB_REPOSITORY ?? 'kaus-io/dsh-remote-instance'
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const dryRun = process.argv.includes('--dry-run')
const only = process.argv.slice(2).filter(argument => !argument.startsWith('--'))

/** 一次 GitHub API 调用；失败时把状态与响应体一起抛出。 / One GitHub call; failures carry status and body. */
async function call(method, path, body) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : undefined
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${payload?.message ?? text.slice(0, 200)}`)
  return payload
}

const entries = (await readdir(directory)).filter(name => name.endsWith('.md')).sort()
if (only.length > 0) {
  const wanted = new Set(entries.filter(name => only.includes(name.slice(0, -3))))
  for (const missing of only.filter(tag => !wanted.has(`${tag}.md`))) throw new Error(`no notes file for ${missing}`)
  entries.splice(0, entries.length, ...wanted)
}

for (const entry of entries) {
  const tag = entry.slice(0, -3)
  const body = await readFile(join(directory, entry), 'utf8')
  let release
  try {
    release = await call('GET', `/releases/tags/${encodeURIComponent(tag)}`)
  } catch (error) {
    if (String(error.message).includes('404')) {
      console.log(`${tag}: no GitHub release yet; create it from the tag and paste this body`)
      continue
    }
    throw error
  }
  const same = (release.body ?? '') === body
  console.log(`${tag}: ${same ? 'already up to date' : `update release ${release.id} (${body.length} chars)`}${dryRun ? ' [dry-run]' : ''}`)
  if (same || dryRun) continue
  await call('PATCH', `/releases/${release.id}`, { body })
  console.log(`${tag}: updated`)
}

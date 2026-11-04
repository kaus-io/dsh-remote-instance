/**
 * 从清单版本推导 npm dist-tag：稳定版用 `latest`，预发布取标识符（`1.0.0-alpha01` → `alpha`）。
 * 预发布带数字但没有字母标识符时直接失败，避免把预发布错误地发成 `latest`。
 *
 * Derive the npm dist-tag from the manifest version: stable releases use
 * `latest`, a prerelease uses its identifier (`1.0.0-alpha01` → `alpha`). A
 * prerelease without a lettered identifier fails instead of publishing as
 * `latest`.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 由版本号得出 dist-tag。 / The dist-tag for one version. */
export function distTagOf(version) {
  const prerelease = version.split('-', 2)[1]
  if (prerelease === undefined) return 'latest'
  const identifier = /^[a-zA-Z]+/.exec(prerelease)?.[0].toLowerCase()
  if (!identifier) {
    throw new Error(`cannot derive a dist-tag from prerelease "${prerelease}"; use an alpha, beta, or rc identifier`)
  }
  return identifier
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  try {
    process.stdout.write(`${distTagOf(version)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

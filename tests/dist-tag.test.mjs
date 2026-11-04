import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { distTagOf } from '../scripts/dist-tag.mjs'

describe('distTagOf', () => {
  it('uses latest for a stable version', () => {
    assert.equal(distTagOf('1.0.0'), 'latest')
    assert.equal(distTagOf('2.3.4'), 'latest')
  })

  it('uses the prerelease identifier for a prerelease', () => {
    assert.equal(distTagOf('1.0.0-alpha01'), 'alpha')
    assert.equal(distTagOf('1.0.0-beta.2'), 'beta')
    assert.equal(distTagOf('2.0.0-rc1'), 'rc')
    assert.equal(distTagOf('1.0.0-ALPHA01'), 'alpha')
  })

  it('refuses a prerelease it cannot name, instead of publishing latest', () => {
    assert.throws(() => distTagOf('1.0.0-1'), /cannot derive a dist-tag/)
    assert.throws(() => distTagOf('1.0.0-20261105'), /cannot derive a dist-tag/)
  })
})

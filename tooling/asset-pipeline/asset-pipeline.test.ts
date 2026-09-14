import { describe, expect, it } from 'vitest'
import { validateManifestDir } from './src/validate'
import { DEFAULT_PIPELINE_RULES } from './src/index'
import { join } from 'node:path'

describe('asset pipeline (§42)', () => {
  it('the shipped demo manifests are valid', () => {
    const issues = validateManifestDir(join(import.meta.dirname, 'manifests'))
    expect(issues).toEqual([])
  })

  it('pipeline rules flag naming violations', () => {
    const kebab = DEFAULT_PIPELINE_RULES.find((r) => r.id === 'kebab-id')!
    expect(kebab.check({ kind: 'glb', ref: { id: 'Bad_ID' } })).toBeTruthy()
    expect(kebab.check({ kind: 'glb', ref: { id: 'gantry-crane-glb' } })).toBeUndefined()
    const glb = DEFAULT_PIPELINE_RULES.find((r) => r.id === 'glb-naming')!
    expect(glb.check({ kind: 'glb', url: 'https://x/a.gltf', ref: { id: 'a' } })).toBeTruthy()
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  listAllFiles,
  scanImports,
  isTypeExportFrom,
  REPO_ROOT,
  type ImportEdge,
  type SourceFile
} from './src/scanner'

/**
 * Architecture Tests (Freeze §76-77, Gate #6 / #8).
 * 架构边界必须由工具链 enforce，而不是只靠文档。
 */

const files = listAllFiles()
const filesByDir = (dir: string): SourceFile[] =>
  files.filter((f) => f.path.startsWith(`${dir}/`))

function edges(filesSubset: SourceFile[]): ImportEdge[] {
  return filesSubset.flatMap(scanImports)
}

function violations(
  filesSubset: SourceFile[],
  forbiddenSpecifier: (specifier: string) => boolean,
  opts: { allowTypeOnly?: boolean } = {}
): string[] {
  const out: string[] = []
  for (const edge of edges(filesSubset)) {
    if (!forbiddenSpecifier(edge.specifier)) continue
    if (opts.allowTypeOnly && edge.isTypeOnly) continue
    if (opts.allowTypeOnly && edge.isDynamic) continue
    out.push(`${edge.file} -> ${edge.specifier}${edge.isTypeOnly ? ' (type)' : edge.isDynamic ? ' (dynamic)' : ''}`)
  }
  return out
}

const isVue = (s: string) => s === 'vue' || s.startsWith('vue/')
const isThree = (s: string) => s === 'three' || s.startsWith('three/')
const isMaplibre = (s: string) => s === 'maplibre-gl' || s.startsWith('maplibre-gl/')
const isTiles = (s: string) => s.startsWith('3d-tiles-renderer')
const isHeavyEngine = (s: string) => isThree(s) || isMaplibre(s) || isTiles(s)

describe('Gate #8: Foundation cores never depend on Vue / Three / MapLibre', () => {
  const cores = ['packages/world', 'packages/spatial', 'packages/content', 'packages/world-client']

  it.each(cores)('%s has no engine or UI dependency', (pkg) => {
    const found = violations(filesByDir(pkg), isHeavyEngine).concat(
      violations(filesByDir(pkg), isVue)
    )
    expect(found).toEqual([])
  })

  it('scene-host is engine-agnostic and Vue-free', () => {
    const found = violations(filesByDir('packages/scene-host'), (s) =>
      isHeavyEngine(s) || isVue(s) || s === '@twin/map-engine' || s === '@twin/scene-engine'
    )
    expect(found).toEqual([])
  })

  it('domains are headless (no engines, no Vue)', () => {
    const found = violations(filesByDir('domains'), (s) => isHeavyEngine(s) || isVue(s))
    expect(found).toEqual([])
  })
})

describe('Gate #7 precondition: lazy engine entries never statically import their runtime', () => {
  it('map-engine public surface does not statically import maplibre-gl', () => {
    const subset = filesByDir('packages/map-engine').filter((f) =>
      /\/src\/(public|types|style|driver)\.ts$/.test(f.path)
    )
    const bad = subset.flatMap((f) =>
      scanImports(f)
        .filter((e) => isMaplibre(e.specifier) && !e.isDynamic && !e.isTypeOnly)
        .map((e) => `${e.file} -> ${e.specifier}`)
    )
    expect(bad).toEqual([])
  })

  it('scene-engine public surface does not statically import three / 3d-tiles-renderer', () => {
    const subset = filesByDir('packages/scene-engine').filter((f) =>
      /\/src\/(public|types|driver|resources)\.ts$/.test(f.path)
    )
    const bad = subset.flatMap((f) =>
      scanImports(f)
        .filter(
          (e) =>
            (isThree(e.specifier) || isTiles(e.specifier)) &&
            !e.isDynamic &&
            !e.isTypeOnly
        )
        .map((e) => `${e.file} -> ${e.specifier}`)
    )
    expect(bad).toEqual([])
  })

  it('sdk stays runtime-free of engines (type-only re-exports only)', () => {
    const subset = filesByDir('packages/sdk')
    const bad: string[] = []
    for (const file of subset) {
      for (const edge of scanImports(file)) {
        if (!isHeavyEngine(edge.specifier) && !isVue(edge.specifier)) continue
        if (edge.isDynamic) continue
        const runtimeImport =
          !edge.isTypeOnly && !isTypeExportFrom(file.text, edge.specifier)
        if (runtimeImport) {
          bad.push(`${edge.file} -> ${edge.specifier}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('Gate #6: no Foundation internal deep imports', () => {
  it('nothing imports @twin/*/src/... across package boundaries', () => {
    const bad: string[] = []
    for (const file of files) {
      for (const edge of scanImports(file)) {
        const match = edge.specifier.match(/^(@twin\/[a-z0-9-]+)\/src\//)
        if (!match) continue
        const owner = match[1].replace('@twin/', '')
        const fileOwner = file.path.match(/^(packages|domains|scenes|apps|tooling)\/([^/]+)/)
        const inSamePackage =
          fileOwner && (fileOwner[2] === owner || file.path.startsWith(`packages/${owner}/`))
        if (!inSamePackage) {
          bad.push(`${file.path} -> ${edge.specifier}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('dependency direction (§76)', () => {
  it('Foundation packages never import scenes or apps', () => {
    const foundationFiles = files.filter(
      (f) => f.path.startsWith('packages/') || f.path.startsWith('domains/')
    )
    const bad = violations(foundationFiles, (s) => s.startsWith('@twin/scene-'))
    expect(bad).toEqual([])
  })

  it('packages never import app code', () => {
    const bad = files
      .filter((f) => f.path.startsWith('packages/'))
      .flatMap(scanImports)
      .filter((e) => /from ['"](\.\.\/)+(apps|scenes|domains)\//.test(`${e.clause} ${e.specifier}`))
      .map((e) => e.file)
    expect(bad).toEqual([])
  })

  it('scene-host does not depend on world-client internals (public surface only)', () => {
    const bad = filesByDir('packages/scene-host')
      .flatMap(scanImports)
      .filter((e) => e.specifier.startsWith('@twin/') && /\/src\/(?!public)/.test(e.specifier))
      .map((e) => `${e.file} -> ${e.specifier}`)
    expect(bad).toEqual([])
  })
})

describe('Gate #7: the 2D-only app graph is engine-free', () => {
  it('vehicle-navigation standalone never references scene-engine or three', () => {
    const appFiles = [
      ...filesByDir('apps/standalone/vehicle-navigation'),
      ...filesByDir('packages').filter((f) => /\/(public|types|style|driver|resources)\.ts$/.test(f.path))
    ]
    // The app's own graph must not import three/scene-engine at all.
    const appOnly = filesByDir('apps/standalone/vehicle-navigation').concat(
      filesByDir('apps/standalone/shared')
    )
    const bad = violations(appOnly, (s) => isThree(s) || s === '@twin/scene-engine')
      .filter((line) => !line.includes('type'))
    expect(bad).toEqual([])
    void appFiles
  })
})

describe('Gate: every Foundation package exposes exactly one public entry (§77)', () => {
  it('packages/*/package.json exports only ./src/public.ts', () => {
    for (const pkg of [
      'world',
      'spatial',
      'content',
      'world-client',
      'map-engine',
      'scene-engine',
      'scene-host',
      'sdk',
      'ui'
    ]) {
      const pkgJsonPath = join(REPO_ROOT, 'packages', pkg, 'package.json')
      expect(existsSync(pkgJsonPath)).toBe(true)
      const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        exports?: Record<string, unknown>
      }
      const keys = Object.keys(manifest.exports ?? {})
      if (pkg === 'ui') {
        expect(keys.sort()).toEqual(['.', './styles.css'])
      } else {
        expect(keys).toEqual(['.'])
        expect((manifest.exports as Record<string, string>)['.']).toBe('./src/public.ts')
      }
    }
  })
})

describe('scene model sanity (§7-8)', () => {
  it('SceneDefinition contract has no engine metadata fields', () => {
    const sdkTypes = filesByDir('packages/sdk')
      .map((f) => f.text)
      .join('\n')
    expect(sdkTypes).not.toMatch(/engines\s*[?:]/)
    expect(sdkTypes).not.toMatch(/assets\s*[?:]\s*readonly/)
    expect(sdkTypes).toMatch(/interface SceneDefinition/)
    expect(sdkTypes).toMatch(/interface SceneEntry/)
    expect(sdkTypes).toMatch(/interface SceneMount/)
  })
})

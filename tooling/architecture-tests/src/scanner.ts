import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

export interface SourceFile {
  /** Repo-relative POSIX path, e.g. packages/world/src/types.ts */
  path: string
  text: string
}

export function listSourceFiles(relDir: string, extensions = ['.ts', '.vue']): SourceFile[] {
  const root = join(REPO_ROOT, relDir)
  const out: SourceFile[] = []
  walk(root, out, extensions)
  return out
}

function walk(dir: string, out: SourceFile[], extensions: string[]): void {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out, extensions)
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      out.push({
        path: relative(REPO_ROOT, full).split(sep).join('/'),
        text: readFileSync(full, 'utf8')
      })
    }
  }
}

export interface ImportEdge {
  file: string
  /** Import clause text, e.g. `type { Foo }` or `* as THREE` or ''. */
  clause: string
  /** True when the statement is statically importing. */
  isTypeOnly: boolean
  specifier: string
  /** Dynamic import('...') when true — allowed for lazy engines. */
  isDynamic: boolean
}

const STATIC_RE =
  /import\s+(type\s+)?((?:\{[^}]*\})|(?:\*\s+as\s+[\w$]+)|(?:[\w$]+)|(?:[\w$]+\s*,\s*\{[^}]*\}))?\s*(?:from\s*)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g
const EXPORT_FROM_RE =
  /export\s+(type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*['"]([^'"]+)['"]/g

export function scanImports(file: SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = []
  for (const match of file.text.matchAll(STATIC_RE)) {
    edges.push({
      file: file.path,
      clause: (match[2] ?? '').trim(),
      isTypeOnly: match[1] === 'type ',
      specifier: match[3],
      isDynamic: false
    })
  }
  for (const match of file.text.matchAll(EXPORT_FROM_RE)) {
    edges.push({
      file: file.path,
      clause: 'export-from',
      isTypeOnly: match[1] === 'type ',
      specifier: match[2],
      isDynamic: false
    })
  }
  for (const match of file.text.matchAll(DYNAMIC_RE)) {
    edges.push({
      file: file.path,
      clause: 'dynamic',
      isTypeOnly: false,
      specifier: match[1],
      isDynamic: true
    })
  }
  return edges
}

export function listAllFiles(): SourceFile[] {
  const dirs = ['packages', 'domains', 'scenes', 'apps', 'tooling']
  const files: SourceFile[] = []
  for (const dir of dirs) files.push(...listSourceFiles(dir))
  return files.filter((f) => !f.path.includes('.test.'))
}

export function edgeIsTypeOnly(edge: ImportEdge): boolean {
  if (edge.isTypeOnly) return true
  if (edge.clause === 'export-from') return false // checked separately via text
  // `import { type Foo } from 'x'` still has runtime import of the module.
  return false
}

/** True for `export type { ... } from 'mod'` statements. */
export function isTypeExportFrom(text: string, specifier: string): boolean {
  const re = new RegExp(
    `export\\s+type\\s+(?:\\*|\\{[^}]*\\})\\s*(?:as\\s+[\\w$]+\\s*)?from\\s*['"]${escapeRegExp(specifier)}['"]`
  )
  return re.test(text)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

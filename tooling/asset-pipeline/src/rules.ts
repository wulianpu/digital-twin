/** Pipeline rules for runtime assets (extend per deployment). */
export interface PipelineRule {
  readonly id: string
  check(descriptor: { kind: string; url?: string; ref: { id: string } }): string | undefined
}

export const DEFAULT_PIPELINE_RULES: readonly PipelineRule[] = [
  {
    id: 'glb-naming',
    check: (d) =>
      d.kind === 'glb' && d.url && !/\.glb$/.test(d.url)
        ? 'glb assets must end in .glb'
        : undefined
  },
  {
    id: 'tileset-naming',
    check: (d) =>
      d.kind === 'tileset' && d.url && !/tileset.*\.json$/.test(d.url)
        ? 'tilesets must point at a tileset*.json'
        : undefined
  },
  {
    id: 'kebab-id',
    check: (d) =>
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.ref.id)
        ? 'asset ids must be kebab-case'
        : undefined
  }
]

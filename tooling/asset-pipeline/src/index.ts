/**
 * Asset Pipeline tooling (§42): manifest validation and normalization rules.
 * Runtime assets are regenerable from sources; the manifest is the contract
 * between the pipeline and the platform ContentRegistry.
 */
export {
  defaultManifestDir,
  loadManifests,
  validateManifestDir,
  validateActiveManifests
} from './validate'
export { DEFAULT_PIPELINE_RULES, type PipelineRule } from './rules'

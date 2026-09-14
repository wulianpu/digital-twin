import type { QualityProfile } from '@twin/sdk'

/**
 * Portal runtime configuration (build-time Vite env, I1-1).
 * Absent values keep the built-in demo behavior — production deployments
 * override via .env / CI build args only, never code changes.
 */
export interface PortalConfig {
  /** Production platform gateway (§34/§81). Unset → built-in demo gateway. */
  readonly gatewayWsUrl: string | undefined
  /** Remote MapLibre style; unset → offline dark base style. */
  readonly mapStyleUrl: string | undefined
  /** Raster tile URL template for the offline style. */
  readonly rasterTilesUrl: string | undefined
  /** 3D Tiles global cache byte budget (§49). */
  readonly tilesMaxBytes: number
  /** Initial quality profile (§67). */
  readonly defaultQuality: QualityProfile
  /** I4-3：真实 3D Tiles tileset 入口（未配置则不加载任何 tileset）。 */
  readonly tilesTilesetUrl: string | undefined
  /** I4-2：KTX2/DRACO 解码器基础路径（离线部署指向本地静态目录）。 */
  readonly assetDecoderPath: string
  /** 视觉回归 fixture 模式（I9-6）：确定性渲染（冻结水体/固定数据）。 */
  readonly visualFixture: boolean
}

const QUALITIES: readonly QualityProfile[] = ['OFFICE', 'STANDARD', 'HIGH', 'EXHIBITION']

/** KTX2 basis 转码器默认随 three 版本走（exact pin，§78 升级时同步更新）。 */
const DEFAULT_DECODER_PATH = 'https://unpkg.com/three@0.186.0/examples/jsm/libs/basis/'

function str(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function loadPortalConfig(
  env: Record<string, unknown> = import.meta.env as Record<string, unknown>
): PortalConfig {
  const quality = str(env, 'VITE_DEFAULT_QUALITY')
  const tilesMaxBytes = Number(str(env, 'VITE_TILES_MAX_BYTES') ?? '')
  const fallbackBytes = 512 * 1024 * 1024
  return {
    gatewayWsUrl: str(env, 'VITE_GATEWAY_WS_URL'),
    mapStyleUrl: str(env, 'VITE_MAP_STYLE_URL'),
    rasterTilesUrl: str(env, 'VITE_RASTER_TILES_URL'),
    tilesMaxBytes: Number.isFinite(tilesMaxBytes) && tilesMaxBytes > 0 ? tilesMaxBytes : fallbackBytes,
    defaultQuality: QUALITIES.includes(quality as QualityProfile)
      ? (quality as QualityProfile)
      : 'STANDARD',
    tilesTilesetUrl: str(env, 'VITE_TILES_TILESET_URL'),
    assetDecoderPath: str(env, 'VITE_ASSET_DECODER_PATH') ?? DEFAULT_DECODER_PATH,
    visualFixture: str(env, 'VITE_VISUAL_FIXTURE') === '1'
  }
}

import { describe, expect, it } from 'vitest'
import { loadPortalConfig } from './config'

describe('portal config (I1)', () => {
  it('keeps demo behavior when nothing is configured', () => {
    const config = loadPortalConfig({})
    expect(config.gatewayWsUrl).toBeUndefined()
    expect(config.mapStyleUrl).toBeUndefined()
    expect(config.tilesMaxBytes).toBe(512 * 1024 * 1024)
    expect(config.defaultQuality).toBe('STANDARD')
  })

  it('parses gateway, style, tiles budget and quality', () => {
    const config = loadPortalConfig({
      VITE_GATEWAY_WS_URL: 'wss://gw.example/ws',
      VITE_MAP_STYLE_URL: 'https://styles.example/light.json',
      VITE_TILES_MAX_BYTES: '1024',
      VITE_DEFAULT_QUALITY: 'HIGH'
    })
    expect(config.gatewayWsUrl).toBe('wss://gw.example/ws')
    expect(config.mapStyleUrl).toBe('https://styles.example/light.json')
    expect(config.tilesMaxBytes).toBe(1024)
    expect(config.defaultQuality).toBe('HIGH')
  })

  it('falls back on invalid values instead of throwing', () => {
    const config = loadPortalConfig({
      VITE_GATEWAY_WS_URL: '   ',
      VITE_TILES_MAX_BYTES: 'not-a-number',
      VITE_DEFAULT_QUALITY: 'ULTRA'
    })
    expect(config.gatewayWsUrl).toBeUndefined()
    expect(config.tilesMaxBytes).toBe(512 * 1024 * 1024)
    expect(config.defaultQuality).toBe('STANDARD')
  })

  it('I4 配置：tileset 入口与解码器路径', () => {
    const config = loadPortalConfig({
      VITE_TILES_TILESET_URL: 'https://tiles.example/tileset.json',
      VITE_ASSET_DECODER_PATH: '/decoders/'
    })
    expect(config.tilesTilesetUrl).toBe('https://tiles.example/tileset.json')
    expect(config.assetDecoderPath).toBe('/decoders/')
  })

  it('I4 配置：解码器路径缺省指向随 three 版本的 CDN（exact pin 对齐）', () => {
    expect(loadPortalConfig({}).assetDecoderPath).toContain('0.186.0')
  })
})

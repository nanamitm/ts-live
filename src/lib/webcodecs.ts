// 型だけを参照する (Node の type-stripping は import type を消すので、
// テストから拡張子なしの解決を要求されない)。
import type { VideoStreamInfo } from './wasmmodule'

// WASM の probe が通知してくるストリーム情報から VideoDecoder の構成を組み立てる。
// 対応するのは HEVC (BS4K/8K) と H.264 (スカパープレミアム等) だけで、それ以外
// (MPEG-2 など) は null を返して WASM ソフトデコードに任せる。

// HEVC: hev1.<profile>.<互換フラグ>.L<general_level_idc>.<制約>
// profile は 1=Main / 2=Main10。general_level_idc は「レベル×30」で、
// 5.1 なら 153、8K で使う 6.1 なら 183。
const HEVC_FALLBACK_LEVEL = 153 // 5.1 (BS4K で実績のある値)

// H.264: avc1.<profile_idc><constraint_flags><level_idc> を16進で並べる。
const H264_FALLBACK_PROFILE = 100 // High
const H264_FALLBACK_LEVEL = 40 // 4.0

const hex2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase()

export const buildWebCodecsConfig = (
  info: VideoStreamInfo
): VideoDecoderConfig | null => {
  const withSize = (config: VideoDecoderConfig): VideoDecoderConfig => {
    if (info.width > 0 && info.height > 0) {
      config.codedWidth = info.width
      config.codedHeight = info.height
    }
    return config
  }

  if (info.codec === 'hevc') {
    // probe でプロファイル/レベルが取れないファイルがあるため、その場合は
    // Main10 L5.1 にフォールバックする。レベルを固定にすると 8K (L6.x) で
    // 構成が弾かれる。
    const profileTag = info.profile === 1 ? '1.6' : '2.4'
    const level = info.level > 0 ? info.level : HEVC_FALLBACK_LEVEL
    return withSize({
      codec: `hev1.${profileTag}.L${level}.90`,
      optimizeForLatency: true,
    })
  }

  if (info.codec === 'h264') {
    // Annex-B (description なし)。
    // NOTE: optimizeForLatency は付けない。Chrome はこれで FFmpeg デコーダを
    // low-delay にするが、B フレームを含む放送 H.264 では最初の I ピクチャの
    // 直後に Decoding error になる。
    const profile = info.profile > 0 ? info.profile : H264_FALLBACK_PROFILE
    const level = info.level > 0 ? info.level : H264_FALLBACK_LEVEL
    const prefix =
      profile === 66
        ? '42C0' // Baseline
        : profile === 77
        ? '4D40' // Main
        : profile === 100
        ? '6400' // High
        : hex2(profile) + '00'
    return withSize({ codec: `avc1.${prefix}${hex2(level)}` })
  }

  return null
}

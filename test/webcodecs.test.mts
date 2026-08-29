import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWebCodecsConfig } from '../src/lib/webcodecs.ts'
import type { VideoStreamInfo } from '../src/lib/wasmmodule.ts'

const info = (over: Partial<VideoStreamInfo> = {}): VideoStreamInfo => ({
  codec: 'hevc',
  width: 3840,
  height: 2160,
  profile: 2,
  level: 153,
  sarNum: 1,
  sarDen: 1,
  webCodecs: true,
  ...over,
})

test('HEVC Main10 5.1 (BS4K)', () => {
  const config = buildWebCodecsConfig(info())
  assert.equal(config?.codec, 'hev1.2.4.L153.90')
  assert.equal(config?.codedWidth, 3840)
  assert.equal(config?.codedHeight, 2160)
  assert.equal(config?.optimizeForLatency, true)
})

test('HEVC はレベルを probe の値から組み立てる (8K = L6.1)', () => {
  const config = buildWebCodecsConfig(
    info({ level: 183, width: 7680, height: 4320 })
  )
  assert.equal(config?.codec, 'hev1.2.4.L183.90')
  assert.equal(config?.codedWidth, 7680)
})

test('HEVC Main は互換フラグが変わる', () => {
  assert.equal(buildWebCodecsConfig(info({ profile: 1 }))?.codec, 'hev1.1.6.L153.90')
})

test('HEVC はレベル不明なら 5.1 にフォールバックする', () => {
  assert.equal(buildWebCodecsConfig(info({ level: 0 }))?.codec, 'hev1.2.4.L153.90')
  assert.equal(buildWebCodecsConfig(info({ level: -99 }))?.codec, 'hev1.2.4.L153.90')
})

test('HEVC はプロファイル不明なら Main10 とみなす', () => {
  assert.equal(buildWebCodecsConfig(info({ profile: -99 }))?.codec, 'hev1.2.4.L153.90')
})

test('H.264 は profile ごとの prefix を使い、遅延最適化は付けない', () => {
  const h264 = (over: Partial<VideoStreamInfo>) =>
    buildWebCodecsConfig(info({ codec: 'h264', width: 1440, height: 1080, ...over }))
  assert.equal(h264({ profile: 66, level: 30 })?.codec, 'avc1.42C01E') // Baseline 3.0
  assert.equal(h264({ profile: 77, level: 40 })?.codec, 'avc1.4D4028') // Main 4.0
  assert.equal(h264({ profile: 100, level: 41 })?.codec, 'avc1.640029') // High 4.1
  assert.equal(h264({ profile: 100, level: 40 })?.optimizeForLatency, undefined)
})

test('H.264 は未知の profile を16進で埋め、不明なら High@4.0', () => {
  const h264 = (over: Partial<VideoStreamInfo>) =>
    buildWebCodecsConfig(info({ codec: 'h264', ...over }))
  assert.equal(h264({ profile: 88, level: 40 })?.codec, 'avc1.580028')
  assert.equal(h264({ profile: 0, level: 0 })?.codec, 'avc1.640028')
})

test('解像度が取れないときは codedWidth/Height を付けない', () => {
  const config = buildWebCodecsConfig(info({ width: 0, height: 0 }))
  assert.equal(config?.codedWidth, undefined)
  assert.equal(config?.codedHeight, undefined)
})

test('対応しないコーデックは null (WASM ソフトデコードへ回す)', () => {
  assert.equal(buildWebCodecsConfig(info({ codec: 'mpeg2video' })), null)
  assert.equal(buildWebCodecsConfig(info({ codec: '' })), null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createProcessor } from './helpers/load-audio-processor.mjs'

const RENDER_QUANTUM = 128
// processor.js は再生開始前に 48000/10 サンプル溜まるのを待つ。
const START_THRESHOLD = 4800

// 連続したランプ(1,2,3,...)を様々な長さのバッファに分けて流し込み、出力に
// 欠落・重複が無いことを確かめる。バッファ境界をまたぐ処理の読み出し位置が
// ずれると、ここで飛び番になる。
test('出力はバッファ境界をまたいでも連続している', () => {
  const ctx = createProcessor()
  const lengths = [1024, 300, 128, 77, 2048, 500, 4096, 131]
  let next = 1
  for (const length of lengths) {
    const chunk = new Array(length)
    for (let i = 0; i < length; i++) chunk[i] = next++
    ctx.feed(chunk)
  }
  const total = lengths.reduce((a, b) => a + b, 0)
  assert.ok(total > START_THRESHOLD, 'テストは再生開始しきい値を超える必要がある')

  const rendered = []
  for (let i = 0; i < Math.ceil(total / RENDER_QUANTUM) + 2; i++) {
    const [left, right] = ctx.render(RENDER_QUANTUM)
    assert.deepEqual(Array.from(left), Array.from(right), 'L/R が一致しない')
    rendered.push(...left)
  }

  const played = rendered.filter(v => v !== 0)
  assert.deepEqual(
    played,
    Array.from({ length: total }, (_, i) => i + 1)
  )
})

test('バッファが溜まるまでは無音を返す', () => {
  const ctx = createProcessor()
  ctx.feed(new Array(256).fill(1))
  const [left] = ctx.render(RENDER_QUANTUM)
  assert.deepEqual(Array.from(left), new Array(RENDER_QUANTUM).fill(0))
})

test('枯渇したら無音で埋め、バッファ残量は負にならない', () => {
  const ctx = createProcessor()
  ctx.feed(new Array(START_THRESHOLD + 100).fill(1))
  for (let i = 0; i < Math.ceil((START_THRESHOLD + 100) / RENDER_QUANTUM) + 5; i++) {
    ctx.render(RENDER_QUANTUM)
  }
  assert.equal(ctx.processor.bufferedSamples, 0)
  const [left] = ctx.render(RENDER_QUANTUM)
  assert.deepEqual(Array.from(left), new Array(RENDER_QUANTUM).fill(0))
})

test('audio-feeder-processor として登録される', () => {
  const ctx = createProcessor()
  assert.deepEqual(ctx.registeredNames, ['audio-feeder-processor'])
})

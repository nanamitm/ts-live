import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalPositionEstimator } from '../src/lib/local-position.ts'

test('先読み済み量を位置に加えず、EOF後も固定レートで進む', () => {
  const estimator = new LocalPositionEstimator()
  estimator.update(100, 48000, false, false)
  estimator.update(103, 51000, false, false)
  assert.equal(estimator.position(0, 60000).bytes, 3000)
  // EOF時の短い最終チャンクはレートに混ぜない。
  estimator.update(104, 51500, true, false)
  estimator.update(110, 51500, true, false)
  assert.deepEqual(estimator.position(0, 60000), {
    bytes: 10000, size: 60000, seconds: 10, duration: 60, exact: false,
  })
  estimator.update(120, 51500, true, false)
  assert.equal(estimator.position(0, 60000).bytes, 20000)
  assert.equal(estimator.position(0, 60000).duration, 60)
})

test('一時停止中の先読みをレートに含めず、再開後に計測し直す', () => {
  const estimator = new LocalPositionEstimator()
  estimator.update(0, 0, false, false)
  estimator.update(3, 3000, false, false)
  estimator.update(3, 30000, false, true)
  estimator.update(3, 40000, false, true)
  assert.equal(estimator.position(0, 60000).bytes, 3000)
  estimator.update(3, 40000, false, false)
  estimator.update(6, 43000, false, false)
  assert.equal(estimator.position(0, 60000).bytes, 6000)
  assert.equal(estimator.position(0, 60000).duration, 60)
})

test('レート更新で過去の位置を再計算せず、平滑化したレートで進む', () => {
  const estimator = new LocalPositionEstimator()
  estimator.update(0, 0, false, false)
  estimator.update(3, 3000, false, false)
  estimator.update(6, 9000, false, false)
  assert.equal(estimator.position(0, 60000).bytes, 6000)
  estimator.update(8, 9000, true, false)
  assert.equal(estimator.position(0, 60000).bytes, 8500)
})

test('短いファイルは総時間不明のまま、シーク後は新しく推定する', () => {
  const estimator = new LocalPositionEstimator()
  estimator.update(-1, 0, false, false)
  estimator.update(100, 10000, true, false)
  estimator.update(110, 10000, true, false)
  assert.deepEqual(estimator.position(20000, 60000), {
    bytes: 20000, size: 60000, seconds: 0, duration: 0, exact: false,
  })
  const afterSeek = new LocalPositionEstimator()
  afterSeek.update(500, 1000, false, false)
  afterSeek.update(503, 4000, false, false)
  assert.equal(afterSeek.position(20000, 60000).bytes, 23000)
  assert.equal(afterSeek.position(20000, 22000).bytes, 22000)
  assert.equal(afterSeek.position(20000, 120000).duration, 120)
})

test('音声クロックの巻き戻りと停止で位置を戻さない', () => {
  const estimator = new LocalPositionEstimator()
  estimator.update(100, 1000, false, false)
  estimator.update(103, 4000, false, false)
  estimator.update(103, 4000, false, false)
  estimator.update(50, 5000, false, false)
  assert.equal(estimator.position(0, 60000).bytes, 3000)
})

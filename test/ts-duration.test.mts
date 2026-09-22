import test from 'node:test'
import assert from 'node:assert/strict'
import { readTsDuration } from '../src/lib/ts-duration.ts'
import { LocalPositionEstimator } from '../src/lib/local-position.ts'

test('TSの固定総時間は消費レートやEOFで変化しない', () => {
  const estimator = new LocalPositionEstimator(120)
  estimator.update(100, 0, false, false)
  estimator.update(103, 100000000, false, false)
  estimator.update(110, 100000001, true, false)
  assert.deepEqual(estimator.position(0, 12000), {
    bytes: 1000, size: 12000, seconds: 10, duration: 120,
  })
  estimator.update(110, 100000001, true, true)
  estimator.update(110, 100000001, true, false)
  assert.equal(estimator.position(0, 12000).seconds, 10)
})

test('TSのシーク後も総時間を保持し、音声クロックで位置を進める', () => {
  const estimator = new LocalPositionEstimator(120)
  assert.equal(estimator.position(6000, 12000).seconds, 60)
  estimator.update(500, 0, false, false)
  estimator.update(505, 10000, false, false)
  assert.equal(estimator.position(6000, 12000).seconds, 65)
  estimator.update(700, 10000, true, false)
  assert.equal(estimator.position(6000, 12000).bytes, 12000)
  assert.equal(estimator.position(6000, 12000).duration, 120)
})

test('TSでPTSが得られなければビットレート推定に戻さない', () => {
  const estimator = new LocalPositionEstimator(0)
  estimator.update(0, 0, false, false)
  estimator.update(10, 10000, false, false)
  assert.equal(estimator.position(0, 60000).duration, 0)
})

test('短いファイルは全体を一度だけ渡す', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  let buffer = new Uint8Array()
  const duration = await readTsDuration(new Blob([bytes]), {
    getTsDurationInputBuffer(size) { return buffer = new Uint8Array(size) },
    probeTsDuration(headSize, offset, tailSize, fileSize) {
      assert.deepEqual([headSize, offset, tailSize, fileSize], [4, 4, 0, 4])
      assert.deepEqual(buffer, bytes)
      return 0.04
    },
  })
  assert.equal(duration, 0.04)
})

test('大きなファイルは先頭と末尾だけ読み、PTSが無ければ探索を拡大する', async () => {
  const mb = 1024 * 1024
  const ranges: number[][] = []
  // 実際には確保しない巨大ファイル。4GB超の位置を32bitに丸めない。
  const file = {
    size: 5 * 1024 * mb,
    slice(start: number, end = this.size) {
      ranges.push([start, end])
      return new Blob([new Uint8Array(end - start)])
    },
  } as Blob
  let calls = 0
  const duration = await readTsDuration(file, {
    getTsDurationInputBuffer(size) { return new Uint8Array(size) },
    probeTsDuration(headSize, offset, tailSize, fileSize) {
      assert.equal(headSize, 4 * mb)
      assert.equal(offset + tailSize, fileSize)
      return ++calls === 2 ? 3600 : 0
    },
  })
  assert.equal(duration, 3600)
  assert.deepEqual(ranges, [[0, 4 * mb], [file.size - 4 * mb, file.size], [file.size - 16 * mb, file.size]])
})

test('ファイル切替で中止された解析はWASMを呼ばない', async () => {
  let aborted = false
  const file = {
    size: 188,
    slice() {
      aborted = true
      return new Blob([new Uint8Array(188)])
    },
  } as Blob
  const result = await readTsDuration(file, {
    getTsDurationInputBuffer() { throw new Error('stale probe') },
    probeTsDuration() { throw new Error('stale probe') },
  }, () => aborted)
  assert.equal(result, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTAINER_PROBE_SIZE,
  looksLikeTlv,
  looksLikeTs,
} from '../src/lib/container.ts'

// 指定した offset/stride に 0x47 を置いた擬似ヘッダを作る。
const syncedBuffer = (offset: number, stride: number, count = 24) => {
  const buf = new Uint8Array(CONTAINER_PROBE_SIZE)
  for (let i = 0; i < count; i++) {
    const pos = offset + i * stride
    if (pos < buf.length) buf[pos] = 0x47
  }
  return buf
}

test('188 バイト間隔の TS を判定する', () => {
  assert.equal(looksLikeTs(syncedBuffer(0, 188)), true)
  assert.equal(looksLikeTlv(syncedBuffer(0, 188)), false)
})

test('M2TS (192 バイト間隔, offset 4) を判定する', () => {
  assert.equal(looksLikeTs(syncedBuffer(4, 192)), true)
})

test('パケット境界に揃っていない TS/M2TS も判定する', () => {
  // 録画の途中から切り出したファイル。先頭は前のパケットの途中から始まる。
  for (const offset of [1, 100, 187]) {
    assert.equal(looksLikeTs(syncedBuffer(offset, 188)), true, `TS offset ${offset}`)
  }
  for (const offset of [0, 1, 150, 191]) {
    assert.equal(looksLikeTs(syncedBuffer(offset, 192)), true, `M2TS offset ${offset}`)
  }
})

test('同期バイトが並んでいなければ TLV とみなす', () => {
  const random = new Uint8Array(CONTAINER_PROBE_SIZE)
  for (let i = 0; i < random.length; i++) random[i] = (i * 31 + 7) % 251
  assert.equal(looksLikeTlv(random), true)
})

test('0x47 が数個あるだけでは TS と誤判定しない', () => {
  // 8 回中 5 回しか当たらない = しきい値(6)未満
  assert.equal(looksLikeTs(syncedBuffer(0, 188, 5)), false)
})

test('空/短いバッファでも例外にならず TLV 扱い', () => {
  assert.equal(looksLikeTlv(new Uint8Array(0)), true)
  assert.equal(looksLikeTlv(new Uint8Array([0x47])), true)
})

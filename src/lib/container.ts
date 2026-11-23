// ローカルファイル再生のコンテナ種別判定。
// MPEG-TS は同期バイト 0x47 が 188 バイト(M2TS なら 192 バイト)間隔で並ぶ。
// それらしく並んでいなければ BS4K の TLV(可変長)とみなす。

// 判定に必要な先頭バイト数。
export const CONTAINER_PROBE_SIZE = 192 * 24

export const findTsPacketLayout = (buf: Uint8Array) => {
  const hits = (start: number, stride: number) => {
    let hit = 0
    for (let i = 0; i < 8; i++) {
      const pos = start + i * stride
      if (pos < buf.length && buf[pos] === 0x47) hit++
    }
    return hit >= 6
  }
  // 188=通常TS, 192=M2TS(4バイトタイムスタンプ付なら同期バイトは offset 4)。
  // 録画の途中から切り出したファイルは先頭がパケット境界に揃っていないので、
  // 最初のパケット 1 個ぶんのどの位置から並んでいてもよい。
  for (const stride of [188, 192]) {
    for (let start = 0; start < stride; start++) {
      if (hits(start, stride)) return { stride, syncOffset: start }
    }
  }
  return undefined
}

export const looksLikeTs = (buf: Uint8Array): boolean => findTsPacketLayout(buf) !== undefined
export const looksLikeTlv = (buf: Uint8Array): boolean => !looksLikeTs(buf)

export const m2tsSyncAtOrAfter = (offset: number, syncOffset: number) =>
  syncOffset + Math.max(0, Math.ceil((offset - syncOffset) / 192)) * 192

// The stream starts at a sync byte. Each following 4-byte timestamp must be
// dropped even when it is split across file stream chunks.
export const stripM2tsTimestamps = () => {
  let packetOffset = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const ts = new Uint8Array(chunk.length)
      let written = 0
      for (let offset = 0; offset < chunk.length;) {
        const end = packetOffset < 188 ? 188 : 192
        const length = Math.min(end - packetOffset, chunk.length - offset)
        if (packetOffset < 188) {
          ts.set(chunk.subarray(offset, offset + length), written)
          written += length
        }
        offset += length
        packetOffset = (packetOffset + length) % 192
      }
      if (written) controller.enqueue(ts.subarray(0, written))
    },
  })
}

// ローカルファイル再生のコンテナ種別判定。
// MPEG-TS は同期バイト 0x47 が 188 バイト(M2TS なら 192 バイト)間隔で並ぶ。
// それらしく並んでいなければ BS4K の TLV(可変長)とみなす。

// 判定に必要な先頭バイト数。
export const CONTAINER_PROBE_SIZE = 192 * 24

export const looksLikeTs = (buf: Uint8Array): boolean => {
  const hits = (start: number, stride: number) => {
    let hit = 0
    for (let i = 0; i < 8; i++) {
      const pos = start + i * stride
      if (pos < buf.length && buf[pos] === 0x47) hit++
    }
    return hit >= 6
  }
  // 188=通常TS, 192(offset4)=M2TS(4バイトタイムスタンプ付), 192(offset0)も一応
  return hits(0, 188) || hits(4, 192) || hits(0, 192)
}

export const looksLikeTlv = (buf: Uint8Array): boolean => !looksLikeTs(buf)

// ARIB-TTML (4K/8K MMT 字幕, STD-B62) を描画するための純粋なパーサ群。
// 描画(Canvas)から切り離してあるので単体テストできる。

// "128px" のような値から数値だけを取り出す。
export const parsePx = (v: string | null | undefined): number => {
  if (!v) return 0
  const m = v.match(/-?\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : 0
}

// "100px 200px" のような 2 値を取り出す。取れなければ [0, 0]。
export const parsePair = (v: string | null | undefined): [number, number] => {
  const nums = v ? v.match(/-?\d+(?:\.\d+)?/g) : null
  if (!nums || nums.length < 2) return [0, 0]
  return [parseFloat(nums[0]), parseFloat(nums[1])]
}

// TTML の色は #RRGGBB または #RRGGBBAA。Canvas 用の rgba() へ変換する。
export const cssColor = (v: string | null | undefined): string | null => {
  if (!v) return null
  const m = v.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/)
  if (!m) return null
  const r = parseInt(m[1].slice(0, 2), 16)
  const g = parseInt(m[1].slice(2, 4), 16)
  const b = parseInt(m[1].slice(4, 6), 16)
  const a = m[2] !== undefined ? parseInt(m[2], 16) / 255 : 1
  return `rgba(${r},${g},${b},${a})`
}

export type TtmlOutline = { color: string; width: number }

// tts:textOutline ("色 太さ")。太さ省略時は 4px 相当。
export const parseOutline = (
  v: string | null | undefined
): TtmlOutline | null => {
  if (!v) return null
  const parts = v.trim().split(/\s+/)
  return {
    color: cssColor(parts[0]) || 'rgba(0,0,0,1)',
    width: parts[1] ? parsePx(parts[1]) : 4,
  }
}

// TTML の begin/end は clock-time(HH:MM:SS(.mmm))。秒に変換する。
export const parseClock = (v: string): number | null => {
  const m = v.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mi = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  const frac = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) / 1000 : 0
  return h * 3600 + mi * 60 + s + frac
}

// 先頭 <div> の begin/end を秒で取り出す。
export const parseTtmlTiming = (
  xml: string
): { begin: number | null; end: number | null } => {
  const bm = xml.match(/<div\b[^>]*\bbegin="([^"]+)"/)
  const em = xml.match(/<div\b[^>]*\bend="([^"]+)"/)
  return {
    begin: bm ? parseClock(bm[1]) : null,
    end: em ? parseClock(em[1]) : null,
  }
}

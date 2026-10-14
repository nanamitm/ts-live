// ARIB-TTML (4K/8K MMT 字幕, STD-B62 / TR-B39) を描画するための純粋な関数群。
// TTML の解析(スタイル継承・入れ子 span・xml:space・タイミングの合成)は
// WASM に組み込んだ dantto4k の parser/resolver が行い、ここではその結果
// (TtmlDocument)の時刻合わせと配置の計算をする。描画(Canvas)から切り離して
// あるので単体テストできる。

export type TtmlColor = [number, number, number, number]
export type TtmlPair = [number, number]

// 解決済みのスタイル。値は TTML の座標系(px)のまま。
export type TtmlStyle = {
  backgroundColor?: TtmlColor
  color?: TtmlColor
  origin?: TtmlPair
  extent?: TtmlPair
  // [横, 縦]。横が縦より小さいのは半角(中型)。
  fontSize?: TtmlPair
  fontFamily?: string
  fontStyle?: 'normal' | 'italic'
  fontWeight?: 'normal' | 'bold'
  // null は normal。
  lineHeight?: number | null
  underline?: boolean
  textOutline?: { color?: TtmlColor; width: number; blur: number }
  writingMode?: 'lrtb' | 'tbrl'
  letterSpacing?: number
  ruby?: string
  borderTop?: boolean
  borderRight?: boolean
  borderBottom?: boolean
  borderLeft?: boolean
  flashing?: boolean
}

export type TtmlRegion = { id: string; style: TtmlStyle }

// 文書の時刻 0(TMD=0010 なら reference_start_time)からの秒。未指定は
// 文書が表示されている間ずっと。
export type TtmlTiming = { begin?: number; end?: number }

export type TtmlSpan = TtmlTiming & {
  style: TtmlStyle
  region?: TtmlRegion
  // 文字列と、<br/> を表す null。
  content: Array<string | null>
}

export type TtmlParagraph = TtmlTiming & {
  style: TtmlStyle
  region?: TtmlRegion
  spans: TtmlSpan[]
}

export type TtmlDocument = TtmlTiming & {
  error?: string
  paragraphs: TtmlParagraph[]
}

// ARIB STD-B60 の TMD。
export const TMD_REFERENCE_START_TIME = 0b0010
export const TMD_NO_TIME_CONTROL = 0b1111

// 字幕プレーンの大きさ(ARIB STD-B60 の resolution)。不明なら 4K。
export const ttmlPlaneSize = (resolution: number): TtmlPair => {
  switch (resolution) {
    case 0b0000:
      return [1920, 1080]
    case 0b0010:
      return [7680, 4320]
    default:
      return [3840, 2160]
  }
}

export const ttmlColor = (c: TtmlColor | undefined): string | null =>
  c ? `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})` : null

export const sameTtmlColor = (
  a: TtmlColor | undefined,
  b: TtmlColor | undefined
): boolean =>
  a === b || (!!a && !!b && a.every((v, i) => v === b[i]))

// at(文書の時刻)に表示されているか。
export const isTtmlActive = (t: TtmlTiming, at: number): boolean =>
  (t.begin ?? -Infinity) <= at && at < (t.end ?? Infinity)

// 表示が切り替わりうる時刻(begin/end)を昇順で返す。
export const ttmlBoundaries = (doc: TtmlDocument): number[] => {
  const times = new Set<number>()
  const add = (t: TtmlTiming) => {
    if (t.begin !== undefined) times.add(t.begin)
    if (t.end !== undefined) times.add(t.end)
  }
  for (const p of doc.paragraphs) {
    for (const s of p.spans) add(s)
  }
  return Array.from(times).sort((a, b) => a - b)
}

// 文書で最初に何かが表示される時刻。begin が無ければ undefined(時刻 0 から)。
export const ttmlFirstBegin = (doc: TtmlDocument): number | undefined => {
  let first: number | undefined
  for (const p of doc.paragraphs) {
    for (const s of p.spans) {
      const b = s.begin ?? -Infinity
      if (first === undefined || b < first) first = b
    }
  }
  if (first === undefined) return doc.begin
  return Number.isFinite(first) ? first : undefined
}

// 文書を再生時刻(メディア時刻・秒)のどこに置くかを決める状態。
// reference_start_time が無いときは、最初の字幕の begin を到着時の再生時刻に
// 合わせ、以後その対応を使い回す(番組境界・アセット乗り換えで取り直す)。
export type TtmlClock = {
  base: number | null
  lastBegin: number
  stream: number
}

export const initialTtmlClock = (): TtmlClock => ({
  base: null,
  lastBegin: -1,
  stream: -1,
})

// 基準時刻より字幕が大きく先にある場合は、前の番組から残った基準時刻など
// 壊れた記述子とみなして再生時刻に合わせる(dantto4k と同じ 30 秒)。
export const TTML_MAX_LEAD = 30
// 基準時刻の無い文書で begin がこれ以上巻き戻ったら番組境界とみなす。
const ROLLBACK_TOLERANCE = 5

export type TtmlPlacement = {
  // 文書の時刻 0 に当たる再生時刻。begin/end にこれを足すと再生時刻になる。
  base: number
  // TMD=1111: 時刻制御なし。届いた時点で全体を表示する。
  immediate: boolean
  clock: TtmlClock
}

export const placeTtml = (
  doc: TtmlDocument,
  args: {
    tmd: number
    referenceStartTime: number
    now: number
    streamIndex: number
  },
  clock: TtmlClock
): TtmlPlacement => {
  const { tmd, referenceStartTime, now, streamIndex } = args
  if (tmd === TMD_NO_TIME_CONTROL) {
    return { base: now, immediate: true, clock }
  }
  const first = ttmlFirstBegin(doc) ?? 0
  if (
    tmd === TMD_REFERENCE_START_TIME &&
    Number.isFinite(referenceStartTime) &&
    referenceStartTime + first <= now + TTML_MAX_LEAD
  ) {
    // 遅れて届いた文書は、最初の字幕が今になるよう全体をずらす(表示時間を
    // 保つ)。dantto4k の B24 変換と同じ扱い。
    const late = now - (referenceStartTime + first)
    return {
      base: referenceStartTime + Math.max(0, late),
      immediate: false,
      clock,
    }
  }

  // 基準時刻が使えない: 到着時の再生時刻に合わせる。
  const streamChanged = clock.stream >= 0 && streamIndex !== clock.stream
  let base = clock.base
  if (
    base === null ||
    streamChanged ||
    first + ROLLBACK_TOLERANCE < clock.lastBegin ||
    base + first - now > TTML_MAX_LEAD
  ) {
    base = now - first
  }
  return {
    base,
    immediate: false,
    clock: { base, lastBegin: first, stream: streamIndex },
  }
}

// 縦書きで字形の変わる約物を、縦書き用の字形(Unicode の Vertical Forms /
// CJK Compatibility Forms)にする。dantto4k の B24 変換と同じ表。
const VERTICAL_FORMS: Record<number, number> = {
  0xff0c: 0xfe10,
  0x3001: 0xfe11,
  0x3002: 0xfe12,
  0xff1a: 0xfe13,
  0xff1b: 0xfe14,
  0x3016: 0xfe17,
  0x3017: 0xfe18,
  0x2026: 0xfe19,
  0x2025: 0xfe30,
  0x30fc: 0xfe31,
  0x2014: 0xfe31,
  0x2015: 0xfe31,
  0x2013: 0xfe32,
  0xff3f: 0xfe33,
  0xff08: 0xfe35,
  0xff09: 0xfe36,
  0xff5b: 0xfe37,
  0xff5d: 0xfe38,
  0x3014: 0xfe39,
  0x3015: 0xfe3a,
  0x3010: 0xfe3b,
  0x3011: 0xfe3c,
  0x300a: 0xfe3d,
  0x300b: 0xfe3e,
  0x3008: 0xfe3f,
  0x3009: 0xfe40,
  0x300c: 0xfe41,
  0x300d: 0xfe42,
  0x300e: 0xfe43,
  0x300f: 0xfe44,
  0xff3b: 0xfe47,
  0xff3d: 0xfe48,
  0xff5e: 0x2240,
  0x301c: 0x2240,
  0xff0d: 0xff5c,
  0xff1d: 0x2016,
  0x2010: 0xfe32,
  0x2016: 0xff1d,
  0xff5c: 0x2015,
  0x25b6: 0x25bc,
  0x25c0: 0x25b2,
}

export const verticalForm = (ch: string): string => {
  const cp = ch.codePointAt(0)
  const v = cp === undefined ? undefined : VERTICAL_FORMS[cp]
  return v === undefined ? ch : String.fromCodePoint(v)
}

// 縦書きではセルの右上に寄せる小書きの仮名(ARIB TR-B39 表 8-4)。
export const isSmallKana = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0
  return (
    [
      0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087,
      0x308e, 0x3095, 0x3096, 0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, 0x30c3,
      0x30e3, 0x30e5, 0x30e7, 0x30ee, 0x30f5, 0x30f6,
    ].includes(cp) ||
    (cp >= 0x31f0 && cp <= 0x31ff)
  )
}

// --- 配置 --------------------------------------------------------------
// 文字は 1 文字ずつ固定のセルに置く(ARIB の字幕は字詰めをしない)。セルの
// 大きさは fontSize の [横, 縦] で、文字の送りはそれに letter-spacing を足した
// もの。字形はセルの中に letter-spacing の半分だけ寄せて置く(ARIB TR-B39
// 8.3.4 の文字表示領域)。縦書きの扱いは dantto4k の B24 変換に合わせている。

export type TtmlRect = {
  x: number
  y: number
  w: number
  h: number
  color: TtmlColor
}

// 字形 1 つ。(x, y) から w×h の枠に、字形の全角の枠を合わせて描く。
export type TtmlGlyph = {
  ch: string
  x: number
  y: number
  w: number
  h: number
  style: TtmlStyle
}

export type TtmlLayout = {
  backgrounds: TtmlRect[]
  glyphs: TtmlGlyph[]
}

const DEFAULT_FONT_SIZE = 144

type Run = { text: string; style: TtmlStyle }

// 表示中の span を <br/> で行に分ける。
const ttmlLines = (spans: TtmlSpan[]): Run[][] => {
  const lines: Run[][] = [[]]
  for (const s of spans) {
    for (const item of s.content) {
      if (item === null) {
        lines.push([])
      } else if (item.length > 0) {
        lines[lines.length - 1].push({ text: item, style: s.style })
      }
    }
  }
  return lines
}

const fontSizeOf = (style: TtmlStyle): TtmlPair => {
  const [w, h] = style.fontSize ?? [DEFAULT_FONT_SIZE, DEFAULT_FONT_SIZE]
  return [w > 0 ? w : h, h > 0 ? h : DEFAULT_FONT_SIZE]
}

const letterSpacingOf = (style: TtmlStyle): number =>
  Math.max(0, style.letterSpacing ?? 0)

const visibleColor = (c: TtmlColor | undefined): c is TtmlColor =>
  !!c && c[3] > 0

export const layoutTtml = (doc: TtmlDocument, at: number): TtmlLayout => {
  const out: TtmlLayout = { backgrounds: [], glyphs: [] }
  for (const p of doc.paragraphs) {
    const region = p.region?.style
    if (!region?.origin) continue
    const spans = p.spans.filter(s => isTtmlActive(s, at))
    if (spans.length === 0) continue
    const lines = ttmlLines(spans)
    if (lines.every(l => l.length === 0)) continue

    const [ox, oy] = region.origin
    const [ew, eh] = region.extent ?? [0, 0]
    const regionBg = region.backgroundColor
    if (visibleColor(regionBg) && ew > 0 && eh > 0) {
      out.backgrounds.push({ x: ox, y: oy, w: ew, h: eh, color: regionBg })
    }
    // span の背景色。resolver は領域の背景色も継承させるので、領域と同じ
    // 色は二重に塗らない(半透明が濃くなる)。
    const spanBg = (style: TtmlStyle): TtmlColor | undefined =>
      visibleColor(style.backgroundColor) &&
      !sameTtmlColor(style.backgroundColor, regionBg)
        ? style.backgroundColor
        : undefined

    if (region.writingMode === 'tbrl' && region.extent) {
      layoutVertical(out, lines, ox + ew, oy, spanBg)
    } else {
      layoutHorizontal(out, lines, ox, oy, spanBg)
    }
  }
  return out
}

const layoutHorizontal = (
  out: TtmlLayout,
  lines: Run[][],
  ox: number,
  oy: number,
  spanBg: (style: TtmlStyle) => TtmlColor | undefined
) => {
  let lineTop = oy
  for (const line of lines) {
    // 行の高さは行内で最大の lineHeight(normal は文字の高さの 1.2 倍)。
    let lineHeight = 0
    for (const { style } of line) {
      const [, h] = fontSizeOf(style)
      lineHeight = Math.max(lineHeight, style.lineHeight ?? h * 1.2)
    }
    if (line.length === 0) {
      lineHeight = DEFAULT_FONT_SIZE * 1.2
    }
    let x = ox
    for (const { text, style } of line) {
      const [w, h] = fontSizeOf(style)
      const ls = letterSpacingOf(style)
      const advance = w + ls
      const chars = Array.from(text)
      const bg = spanBg(style)
      if (bg) {
        out.backgrounds.push({
          x,
          y: lineTop,
          w: advance * chars.length,
          h: lineHeight,
          color: bg,
        })
      }
      // 文字は行の高さの中で上下中央に置く。
      const top = lineTop + (lineHeight - h) / 2
      for (const ch of chars) {
        out.glyphs.push({ ch, x: x + ls / 2, y: top, w, h, style })
        x += advance
      }
    }
    lineTop += lineHeight
  }
}

// 縦書き: 行は領域の右端から左へ並ぶ列、文字は列を上から下へ。半角の
// 2 文字だけの並び(2 桁の数字など)は 1 つのセルに横に並べ(縦中横)、
// 小書きの仮名はセルの右上へ字形の 1/8 ずらす。
const layoutVertical = (
  out: TtmlLayout,
  lines: Run[][],
  right: number,
  top: number,
  spanBg: (style: TtmlStyle) => TtmlColor | undefined
) => {
  let columnRight = right
  for (const line of lines) {
    let columnWidth = 0
    for (const { style } of line) {
      const [w] = fontSizeOf(style)
      columnWidth = Math.max(columnWidth, style.lineHeight ?? w * 1.2)
    }
    if (line.length === 0) {
      columnWidth = DEFAULT_FONT_SIZE * 1.2
    }
    const columnLeft = columnRight - columnWidth
    let y = top
    for (const { text, style } of line) {
      const [w, h] = fontSizeOf(style)
      const ls = letterSpacingOf(style)
      const step = h + ls
      const x = columnLeft + (columnWidth - w) / 2
      const chars = Array.from(text)
      const halfWidth = w < h
      const tateChuYoko = halfWidth && chars.length === 2
      const cells = tateChuYoko ? 1 : chars.length
      const bg = spanBg(style)
      if (bg) {
        out.backgrounds.push({
          x: columnLeft,
          y,
          w: columnWidth,
          h: step * cells,
          color: bg,
        })
      }
      if (tateChuYoko) {
        chars.forEach((ch, i) => {
          out.glyphs.push({
            ch,
            x: x + (i === 0 ? -0.5 : 0.5) * w,
            y: y + ls / 2,
            w,
            h,
            style,
          })
        })
        y += step
        continue
      }
      for (const ch of chars) {
        const small = isSmallKana(ch)
        out.glyphs.push({
          ch: verticalForm(ch),
          x: x + (small ? w / 8 : 0),
          y: y + ls / 2 - (small ? h / 8 : 0),
          w,
          h,
          style,
        })
        y += step
      }
    }
    columnRight = columnLeft
  }
}

// SVG フォント(DRCS 字幕リソース)の unicode / unicode-range 属性値から
// コードポイントを 1 つ取り出す。受け付ける形式:
//   - 文字そのもの("")
//   - "U+E001" や範囲 "U+E001-E0FF"(範囲は先頭を使う)
//   - 二重にエスケープされて残った文字参照("&#xE001;" / "&#57345;")
// 文字参照を文字列のまま読むと '&'(U+0026)に登録されてしまうので、
// 解釈できなければ undefined を返す。
export const parseCodepointAttribute = (
  value: string | null | undefined
): number | undefined => {
  if (!value) return undefined
  const ref = value.match(/^&#(x?)([0-9a-fA-F]+);?$/i)
  if (ref) {
    const cp = parseInt(ref[2], ref[1] ? 16 : 10)
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? cp : undefined
  }
  if (value.startsWith('&#')) return undefined
  const range = value.match(/^[uU]\+([0-9a-fA-F?]+)/)
  if (range) {
    // "U+E0??" のようなワイルドカード範囲は先頭(? を 0 とみなす)を使う。
    const cp = parseInt(range[1].replace(/\?/g, '0'), 16)
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? cp : undefined
  }
  return value.codePointAt(0)
}

// TTML 文書の本文に、cps に含まれるコードポイントがあるか。
export const ttmlUsesAnyCodepoint = (
  doc: TtmlDocument,
  cps: Iterable<number>
): boolean => {
  const wanted = new Set(cps)
  if (wanted.size === 0) return false
  for (const p of doc.paragraphs) {
    for (const s of p.spans) {
      for (const text of s.content) {
        if (text === null) continue
        for (const ch of text) {
          const cp = ch.codePointAt(0)
          if (cp !== undefined && wanted.has(cp)) return true
        }
      }
    }
  }
  return false
}

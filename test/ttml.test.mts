import test from 'node:test'
import assert from 'node:assert/strict'
import type { TtmlDocument, TtmlStyle } from '../src/lib/ttml.ts'
import {
  initialTtmlClock,
  isSmallKana,
  isTtmlActive,
  layoutTtml,
  parseCodepointAttribute,
  placeTtml,
  ttmlBoundaries,
  ttmlColor,
  ttmlFirstBegin,
  ttmlPlaneSize,
  ttmlUsesAnyCodepoint,
  verticalForm,
} from '../src/lib/ttml.ts'

// 実放送と同じ形(全角 144px、半角 72x144px、行の高さ 240px、字間 16/8px、
// 半透明の黒地)のスタイル。
const normal: TtmlStyle = {
  fontSize: [144, 144],
  lineHeight: 240,
  letterSpacing: 16,
  color: [255, 255, 255, 255],
  backgroundColor: [0, 0, 0, 128],
  writingMode: 'lrtb',
}
const middle: TtmlStyle = { ...normal, fontSize: [72, 144], letterSpacing: 8 }

const doc = (
  paragraphs: TtmlDocument['paragraphs'],
  timing: { begin?: number; end?: number } = {}
): TtmlDocument => ({ ...timing, paragraphs })

const region = (
  origin: [number, number],
  extent: [number, number],
  extra: TtmlStyle = {}
) => ({ id: 'r', style: { origin, extent, ...extra } })

test('ttmlColor は RGBA を rgba() にする', () => {
  assert.equal(ttmlColor([255, 255, 0, 255]), 'rgba(255,255,0,1)')
  assert.equal(ttmlColor([0, 0, 0, 0]), 'rgba(0,0,0,0)')
  assert.equal(ttmlColor(undefined), null)
})

test('ttmlPlaneSize は resolution の符号から字幕プレーンの大きさを返す', () => {
  assert.deepEqual(ttmlPlaneSize(0), [1920, 1080])
  assert.deepEqual(ttmlPlaneSize(1), [3840, 2160])
  assert.deepEqual(ttmlPlaneSize(2), [7680, 4320])
  assert.deepEqual(ttmlPlaneSize(-1), [3840, 2160])
})

test('isTtmlActive は begin を含み end を含まない。未指定は無制限', () => {
  assert.equal(isTtmlActive({ begin: 1, end: 2 }, 1), true)
  assert.equal(isTtmlActive({ begin: 1, end: 2 }, 2), false)
  assert.equal(isTtmlActive({ begin: 1, end: 2 }, 0.5), false)
  assert.equal(isTtmlActive({}, -100), true)
  assert.equal(isTtmlActive({ begin: 3 }, 1e9), true)
})

test('ttmlBoundaries と ttmlFirstBegin は span の時刻から求める', () => {
  const d = doc([
    {
      style: {},
      spans: [
        { begin: 5, end: 8, style: normal, content: ['あ'] },
        { begin: 2, end: 5, style: normal, content: ['い'] },
      ],
    },
  ])
  assert.deepEqual(ttmlBoundaries(d), [2, 5, 8])
  assert.equal(ttmlFirstBegin(d), 2)
  // begin の無い span があれば文書の時刻 0 から表示される
  const open = doc([{ style: {}, spans: [{ style: normal, content: ['あ'] }] }])
  assert.equal(ttmlFirstBegin(open), undefined)
  assert.equal(ttmlFirstBegin(doc([], { begin: 4 })), 4)
})

test('placeTtml: TMD=0010 は reference_start_time を起点にする', () => {
  const d = doc([
    {
      style: {},
      spans: [{ begin: 10, end: 12, style: normal, content: ['あ'] }],
    },
  ])
  // 字幕は再生より先に届く(デマルチプレクサが先行している)
  const ahead = placeTtml(
    d,
    { tmd: 2, referenceStartTime: 1000, now: 1008, streamIndex: 3 },
    initialTtmlClock()
  )
  assert.equal(ahead.base, 1000)
  assert.equal(ahead.immediate, false)
  // begin を過ぎて届いた文書は、最初の字幕が今になるよう全体をずらす
  const late = placeTtml(
    d,
    { tmd: 2, referenceStartTime: 1000, now: 1010.5, streamIndex: 3 },
    initialTtmlClock()
  )
  assert.equal(late.base, 1000.5)
})

test('placeTtml: 基準時刻が先過ぎる・無いときは到着時の再生時刻に合わせる', () => {
  const d = doc([
    { style: {}, spans: [{ begin: 100, style: normal, content: ['あ'] }] },
  ])
  const stale = placeTtml(
    d,
    { tmd: 2, referenceStartTime: 1000, now: 1050, streamIndex: 3 },
    initialTtmlClock()
  )
  assert.equal(stale.base, 950)
  const none = placeTtml(
    d,
    { tmd: 2, referenceStartTime: NaN, now: 500, streamIndex: 3 },
    initialTtmlClock()
  )
  assert.equal(none.base, 400)
  // 2 つ目の文書は同じ対応を使う
  const second = doc([
    { style: {}, spans: [{ begin: 103, style: normal, content: ['い'] }] },
  ])
  const next = placeTtml(
    second,
    { tmd: 0, referenceStartTime: NaN, now: 502, streamIndex: 3 },
    none.clock
  )
  assert.equal(next.base, 400)
  // アセットが変われば取り直す
  const switched = placeTtml(
    second,
    { tmd: 0, referenceStartTime: NaN, now: 502, streamIndex: 4 },
    none.clock
  )
  assert.equal(switched.base, 399)
})

test('placeTtml: TMD=1111 は届いた時点で表示する', () => {
  const p = placeTtml(
    doc([]),
    { tmd: 15, referenceStartTime: NaN, now: 7, streamIndex: 1 },
    initialTtmlClock()
  )
  assert.equal(p.immediate, true)
})

test('layoutTtml: 横書きは文字ごとのセルに置き、行の高さの中で上下中央', () => {
  const d = doc([
    {
      region: region([552, 1796], [1040, 240]),
      style: {},
      spans: [
        { style: normal, content: ['あい'] },
        { style: middle, content: ['（'] },
      ],
    },
  ])
  const { glyphs, backgrounds } = layoutTtml(d, 0)
  assert.deepEqual(
    glyphs.map(g => [g.ch, g.x, g.y, g.w, g.h]),
    [
      ['あ', 560, 1844, 144, 144],
      ['い', 720, 1844, 144, 144],
      ['（', 876, 1844, 72, 144],
    ]
  )
  // 背景は span ごとに 送り幅×行の高さ
  assert.deepEqual(
    backgrounds.map(b => [b.x, b.y, b.w, b.h]),
    [
      [552, 1796, 320, 240],
      [872, 1796, 80, 240],
    ]
  )
})

test('layoutTtml: <br/> で改行し、時刻外の span は描かない', () => {
  const d = doc([
    {
      region: region([0, 0], [1000, 480]),
      style: {},
      spans: [
        { begin: 0, end: 5, style: normal, content: ['あ', null, 'い'] },
        { begin: 5, end: 9, style: normal, content: ['う'] },
      ],
    },
  ])
  assert.deepEqual(
    layoutTtml(d, 1).glyphs.map(g => [g.ch, g.x, g.y]),
    [
      ['あ', 8, 48],
      ['い', 8, 288],
    ]
  )
  assert.deepEqual(
    layoutTtml(d, 6).glyphs.map(g => g.ch),
    ['う']
  )
  assert.equal(layoutTtml(d, 10).glyphs.length, 0)
})

test('layoutTtml: 領域の背景と同じ色の span 背景は重ねて塗らない', () => {
  const d = doc([
    {
      region: region([0, 0], [400, 240], { backgroundColor: [0, 0, 0, 128] }),
      style: {},
      spans: [{ style: normal, content: ['あ'] }],
    },
  ])
  assert.deepEqual(
    layoutTtml(d, 0).backgrounds.map(b => [b.x, b.y, b.w, b.h]),
    [[0, 0, 400, 240]]
  )
})

test('layoutTtml: 縦書きは右端の列から下へ。縦中横・小書き仮名・縦書き字形', () => {
  const vertical: TtmlStyle = { ...normal, backgroundColor: undefined }
  const half: TtmlStyle = { ...middle, backgroundColor: undefined }
  const d = doc([
    {
      region: region([1000, 100], [480, 1000], { writingMode: 'tbrl' }),
      style: {},
      spans: [
        { style: vertical, content: ['ゃ、'] },
        { style: half, content: ['12'] },
        { style: vertical, content: [null, 'あ'] },
      ],
    },
  ])
  const g = layoutTtml(d, 0).glyphs.map(x => [x.ch, x.x, x.y])
  assert.deepEqual(g, [
    // 列は右端 1480 から幅 240(lineHeight)、全角の字形は列の中央(x=1288)
    ['ゃ', 1288 + 18, 108 - 18],
    ['︑', 1288, 268],
    // 縦中横: 2 文字で 1 セル(送り 152)、半角の字形の位置(x=1324)から
    // 左右に半角の半分ずつ
    ['1', 1324 - 36, 424],
    ['2', 1324 + 36, 424],
    // 次の列(1000〜1240)
    ['あ', 1048, 108],
  ])
})

test('verticalForm と isSmallKana', () => {
  assert.equal(verticalForm('ー'), '︱')
  assert.equal(verticalForm('「'), '﹁')
  assert.equal(verticalForm('あ'), 'あ')
  assert.equal(isSmallKana('っ'), true)
  assert.equal(isSmallKana('つ'), false)
})

test('parseCodepointAttribute は文字・U+表記・範囲・文字参照を読む', () => {
  assert.equal(parseCodepointAttribute(''), 0xe001)
  assert.equal(parseCodepointAttribute('\u{F0001}'), 0xf0001)
  assert.equal(parseCodepointAttribute('U+E001'), 0xe001)
  assert.equal(parseCodepointAttribute('u+e001-e0ff'), 0xe001)
  assert.equal(parseCodepointAttribute('U+E0??'), 0xe000)
  assert.equal(parseCodepointAttribute('&#xE001;'), 0xe001)
  assert.equal(parseCodepointAttribute('&#57345;'), 0xe001)
})

test('parseCodepointAttribute は読めない値で undefined を返す', () => {
  assert.equal(parseCodepointAttribute(''), undefined)
  assert.equal(parseCodepointAttribute(null), undefined)
  assert.equal(parseCodepointAttribute(undefined), undefined)
  // 文字参照の書き損じを '&'(U+0026)として登録しない
  assert.equal(parseCodepointAttribute('&#xZZ;'), undefined)
  assert.equal(parseCodepointAttribute('U+110000'), undefined)
})

test('ttmlUsesAnyCodepoint は本文の文字を見る', () => {
  const d = doc([
    { style: {}, spans: [{ style: normal, content: ['あ', null] }] },
  ])
  assert.equal(ttmlUsesAnyCodepoint(d, [0xe001]), true)
  assert.equal(ttmlUsesAnyCodepoint(d, [0xe002]), false)
  assert.equal(ttmlUsesAnyCodepoint(d, []), false)
})

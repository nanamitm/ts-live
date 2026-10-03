import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cssColor,
  parseClock,
  parseCodepointAttribute,
  parseOutline,
  parsePair,
  parsePx,
  parseTtmlTiming,
  ttmlUsesAnyCodepoint,
} from '../src/lib/ttml.ts'

test('parsePx は単位付きの値から数値を取り出す', () => {
  assert.equal(parsePx('128px'), 128)
  assert.equal(parsePx('-12.5px'), -12.5)
  assert.equal(parsePx('px'), 0)
  assert.equal(parsePx(null), 0)
  assert.equal(parsePx(undefined), 0)
})

test('parsePair は 2 値、足りなければ [0,0]', () => {
  assert.deepEqual(parsePair('100px 200px'), [100, 200])
  assert.deepEqual(parsePair('64px'), [0, 0])
  assert.deepEqual(parsePair(null), [0, 0])
})

test('cssColor は #RRGGBB(AA) を rgba() に変換する', () => {
  assert.equal(cssColor('#ffffff'), 'rgba(255,255,255,1)')
  assert.equal(cssColor('#00FF80'), 'rgba(0,255,128,1)')
  assert.equal(cssColor('#00000000'), 'rgba(0,0,0,0)')
  assert.equal(cssColor('#ffffffff'), 'rgba(255,255,255,1)')
  assert.equal(cssColor('white'), null, '名前付き色は未対応')
  assert.equal(cssColor('#fff'), null, '短縮形は未対応')
  assert.equal(cssColor(null), null)
})

test('parseOutline は色と太さ、太さ省略時は既定値', () => {
  assert.deepEqual(parseOutline('#000000 6px'), {
    color: 'rgba(0,0,0,1)',
    width: 6,
  })
  assert.deepEqual(parseOutline('#112233'), {
    color: 'rgba(17,34,51,1)',
    width: 4,
  })
  // 解釈できない色は黒にフォールバックする
  assert.deepEqual(parseOutline('black 2px'), {
    color: 'rgba(0,0,0,1)',
    width: 2,
  })
  assert.equal(parseOutline(null), null)
})

test('parseClock は clock-time を秒にする', () => {
  assert.equal(parseClock('00:00:00'), 0)
  assert.equal(parseClock('01:02:03'), 3723)
  assert.equal(parseClock('00:00:01.5'), 1.5)
  assert.equal(parseClock('00:00:01.250'), 1.25)
  assert.equal(parseClock('1:02:03'), 3723)
  assert.equal(parseClock('00:00'), null)
  assert.equal(parseClock('あ'), null)
})

test('parseTtmlTiming は先頭 div の begin/end を返す', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body><div begin="00:00:12.500" end="00:00:15.000">
    <p region="r1"><span style="s1">こんにちは</span></p>
  </div></body>
</tt>`
  assert.deepEqual(parseTtmlTiming(xml), { begin: 12.5, end: 15 })
})

test('parseTtmlTiming は begin/end が無ければ null', () => {
  assert.deepEqual(parseTtmlTiming('<tt><body><div><p>あ</p></div></body></tt>'), {
    begin: null,
    end: null,
  })
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

test('ttmlUsesAnyCodepoint は本文の文字と数値文字参照の両方を見る', () => {
  const literal = '<tt><body><div><p><span>あ</span></p></div></body></tt>'
  const hexRef = '<tt><body><div><p><span>&#xE001;</span></p></div></body></tt>'
  const decRef = '<tt><body><div><p><span>&#57345;</span></p></div></body></tt>'
  assert.equal(ttmlUsesAnyCodepoint(literal, [0xe001]), true)
  assert.equal(ttmlUsesAnyCodepoint(hexRef, [0xe001]), true)
  assert.equal(ttmlUsesAnyCodepoint(decRef, [0xe001]), true)
  assert.equal(ttmlUsesAnyCodepoint(literal, [0xe002]), false)
  assert.equal(ttmlUsesAnyCodepoint(literal, []), false)
})

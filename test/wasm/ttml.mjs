// scripts/test-ttml.sh が生成した Node 用 WASM で、dantto4k の parser/resolver
// (parseTtml) の出力を確かめ、そのまま layoutTtml に通す。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { layoutTtml, ttmlBoundaries } from '../../src/lib/ttml.ts'
const require = createRequire(import.meta.url)
const module = await require('../../wasm/build/ttml-test.cjs')()

const NS =
  'xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" ' +
  'xmlns:arib-tt="http://www.arib.or.jp/ns/arib-tt"'

// 実放送と同じ形の文書: 共通スタイルを参照する span、半角(72x144)、
// 字間、行の高さ、半透明の地。
const broadcast = `<?xml version="1.0" encoding="utf-8"?><tt ${NS} xml:lang="ja"><head><styling>
<style xml:id="font" tts:fontFamily="丸ゴシック" tts:color="#FFFF00FF"/>
<style xml:id="normal" tts:fontSize="144px 144px" tts:lineHeight="240px" arib-tt:letter-spacing="16px"/>
<style xml:id="middle" tts:fontSize="72px 144px" tts:lineHeight="240px" arib-tt:letter-spacing="8px"/>
<style xml:id="back" tts:backgroundColor="#00000080"/>
</styling><layout><region xml:id="r1" tts:origin="1160px 1200px" tts:extent="720px 240px"/></layout></head>
<body><div begin="01:57:21.341" end="01:57:24.000"><p region="r1"><span style="font normal back">あい</span><span style="font middle back">　</span><span style="font normal back">うえ</span></p></div></body></tt>`

let doc = module.parseTtml(broadcast, false)
assert.equal(doc.error, undefined)
assert.equal(doc.begin, 7041.341)
assert.equal(doc.end, 7044)
assert.equal(doc.paragraphs.length, 1)
const p = doc.paragraphs[0]
assert.deepEqual(p.region.style.origin, [1160, 1200])
assert.deepEqual(p.region.style.extent, [720, 240])
assert.deepEqual(
  p.spans.map(s => [s.content, s.style.fontSize, s.style.letterSpacing]),
  [
    [['あい'], [144, 144], 16],
    [['　'], [72, 144], 8],
    [['うえ'], [144, 144], 16],
  ]
)
assert.deepEqual(p.spans[0].style.color, [255, 255, 0, 255])
assert.deepEqual(p.spans[0].style.backgroundColor, [0, 0, 0, 128])
assert.equal(p.spans[0].style.fontFamily, '丸ゴシック')
assert.equal(p.spans[0].style.lineHeight, 240)
assert.equal(p.spans[0].begin, 7041.341)
// 送りの合計が領域の幅にちょうど収まる
let layout = layoutTtml(doc, 7042)
assert.equal(layout.glyphs.length, 5)
const last = layout.glyphs[4]
assert.equal(last.x - 8 + 160, 1160 + 720)
assert.equal(layoutTtml(doc, 7044).glyphs.length, 0)

// 入れ子の span、<br/>、xml:space="default" の空白の畳み込み、p の style、
// span ごとの時刻(親からの相対)。
const nested = `<tt ${NS}><head><styling>
<style xml:id="red" tts:color="#FF0000"/><style xml:id="small" tts:fontSize="72px 72px"/>
</styling><layout><region xml:id="r" tts:origin="0px 0px" tts:extent="3840px 480px"/></layout></head>
<body><div begin="00:00:10.000"><p region="r" style="small">
  <span begin="00:00:01.000" end="00:00:03.000">一行目<br/>二
     行目</span>
  <span begin="00:00:03.000"><span style="red">赤</span></span>
</p></div></body></tt>`
doc = module.parseTtml(nested, false)
assert.equal(doc.error, undefined)
const spans = doc.paragraphs[0].spans
assert.deepEqual(
  spans.map(s => [s.begin, s.end]),
  [
    [11, 13],
    [13, undefined],
  ]
)
assert.deepEqual(spans[0].content, ['一行目', null, '二 行目'])
assert.deepEqual(spans[0].style.fontSize, [72, 72])
assert.deepEqual(spans[1].content, ['赤'])
assert.deepEqual(spans[1].style.color, [255, 0, 0, 255])
assert.deepEqual(spans[1].style.fontSize, [72, 72])
assert.deepEqual(ttmlBoundaries(doc), [11, 13])
layout = layoutTtml(doc, 12)
assert.deepEqual(
  layout.glyphs.map(g => g.ch).join(''),
  '一行目二 行目'
)
assert.ok(layout.glyphs[3].y > layout.glyphs[0].y, '<br/> で次の行へ')
assert.deepEqual(
  layoutTtml(doc, 20).glyphs.map(g => g.ch),
  ['赤']
)

// TMD=1111 は begin/end を読まない
doc = module.parseTtml(broadcast, true)
assert.equal(doc.begin, undefined)
assert.equal(doc.paragraphs[0].spans[0].begin, undefined)

// 空の文書(放送は字幕を消すときに送る)
doc = module.parseTtml('<?xml version="1.0" encoding="utf-8"?><tt></tt>', false)
assert.equal(doc.error, undefined)
assert.deepEqual(doc.paragraphs, [])

// 壊れた文書はエラーを返す
doc = module.parseTtml('<tt><body>', false)
assert.equal(typeof doc.error, 'string')

console.log('ttml wasm: ok')

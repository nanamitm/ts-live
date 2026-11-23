import assert from 'node:assert/strict'
import test from 'node:test'
import { muxDatagroup, muxIndependentPES } from 'aribb24.js'
import { B24LiveFeeder } from '../src/lib/b24-live-feeder.ts'

test('ライブ字幕は処理済み入力を捨て、管理データと未来の字幕を維持する', async () => {
  const feeder = new B24LiveFeeder()
  const pump = () => new Promise(resolve => setImmediate(resolve))
  const pes = data => muxIndependentPES({ tag: 'Caption', data: muxDatagroup(data) })
  try {
    feeder.content(0)
    feeder.feedB24(pes({ tag: 'CaptionManagement', group: 0, timeControlMode: 0,
      languages: [{ lang: 0, displayMode: 0, iso_639_language_code: 'jpn', format: 8, TCS: 1, rollup: 0 }], units: [] }), 1)
    feeder.content(1)
    await pump()
    const statement = pes({ tag: 'CaptionStatement', group: 0, lang: 0, timeControlMode: 0,
      units: [{ tag: 'Statement', data: new TextEncoder().encode('字幕') }] })
    for (let time = 2; time <= 1001; time++) {
      feeder.feedB24(statement, time)
      feeder.content(time)
    }
    feeder.feedB24(statement, 1003)
    await pump()
    const history = (feeder as any).decoder
    assert.equal([...history.range(-Infinity, 1002, '(]')].length, 0)
    assert.equal([...history.range(1002, Infinity, '(]')].length, 1)
    assert.equal(feeder.content(1002)?.pts, 1001)
    feeder.content(1003)
    await pump()
    assert.equal(feeder.content(1003)?.pts, 1003)
  } finally {
    feeder.clear()
    feeder.destroy()
  }
})

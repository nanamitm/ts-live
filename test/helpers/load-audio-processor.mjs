// wasm/src/audio/processor.js は AudioWorklet のグローバル
// (AudioWorkletProcessor / registerProcessor) 前提のクラス定義なので、Node で
// 読めるように最小限のスタブを与えて評価する。実ファイルをそのまま読むため、
// テストと実装がずれない。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const processorPath = fileURLToPath(
  new URL('../../wasm/src/audio/processor.js', import.meta.url)
)

export const createProcessor = () => {
  const source = readFileSync(processorPath, 'utf8')
  const posted = []

  class AudioWorkletProcessorStub {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: value => posted.push(value),
      }
    }
  }

  const registered = {}
  const factory = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    `${source}\nreturn AudioFeederProcessor`
  )
  const Processor = factory(AudioWorkletProcessorStub, (name, cls) => {
    registered[name] = cls
  })

  const processor = new Processor()
  return {
    processor,
    posted,
    registeredNames: Object.keys(registered),
    feed(samples) {
      const buffer0 = Float32Array.from(samples)
      const buffer1 = Float32Array.from(samples)
      processor.port.onmessage({ data: { type: 'feed', buffer0, buffer1 } })
    },
    // process() を1回呼び、左右チャンネルの出力(長さ renderQuantum)を返す。
    render(renderQuantum = 128) {
      const output = [
        new Float32Array(renderQuantum),
        new Float32Array(renderQuantum),
      ]
      processor.process([], [output], {})
      return output
    },
  }
}

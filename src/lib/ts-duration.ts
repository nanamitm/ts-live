import type { WasmModule } from './wasmmodule'

type InputModule = Pick<WasmModule, 'getTsDurationInputBuffer'>

type Probe = (headSize: number, tailOffset: number, tailSize: number, fileSize: number) => number

const MB = 1024 * 1024

// 全ファイルをWASMへ載せず、先頭と末尾だけをseek可能な入力として渡す。
// 末尾にPTSが見つからなければ tailSizes の順に探索を広げる。
const readDuration = async (
  file: Blob,
  module: InputModule,
  probe: Probe,
  tailSizes: number[],
  isAborted: () => boolean
): Promise<number> => {
  const headSize = Math.min(file.size, 4 * MB)
  if (!headSize || isAborted()) return 0
  const head = new Uint8Array(await file.slice(0, headSize).arrayBuffer())
  for (const size of tailSizes) {
    if (isAborted()) return 0
    const tailOffset = Math.max(headSize, file.size - size * MB)
    const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer())
    if (isAborted()) return 0
    // awaitを挟まずコピー・解析を完了させる。他の再生の解析と領域を共有しない。
    const buffer = module.getTsDurationInputBuffer(head.length + tail.length)
    buffer.set(head)
    buffer.set(tail, head.length)
    const duration = probe(head.length, tailOffset, tail.length, file.size)
    if (Number.isFinite(duration) && duration > 0) return duration
    if (tailOffset === headSize) break // 全範囲を解析済み
  }
  return 0
}

// PTSが疎な場合は末尾の探索を広げる。
export const readTsDuration = (
  file: Blob,
  module: InputModule & Pick<WasmModule, 'probeTsDuration'>,
  isAborted: () => boolean = () => false
): Promise<number> =>
  readDuration(file, module, module.probeTsDuration, [4, 16, 32], isAborted)

// mmts-dsfilter と同じく末尾 20MB から最後の映像 PTS を探す。
export const readTlvDuration = (
  file: Blob,
  module: InputModule & Pick<WasmModule, 'probeTlvDuration'>,
  isAborted: () => boolean = () => false
): Promise<number> =>
  readDuration(file, module, module.probeTlvDuration, [20], isAborted)

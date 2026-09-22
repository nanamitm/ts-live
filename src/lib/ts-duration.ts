import type { WasmModule } from './wasmmodule'

type ProbeModule = Pick<WasmModule, 'getTsDurationInputBuffer' | 'probeTsDuration'>

// 全ファイルをWASMへ載せず、先頭と末尾だけをseek可能な入力として渡す。
// PTSが疎な場合は末尾の探索を広げる。TLVの再生では呼び出さない。
export const readTsDuration = async (
  file: Blob,
  module: ProbeModule,
  isAborted: () => boolean = () => false
): Promise<number> => {
  const headSize = Math.min(file.size, 4 * 1024 * 1024)
  if (!headSize || isAborted()) return 0
  const head = new Uint8Array(await file.slice(0, headSize).arrayBuffer())
  for (const size of [4, 16, 32]) {
    if (isAborted()) return 0
    const tailOffset = Math.max(headSize, file.size - size * 1024 * 1024)
    const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer())
    if (isAborted()) return 0
    // awaitを挟まずコピー・解析を完了させる。他の再生の解析と領域を共有しない。
    const buffer = module.getTsDurationInputBuffer(head.length + tail.length)
    buffer.set(head)
    buffer.set(tail, head.length)
    const duration = module.probeTsDuration(head.length, tailOffset, tail.length, file.size)
    if (Number.isFinite(duration) && duration > 0) return duration
    if (tailOffset === headSize) break // 全範囲を解析済み
  }
  return 0
}

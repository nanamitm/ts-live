// scripts/test-ts-duration.sh が生成したNode用WASMとシステムのFFmpegを使う。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const warnings = []
const module = await require('../../wasm/build/ts-duration-test.cjs')({
  printErr(message) { warnings.push(message); if (warnings.length > 10) warnings.shift() },
})
const dir = 'wasm/build/duration-fixtures'
mkdirSync(dir, { recursive: true })
const mb = 1024 * 1024

function probe(bytes, fileSize = bytes.length, tailBytes = 4 * mb) {
  const headSize = Math.min(bytes.length, 4 * mb)
  const tailOffset = Math.max(headSize, bytes.length - tailBytes)
  const tailSize = bytes.length - tailOffset
  const buffer = module.getTsDurationInputBuffer(headSize + tailSize)
  buffer.set(bytes.subarray(0, headSize))
  buffer.set(bytes.subarray(tailOffset), headSize)
  return module.probeTsDuration(headSize, fileSize - tailSize, tailSize, fileSize)
}

try {
  for (const [name, seconds, flags] of [
    ['short', 0.4, []],
    ['cbr', 30, ['-muxrate', '8000000']],
    ['vbr', 30, []],
    ['m2ts', 30, ['-muxrate', '8000000', '-mpegts_m2ts_mode', '1']],
    ['wrap', 30, ['-muxrate', '8000000', '-output_ts_offset', '95430']],
  ]) {
    const path = `${dir}/${name}.ts`
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(seconds), '-c:v', 'mpeg2video', '-bf', '2', '-c:a', 'aac',
      ...flags, '-f', 'mpegts', path])
    const reference = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path,
    ]).toString()).format.duration
    const actual = probe(readFileSync(path))
    assert(Math.abs(actual - Number(reference)) < 0.1,
      `${name}: WASM=${actual}, ffprobe=${reference}`)
    console.log(`PASS ${name}: WASM=${actual.toFixed(6)}s, ffprobe=${reference}s`)
  }
  const cbr = readFileSync(`${dir}/cbr.ts`)
  assert(Math.abs(probe(cbr, 5 * 1024 * mb) - 30) < 0.1)
  console.log('PASS sparse file over 4GB: timestamps determine duration')
  // 末尾にPTSが無い場合、先頭だけの長さを総時間と誤認しない。
  const noTailPts = Buffer.alloc(10 * mb, 0xff)
  cbr.copy(noTailPts, 0, 0, 4 * mb)
  assert.equal(probe(noTailPts), 0)
  console.log('PASS no tail timestamps: duration unknown')
  assert.equal(probe(new Uint8Array(188 * 10)), 0)
  console.log('PASS invalid input: duration unknown')
  const multi = `${dir}/multi.ts`
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=10',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=30',
    '-map', '0:v', '-map', '1:v', '-c:v', 'mpeg2video', '-bf', '2',
    '-program', 'program_num=1:st=0', '-program', 'program_num=2:st=1',
    '-muxrate', '8000000', '-f', 'mpegts', multi])
  const multiResult = probe(readFileSync(multi))
  // 最初の番組の末尾が探索範囲外なら、不明として呼び出し側に拡大を任せる。
  assert(multiResult === 0 || Math.abs(multiResult - 10) < 0.1,
    `first program: ${multiResult}`)
  console.log(`PASS multiple programs: ${multiResult}s (0 = widen search)`)
  const multiBytes = readFileSync(multi)
  assert(Math.abs(probe(multiBytes, multiBytes.length, 32 * mb) - 10) < 0.1)
  console.log('PASS wider search: first program is 10s, not the other program\'s 30s')
  process.exit(0)
} catch (error) {
  console.error(warnings.join('\n'))
  console.error(error)
  process.exit(1)
}

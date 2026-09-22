// TSは事前解析した総時間を使う。TLVは消費量の3秒ごとの差分を平滑化する。
// 表示位置は音声クロックで積算する。バイト位置との換算は概算シーク用。
export class LocalPositionEstimator {
  // undefined=TLVのレート推定、0=TS解析失敗、正数=PTS由来の固定総時間。
  private readonly duration?: number
  constructor(duration?: number) {
    this.duration = duration
  }

  private lastTime: number | null = null
  private sample: { time: number; bytes: number } | null = null
  private elapsed = 0
  private consumed = 0
  private rate = 0

  update(time: number, bytes: number, ended: boolean, paused: boolean) {
    if (!Number.isFinite(time) || time < 0) return
    const delta = this.lastTime === null ? 0 : time - this.lastTime
    this.lastTime = time
    if (paused || delta < 0) {
      // 停止中の先読みやPTSの巻き戻りをレート計測に含めない。
      this.sample = null
      return
    }
    this.elapsed += delta
    if (this.duration !== undefined) return
    this.consumed += delta * this.rate
    if (ended) return
    if (!this.sample || bytes < this.sample.bytes) {
      this.sample = { time, bytes }
      return
    }
    const seconds = time - this.sample.time
    if (seconds < 3) return
    const measured = (bytes - this.sample.bytes) / seconds
    if (measured > 0) {
      if (this.rate === 0) {
        this.rate = measured
        this.consumed = this.elapsed * this.rate
      } else {
        this.rate = this.rate * 0.75 + measured * 0.25
      }
    }
    this.sample = { time, bytes }
  }

  position(startOffset: number, size: number) {
    if (this.duration !== undefined) {
      const seconds = this.duration > 0 && size > 0
        ? Math.min((startOffset / size) * this.duration + this.elapsed, this.duration)
        : 0
      return {
        bytes: this.duration > 0 ? (seconds / this.duration) * size : Math.min(startOffset, size),
        size,
        seconds,
        duration: this.duration,
      }
    }
    const bytes = Math.min(startOffset + this.consumed, size)
    return {
      bytes,
      size,
      seconds: this.rate > 0 ? bytes / this.rate : 0,
      duration: this.rate > 0 ? size / this.rate : 0,
    }
  }
}

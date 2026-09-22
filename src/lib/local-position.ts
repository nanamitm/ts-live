// 消費量は先読みで階段状に増えるため、3秒ごとの差分を平滑化する。
// 表示位置は音声クロックで積算し、EOF後も最後のレートで進める。
export class LocalPositionEstimator {
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
    const bytes = Math.min(startOffset + this.consumed, size)
    return {
      bytes,
      size,
      seconds: this.rate > 0 ? bytes / this.rate : 0,
      duration: this.rate > 0 ? size / this.rate : 0,
    }
  }
}

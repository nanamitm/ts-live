// 事前解析した総時間(TS/TLV とも先頭と末尾の PTS から)を使う。解析に失敗
// したときは、消費量の3秒ごとの差分からレートを平滑化して総時間を推定する。
// 表示位置は音声クロックで積算する。バイト位置との換算は概算シーク用。
export class LocalPositionEstimator {
  // PTS由来の固定総時間。undefined ならレート推定に任せる。
  private readonly duration?: number
  constructor(duration?: number) {
    // 0 や負値は「解析したが総時間が取れなかった」。位置が一切進まなくなる
    // より、従来どおりの推定を出したほうが役に立つ。
    this.duration = duration !== undefined && duration > 0 ? duration : undefined
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

  // exact=true は PTS 由来の総時間。false なら表示に (推定) を付ける。
  position(startOffset: number, size: number) {
    if (this.duration !== undefined) {
      const seconds =
        size > 0
          ? Math.min((startOffset / size) * this.duration + this.elapsed, this.duration)
          : 0
      return {
        bytes: (seconds / this.duration) * size,
        size,
        seconds,
        duration: this.duration,
        exact: true,
      }
    }
    const bytes = Math.min(startOffset + this.consumed, size)
    return {
      bytes,
      size,
      seconds: this.rate > 0 ? bytes / this.rate : 0,
      duration: this.rate > 0 ? size / this.rate : 0,
      exact: false,
    }
  }
}

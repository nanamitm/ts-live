import { CanvasMainThreadRenderer, MPEGTSFeeder } from 'aribb24.js'
import drcs from './b24-drcs'

type Cue = NonNullable<ReturnType<MPEGTSFeeder['content']>>

// FFmpeg gives us B24 PES payloads and WASM supplies the audio clock.
export class B24Caption {
  private readonly feeder = new MPEGTSFeeder()
  private readonly renderer = new CanvasMainThreadRenderer({ replace: { drcs } })
  private frame: number | null = null
  private shown: Cue | null = null
  private width = 0
  private height = 0
  private lastDts = -Infinity

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly audioTime: () => number
  ) {
    // Start at the beginning of the live queue. The feeder otherwise seeks to
    // the newest packet before the first paint and can skip caption management.
    this.feeder.content(0)
  }

  feed(data: Uint8Array, delay: number) {
    const now = this.audioTime()
    if (!Number.isFinite(now) || now < 0 || !Number.isFinite(delay)) return

    // Decode on arrival, even if its presentation time is already past.
    // A WASM callback can deliver several PES packets at the same audio time.
    const dts = Math.max(now, this.lastDts + 0.000001)
    this.lastDts = dts
    this.feeder.feedB24(data, now + delay, dts)
    if (this.frame === null) this.frame = requestAnimationFrame(this.paint)
  }

  private readonly paint = () => {
    this.frame = requestAnimationFrame(this.paint)
    const now = this.audioTime()
    if (!Number.isFinite(now) || now < 0) return

    const cue = this.feeder.content(now)
    const visible = cue && now < cue.pts + cue.duration ? cue : null
    const { width, height } = this.canvas
    if (this.shown === visible && this.width === width && this.height === height) return

    const context = this.canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, width, height)
    if (visible && width && height) {
      this.renderer.onContainerResize(width, height)
      // The renderer consumes bitmap tokens; the feeder owns its originals.
      this.renderer.render(
        structuredClone(visible.state),
        structuredClone(visible.data),
        structuredClone(visible.info)
      )
      context.drawImage(this.renderer.getPresentationCanvas(), 0, 0, width, height)
    }
    this.shown = width && height ? visible : null
    this.width = width
    this.height = height
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.feeder.clear()
    this.feeder.destroy()
    this.renderer.destroy()
  }
}

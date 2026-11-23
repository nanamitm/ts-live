import { MPEGTSFeeder } from 'aribb24.js'

type Segment = {
  dts: number
  caption: { tag: 'CaptionManagement' } | { tag: 'CaptionStatement'; lang: number }
}
type History = {
  range(from: number, to: number, bounds: '(]'): Iterable<Segment>
  delete(key: { dts: number; lang: number }): void
}

// aribb24.js 2.0.34 keeps the input tree for seeking. This feeder is created
// anew on every seek and only needs the decoder's current management state.
export class B24LiveFeeder extends MPEGTSFeeder {
  override content(time: number) {
    const cue = super.content(time)
    const history = (this as unknown as { decoder: History }).decoder
    // content() has already put these segments in the decoder's work queue.
    // Collect keys first because mutating the tree would invalidate traversal.
    const consumed = Array.from(history.range(-Infinity, time, '(]'), ({ dts, caption }) => ({
      dts,
      lang: caption.tag === 'CaptionStatement' ? caption.lang + 1 : 0,
    }))
    for (const key of consumed) history.delete(key)
    return cue
  }
}

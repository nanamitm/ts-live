// Next.js 12 requires legacy Node resolution. aribb24.js 2.x publishes its
// declarations through package exports, which that resolver cannot see.
declare module 'aribb24.js' {
  export const CanvasMainThreadRenderer: typeof import('../../node_modules/aribb24.js/dist/types/index').CanvasMainThreadRenderer
  export const MPEGTSFeeder: typeof import('../../node_modules/aribb24.js/dist/types/index').MPEGTSFeeder
}

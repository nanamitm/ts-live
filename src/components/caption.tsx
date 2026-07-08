/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import React, {
  RefObject,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { WasmModule } from '../lib/wasmmodule'
import { CanvasProvider } from 'aribb24.js'
import { Service } from 'mirakurun/api'

type Props = {
  //
  wasmModule: WasmModule | undefined
  canvasRef: RefObject<HTMLCanvasElement>
  width?: number
  height?: number
  service: Service | undefined
}

// --- ARIB-TTML (4K/8K MMT 字幕) レンダラ -----------------------------------
// 2K の ARIB STD-B24 は aribb24.js が描画するが、4K/8K の MMT 字幕は TTML
// (STD-B62) で符号体系が異なり aribb24.js では描画できない。ここでは実放送で
// 観測した TTML サブセット(tt/head/styling+layout/body/div/p/span, 3840x2160
// 座標系)を DOMParser でパースして Canvas に描画する。DRCS・ルビ・精密な
// begin/end 同期は未対応(将来対応)。
const TTML_PLANE_W = 3840
const TTML_PLANE_H = 2160

const parsePx = (v: string | null | undefined): number => {
  if (!v) return 0
  const m = v.match(/-?\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : 0
}

const parsePair = (v: string | null | undefined): [number, number] => {
  const nums = v ? v.match(/-?\d+(?:\.\d+)?/g) : null
  if (!nums || nums.length < 2) return [0, 0]
  return [parseFloat(nums[0]), parseFloat(nums[1])]
}

// TTML の fontSize は "横px 縦px" の2値。描画には縦(2つ目)を用いる。
const parseFontSize = (v: string | null | undefined): number => {
  const nums = v ? v.match(/-?\d+(?:\.\d+)?/g) : null
  if (!nums || nums.length === 0) return 120
  return parseFloat(nums[nums.length - 1])
}

// TTML の色は #RRGGBB または #RRGGBBAA。Canvas 用の rgba() へ変換する。
const cssColor = (v: string | null | undefined): string | null => {
  if (!v) return null
  const m = v.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/)
  if (!m) return v
  const r = parseInt(m[1].slice(0, 2), 16)
  const g = parseInt(m[1].slice(2, 4), 16)
  const b = parseInt(m[1].slice(4, 6), 16)
  const a = m[2] !== undefined ? parseInt(m[2], 16) / 255 : 1
  return `rgba(${r},${g},${b},${a})`
}

const parseOutline = (
  v: string | null | undefined
): { color: string; width: number } | null => {
  if (!v) return null
  const parts = v.trim().split(/\s+/)
  return {
    color: cssColor(parts[0]) || 'rgba(0,0,0,1)',
    width: parts[1] ? parsePx(parts[1]) : 4,
  }
}

type TtmlStyle = {
  fontFamily: string
  fontSize: number
  color: string
  background: string | null
  lineHeight: number
  outline: { color: string; width: number } | null
  letterSpacing: number
}

const renderTtml = (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  xml: string
) => {
  const scaleX = canvas.width / TTML_PLANE_W
  const scaleY = canvas.height / TTML_PLANE_H
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return

  const styles: Record<string, TtmlStyle> = {}
  for (const s of Array.from(doc.getElementsByTagName('style'))) {
    const id = s.getAttribute('xml:id')
    if (!id) continue
    styles[id] = {
      fontFamily: s.getAttribute('tts:fontFamily') || 'sans-serif',
      fontSize: parseFontSize(s.getAttribute('tts:fontSize')),
      color: cssColor(s.getAttribute('tts:color')) || 'rgba(255,255,255,1)',
      background: cssColor(s.getAttribute('tts:backgroundColor')),
      lineHeight: parsePx(s.getAttribute('tts:lineHeight')),
      outline: parseOutline(s.getAttribute('tts:textOutline')),
      letterSpacing: parsePx(s.getAttribute('arib-tt:letter-spacing')),
    }
  }

  const regions: Record<
    string,
    { ox: number; oy: number; ew: number; eh: number }
  > = {}
  for (const r of Array.from(doc.getElementsByTagName('region'))) {
    const id = r.getAttribute('xml:id')
    if (!id) continue
    const [ox, oy] = parsePair(r.getAttribute('tts:origin'))
    const [ew, eh] = parsePair(r.getAttribute('tts:extent'))
    regions[id] = { ox, oy, ew, eh }
  }

  const fallbackStyle = Object.values(styles)[0]

  for (const p of Array.from(doc.getElementsByTagName('p'))) {
    const regId = p.getAttribute('region')
    const region = regId ? regions[regId] : undefined
    if (!region) continue

    let text = ''
    let style: TtmlStyle | undefined
    const spans = Array.from(p.getElementsByTagName('span'))
    if (spans.length > 0) {
      for (const span of spans) {
        const stId = span.getAttribute('style')
        if (stId && styles[stId]) style = styles[stId]
        text += span.textContent || ''
      }
    } else {
      text = p.textContent || ''
    }
    if (!style) style = fallbackStyle
    if (!text.trim() || !style) continue

    const x = region.ox * scaleX
    const y = region.oy * scaleY
    const fontPx = style.fontSize * scaleY

    ctx.font = `${fontPx}px "${style.fontFamily}", sans-serif`
    ctx.textBaseline = 'top'
    // letterSpacing は Chrome 99+ で Canvas に対応。
    ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${
      style.letterSpacing * scaleX
    }px`

    if (style.background && region.ew > 0 && region.eh > 0) {
      ctx.fillStyle = style.background
      ctx.fillRect(x, y, region.ew * scaleX, region.eh * scaleY)
    }
    if (style.outline) {
      ctx.lineWidth = style.outline.width * scaleY
      ctx.strokeStyle = style.outline.color
      ctx.lineJoin = 'round'
      ctx.strokeText(text, x, y)
    }
    ctx.fillStyle = style.color
    ctx.fillText(text, x, y)
  }
}
// ---------------------------------------------------------------------------

const Caption: React.FC<Props> = ({
  canvasRef,
  wasmModule,
  width,
  height,
  service
}) => {
  // const canvasRef = useRef<HTMLCanvasElement>(null)
  // const [currentSubtitle, setCurrentSubtitle] = useState<number>()
  const [renderTimeoutId, setRenderTimeoutId] = useState(
    setTimeout(() => {}, 0)
  )
  const [clearTimeoutId, setClearTimeoutId] = useState(setTimeout(() => {}, 0))

  const captionCallback = useCallback(
    (pts: number, ptsTime: number, captionData: Uint8Array) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const context = canvas.getContext('2d')
      if (!context) return

      // 4K/8K MMT 字幕(TTML)は UTF-8 XML なので先頭が '<'(0x3C)。2K の B24 は
      // 該当しないため、先頭バイトで判別して TTML は専用レンダラで描画する。
      if (captionData.length > 0 && captionData[0] === 0x3c) {
        try {
          // captionData は WASM の共有メモリ(SharedArrayBuffer)上のビューで、
          // TextDecoder は共有バッファを拒否するため、非共有バッファへコピー
          // してからデコードする。
          const xml = new TextDecoder('utf-8').decode(captionData.slice())
          renderTtml(context, canvas, xml)
        } catch (e) {
          console.error('TTML render error', e)
        }
        return
      }

      const data = captionData.slice()

      // if (!aribSubtitleData) {
      //   context.clearRect(0, 0, canvas.width, canvas.height)
      //   setDisplayingAribSubtitleData(null)
      //   return
      // }

      const provider = new CanvasProvider(data, ptsTime)
      const estimate = provider.render()
      if (!estimate) return
      // const font = setting.font || SUBTITLE_DEFAULT_FONT
      // const font = `"Rounded M+ 1m for ARIB"`
      const renderId = setTimeout(() => {
        const result = provider.render({
          canvas,
          useStroke: true,
          keepAspectRatio: true,
          // normalFont: font,
          // gaijiFont: font,
          drcsReplacement: true
        })
        if (estimate.endTime === Number.POSITIVE_INFINITY) return
        const clearId = setTimeout(() => {
          // console.log('end timeout', now, currentSubtitle)
          // if (currentSubtitle !== now) return
          context.clearRect(0, 0, canvas.width, canvas.height)
          // setCurrentSubtitle(undefined)
        }, (estimate.endTime - estimate.startTime) * 1000)
        setClearTimeoutId(clearId)
      }, estimate.startTime * 1000)
      setRenderTimeoutId(renderId)
    },
    []
  )

  useEffect(() => {
    if (!wasmModule) return
    wasmModule.setCaptionCallback(captionCallback)
  }, [wasmModule])

  useEffect(() => {
    if (!service) return
    if (!canvasRef.current) return
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    clearTimeout(renderTimeoutId)
    clearTimeout(clearTimeoutId)
  }, [service])

  return (
    <canvas
      css={css`
        position: absolute;
        top: 50%;
        left: 50%;
        max-width: 100%;
        max-height: 100%;
        transform: translate(-50%, -50%);
        z-index: 2;
      `}
      ref={canvasRef}
      width={width || 1920}
      height={height || 1080}
    ></canvas>
  )
}

export default Caption

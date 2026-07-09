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
  // 字幕表示ON/OFF。TTML は同一内容が間引かれ再送されないため、OFF→ON した
  // 瞬間に直近の字幕を再描画するのに使う。
  show?: boolean
  // 再生を切り替えるたびに親が加算するトークン。service が変わらない
  // ローカルファイルの切替でも字幕(canvas と同期状態)をクリアするのに使う。
  resetToken?: number
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

// <style> 1個から、定義されているプロパティだけを取り出した部分スタイル。
// span の style 属性は複数 id の空白区切りで、これらを合成して使う。
type TtmlStyleProps = {
  fontFamily?: string
  fontW?: number // fontSize の横px(セル幅)
  fontH?: number // fontSize の縦px(セル高=描画サイズ)
  color?: string
  background?: string | null
  lineHeight?: number
  outline?: { color: string; width: number } | null
  letterSpacing?: number
}

const parseStyleProps = (el: Element): TtmlStyleProps => {
  const p: TtmlStyleProps = {}
  const ff = el.getAttribute('tts:fontFamily')
  if (ff) p.fontFamily = ff
  const fs = el.getAttribute('tts:fontSize')
  if (fs) {
    const [w, h] = parsePair(fs)
    if (h > 0) {
      p.fontH = h
      p.fontW = w > 0 ? w : h
    }
  }
  const c = el.getAttribute('tts:color')
  if (c) p.color = cssColor(c) || undefined
  const bg = el.getAttribute('tts:backgroundColor')
  if (bg) p.background = cssColor(bg)
  const lh = el.getAttribute('tts:lineHeight')
  if (lh) p.lineHeight = parsePx(lh)
  const ol = el.getAttribute('tts:textOutline')
  if (ol) p.outline = parseOutline(ol)
  const ls = el.getAttribute('arib-tt:letter-spacing')
  if (ls) p.letterSpacing = parsePx(ls)
  return p
}

// span/p の style 属性(空白区切りの id リスト)を解決して合成する。
const resolveStyle = (
  ids: string | null,
  table: Record<string, TtmlStyleProps>
): TtmlStyleProps => {
  const out: TtmlStyleProps = {}
  if (!ids) return out
  for (const id of ids.trim().split(/\s+/)) {
    const s = table[id]
    if (s) Object.assign(out, s)
  }
  return out
}

// DRCS(外字)グリフ。MMT の字幕リソース(SVGフォント)由来。unitsPerEm 座標系
// (y-up, ベースライン=0)の SVG パスを保持する。
type DrcsGlyph = {
  path: Path2D
  unitsPerEm: number
  advance: number
}

// SVGフォント(<font><glyph unicode d>...)を解析し、コードポイント→グリフの
// 表に登録する。TTML 本文中の PUA 文字がこの表で置換描画される。
const registerDrcsGlyphs = (
  svg: string,
  map: Map<number, DrcsGlyph>
): number => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return 0
  const fontEl = doc.getElementsByTagName('font')[0]
  const faceEl = doc.getElementsByTagName('font-face')[0]
  const unitsPerEm =
    parseFloat(faceEl?.getAttribute('units-per-em') || '') || 1000
  const fontAdv =
    parseFloat(fontEl?.getAttribute('horiz-adv-x') || '') || unitsPerEm
  let n = 0
  for (const g of Array.from(doc.getElementsByTagName('glyph'))) {
    const uni = g.getAttribute('unicode')
    const d = g.getAttribute('d')
    if (!uni || !d) continue
    const cp = uni.codePointAt(0)
    if (cp === undefined) continue
    const advance = parseFloat(g.getAttribute('horiz-adv-x') || '') || fontAdv
    try {
      map.set(cp, { path: new Path2D(d), unitsPerEm, advance })
      n++
    } catch {
      // 無効なパスは無視
    }
  }
  return n
}

const renderTtml = (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  xml: string,
  glyphs: Map<number, DrcsGlyph>
) => {
  const scaleX = canvas.width / TTML_PLANE_W
  const scaleY = canvas.height / TTML_PLANE_H
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return

  const styleTable: Record<string, TtmlStyleProps> = {}
  for (const s of Array.from(doc.getElementsByTagName('style'))) {
    const id = s.getAttribute('xml:id')
    if (id) styleTable[id] = parseStyleProps(s)
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

  const ctxAny = ctx as CanvasRenderingContext2D & { letterSpacing?: string }

  // ルビは「小さいフォントの別 <p>」で、専用 region が本文の上に配置されている。
  // 各 <p> をその region 原点から span 単位で順に描くことで、ルビ・本文・半角
  // 約物(横幅が縦幅より小さい fontSize)を正しく配置できる。
  for (const p of Array.from(doc.getElementsByTagName('p'))) {
    const regId = p.getAttribute('region')
    const region = regId ? regions[regId] : undefined
    if (!region) continue

    const spanEls = Array.from(p.getElementsByTagName('span'))
    const items: Array<{ text: string; st: TtmlStyleProps }> = []
    if (spanEls.length > 0) {
      for (const span of spanEls) {
        const text = span.textContent || ''
        if (!text) continue
        items.push({ text, st: resolveStyle(span.getAttribute('style'), styleTable) })
      }
    } else {
      const text = p.textContent || ''
      if (text) items.push({ text, st: resolveStyle(p.getAttribute('style'), styleTable) })
    }
    if (items.length === 0) continue

    const ox = region.ox * scaleX
    const oy = region.oy * scaleY

    // 背景(あれば region の extent 全体を塗る)
    const bg = items.find(i => i.st.background)?.st.background
    if (bg && region.ew > 0 && region.eh > 0) {
      ctx.fillStyle = bg
      ctx.fillRect(ox, oy, region.ew * scaleX, region.eh * scaleY)
    }

    // region(背景帯)の高さに対して本文はベースライン top で上寄せになるため、
    // 行の高さ(そのpの最大フォントセル高)を使い region 内で縦方向にセンタリング
    // する。extent が本文より低い/未指定の場合はオフセットしない。
    const lineH = Math.max(...items.map(i => i.st.fontH ?? 128))
    const baseY = region.eh > lineH ? oy + ((region.eh - lineH) / 2) * scaleY : oy

    let cursorX = ox
    for (const { text, st } of items) {
      const fontH = st.fontH ?? 128
      const fontW = st.fontW ?? fontH
      const fontPx = fontH * scaleY
      const sx = fontH > 0 ? fontW / fontH : 1
      const family = st.fontFamily || 'sans-serif'
      const color = st.color || 'rgba(255,255,255,1)'

      ctx.font = `${fontPx}px "${family}", sans-serif`
      ctx.textBaseline = 'top'
      ctxAny.letterSpacing = `${(st.letterSpacing ?? 0) * scaleX}px`

      // 本文を「通常文字の連なり」と「DRCS外字(登録済みコードポイント)」に
      // 分割し、前者は fillText、後者は SVG グリフのパスで描く。
      const segs: Array<{ drcs: boolean; text: string }> = []
      for (const ch of Array.from(text)) {
        const cp = ch.codePointAt(0)
        const isDrcs = cp !== undefined && glyphs.has(cp)
        const last = segs[segs.length - 1]
        if (last && last.drcs === isDrcs) last.text += ch
        else segs.push({ drcs: isDrcs, text: ch })
      }

      for (const seg of segs) {
        if (seg.drcs) {
          for (const ch of Array.from(seg.text)) {
            const g = glyphs.get(ch.codePointAt(0) as number)
            if (!g) continue
            const s = fontPx / g.unitsPerEm
            ctx.save()
            ctx.translate(cursorX, baseY)
            if (sx !== 1) ctx.scale(sx, 1)
            // SVGフォントは y-up/ベースライン=0。セル上端に合わせて反転配置。
            ctx.scale(s, -s)
            ctx.translate(0, -g.unitsPerEm)
            ctx.fillStyle = color
            ctx.fill(g.path)
            ctx.restore()
            cursorX += g.advance * s * sx
          }
        } else {
          const drawW = ctx.measureText(seg.text).width * sx
          ctx.save()
          ctx.translate(cursorX, baseY)
          if (sx !== 1) ctx.scale(sx, 1) // 半角約物などを横方向に圧縮
          if (st.outline) {
            ctx.lineWidth = st.outline.width * scaleY
            ctx.strokeStyle = st.outline.color
            ctx.lineJoin = 'round'
            ctx.strokeText(seg.text, 0, 0)
          }
          ctx.fillStyle = color
          ctx.fillText(seg.text, 0, 0)
          ctx.restore()
          cursorX += drawW
        }
      }
    }
  }
  ctxAny.letterSpacing = '0px'
}

// TTML の begin/end は clock-time(HH:MM:SS(.mmm))。秒に変換する。
const parseClock = (v: string): number | null => {
  const m = v.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mi = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  const frac = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) / 1000 : 0
  return h * 3600 + mi * 60 + s + frac
}

// 先頭 <div> の begin/end を秒で取り出す。
const parseTtmlTiming = (
  xml: string
): { begin: number | null; end: number | null } => {
  const bm = xml.match(/<div\b[^>]*\bbegin="([^"]+)"/)
  const em = xml.match(/<div\b[^>]*\bend="([^"]+)"/)
  return {
    begin: bm ? parseClock(bm[1]) : null,
    end: em ? parseClock(em[1]) : null,
  }
}
// ---------------------------------------------------------------------------

const Caption: React.FC<Props> = ({
  canvasRef,
  wasmModule,
  width,
  height,
  service,
  show,
  resetToken
}) => {
  // const canvasRef = useRef<HTMLCanvasElement>(null)
  // const [currentSubtitle, setCurrentSubtitle] = useState<number>()
  const [renderTimeoutId, setRenderTimeoutId] = useState(
    setTimeout(() => {}, 0)
  )
  const [clearTimeoutId, setClearTimeoutId] = useState(setTimeout(() => {}, 0))

  const lastTtmlRef = useRef<string | null>(null)
  // TTML begin/end 同期用の状態。offset は「TTML 時刻 → 再生メディア時刻」の
  // 差分(秒)で、最初のキュー観測時に確定し番組境界で取り直す。timers は表示/
  // 消去の予約(setTimeout)一覧で service 切替時にまとめて解除する。
  const ttmlOffsetRef = useRef<number | null>(null)
  const ttmlLastBeginRef = useRef<number>(-1)
  const ttmlTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  // 世代トークン。各キューに単調増加 id を振り、「今表示中の id」を追跡する。
  // これにより、後続キューに置き換わった古いキューの表示/消去タイマーが
  // 現在の字幕を上書き・消去してしまうのを防ぐ(字幕が重なる/すぐ消える対策)。
  const ttmlSeqRef = useRef(0)
  const ttmlShownIdRef = useRef(-1)
  // DRCS(外字)グリフ表: コードポイント→SVGパス。字幕リソース(SVGフォント)を
  // 受信するたびに登録し、service 切替でクリアする。
  const glyphMapRef = useRef<Map<number, DrcsGlyph>>(new Map())
  // 現在の service を captionCallback(deps 空)から参照するための ref。4K→2K
  // 切替後に遅れて届く 4K(TTML)字幕を破棄する判定に使う。
  const serviceRef = useRef<Service | undefined>(undefined)

  const captionCallback = useCallback(
    (pts: number, ptsTime: number, captionData: Uint8Array) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const context = canvas.getContext('2d')
      if (!context) return

      // 4K/8K MMT 字幕(TTML)は UTF-8 XML なので先頭が '<'(0x3C)。2K の B24 は
      // 該当しないため、先頭バイトで判別して TTML は専用レンダラで描画する。
      if (captionData.length > 0 && captionData[0] === 0x3c) {
        // 4K→2K 切替直後に WASM キューから遅れて届く 4K(TTML)字幕を破棄する。
        // service が非 BS4K(=2K 等)のときは TTML を描かない。service 未定義
        // (ローカルファイル再生のデバッグ)のときは従来どおり描画する。
        const svc = serviceRef.current
        if (svc && (svc.channel?.type as string) !== 'BS4K') {
          return
        }
        try {
          // captionData は WASM の共有メモリ(SharedArrayBuffer)上のビューで、
          // TextDecoder は共有バッファを拒否するため、非共有バッファへコピー
          // してからデコードする。
          const xml = new TextDecoder('utf-8').decode(captionData.slice())

          // DRCS 外字リソース(SVGフォント)も同じ字幕ストリームで届く。<svg> を
          // 判別してグリフ表に登録し、字幕本文としては描画しない。
          if (/<svg[\s>]/.test(xml.slice(0, 400))) {
            registerDrcsGlyphs(xml, glyphMapRef.current)
            return
          }

          // OFF→ON 直後に再描画できるよう直近の TTML を保持する。
          lastTtmlRef.current = xml

          // TTML は PTS を持たず、表示時刻は begin/end(clock-time)で表す。WASM
          // からは ptsTime に現在の再生メディア時刻(秒)が渡ってくるので、最初の
          // キューで offset=begin-now を確定し、以後は begin-offset の時刻に表示
          // する(SubtitleTimingResolver の簡約版)。
          const now = ptsTime
          const { begin, end } = parseTtmlTiming(xml)
          if (begin == null || !Number.isFinite(now)) {
            // タイミング情報が無ければ従来どおり到着時に即描画する。
            renderTtml(context, canvas, xml, glyphMapRef.current)
            return
          }

          const ROLLBACK_TOL = 5 // 秒。begin の巻き戻り=番組境界とみなす閾値
          const MAX_LEAD = 30 // 秒。offset 破綻時のフェイルセーフ
          if (
            ttmlOffsetRef.current == null ||
            begin + ROLLBACK_TOL < ttmlLastBeginRef.current
          ) {
            // 初回、または番組境界: offset を取り直し予約済みの表示を破棄する。
            ttmlOffsetRef.current = begin - now
            for (const t of ttmlTimersRef.current) clearTimeout(t)
            ttmlTimersRef.current = []
          }
          ttmlLastBeginRef.current = begin

          let delayShow = begin - ttmlOffsetRef.current - now
          if (delayShow < 0) delayShow = 0
          if (delayShow > MAX_LEAD) {
            // offset がずれている可能性。再校正して即時表示。
            ttmlOffsetRef.current = begin - now
            delayShow = 0
          }

          ttmlSeqRef.current += 1
          const id = ttmlSeqRef.current

          const showTimer = setTimeout(() => {
            // 既により新しい字幕が表示済みなら、この古い表示は描かない。
            if (id < ttmlShownIdRef.current) return
            ttmlShownIdRef.current = id
            renderTtml(context, canvas, xml, glyphMapRef.current)
          }, delayShow * 1000)
          ttmlTimersRef.current.push(showTimer)

          if (end != null) {
            const delayClear = end - ttmlOffsetRef.current - now
            if (delayClear > delayShow) {
              const clearTimer = setTimeout(() => {
                // 後続字幕に置き換わっていれば消去しない(現在の字幕を守る)。
                if (ttmlShownIdRef.current !== id) return
                context.clearRect(0, 0, canvas.width, canvas.height)
              }, delayClear * 1000)
              ttmlTimersRef.current.push(clearTimer)
            }
          }
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
    // wasmModule ロード完了時だけでなく、再生対象(service)が変わったときも
    // 張り直す。自動再生などで登録と再生開始が競合してもコールバックが確実に
    // セットされるようにする(字幕トグルを OFF→ON しないと出ない事象の対策)。
    wasmModule.setCaptionCallback(captionCallback)
  }, [wasmModule, captionCallback, service])

  useEffect(() => {
    // captionCallback(deps 空)から参照する現在 service を常に最新へ。
    serviceRef.current = service
    // 番組切替(service 変化)に加え、resetToken 変化(ローカルファイル切替など
    // service が変わらない再生の開始)でも字幕をクリアする。service 未定義でも
    // クリアが必要なので早期 return しない。
    if (!canvasRef.current) return
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    clearTimeout(renderTimeoutId)
    clearTimeout(clearTimeoutId)
    // TTML 同期状態もリセットする。直近 TTML キャッシュも破棄し、切替後に
    // OFF→ON しても前番組(4K)の字幕が復活しないようにする。
    for (const t of ttmlTimersRef.current) clearTimeout(t)
    ttmlTimersRef.current = []
    ttmlOffsetRef.current = null
    ttmlLastBeginRef.current = -1
    ttmlShownIdRef.current = -1
    lastTtmlRef.current = null
    glyphMapRef.current.clear()
  }, [service, resetToken])

  // 字幕表示が OFF→ON になったら、直近の TTML 字幕を即座に再描画する。TTML は
  // 同一内容が間引かれ再送されないため、これが無いと ON にしても次に内容が
  // 変わるまで何も表示されない。
  useEffect(() => {
    if (!show) return
    if (!lastTtmlRef.current) return
    if (!canvasRef.current) return
    const context = canvasRef.current.getContext('2d')
    if (!context) return
    renderTtml(context, canvasRef.current, lastTtmlRef.current, glyphMapRef.current)
  }, [show])

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

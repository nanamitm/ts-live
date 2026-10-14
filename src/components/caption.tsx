/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import React, {
  RefObject,
  useCallback,
  useEffect,
  useRef
} from 'react'
import { WasmModule } from '../lib/wasmmodule'
import { CanvasProvider } from 'aribb24.js'
import { Service } from 'mirakurun/api'
import {
  TtmlClock,
  TtmlDocument,
  TtmlGlyph,
  TtmlPair,
  TMD_NO_TIME_CONTROL,
  initialTtmlClock,
  layoutTtml,
  parseCodepointAttribute,
  placeTtml,
  ttmlBoundaries,
  ttmlColor,
  ttmlFirstBegin,
  ttmlPlaneSize,
  ttmlUsesAnyCodepoint,
} from '../lib/ttml'

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
// (STD-B62 / TR-B39) で符号体系が異なり aribb24.js では描画できない。TTML の
// 解析は WASM に組み込んだ dantto4k の parser/resolver が行い(parseTtml)、
// ここでは解決済みの文書を ttml.ts の layoutTtml で配置して Canvas に描く。

// DRCS(外字)グリフ。MMT の字幕リソース(SVGフォント)由来。unitsPerEm 座標系
// (y-up, ベースライン=0)の SVG パスを保持する。
type DrcsGlyph = {
  path: Path2D
  unitsPerEm: number
  advance: number
}

// SVGフォント(<font><glyph unicode d>...)を解析し、コードポイント→グリフの
// 表に登録する。TTML 本文中の PUA 文字がこの表で置換描画される。
// 戻り値は今回初めて登録されたコードポイント(リソースの再送で既に持っている
// グリフは含めない)。表示中の字幕を描き直すかの判定に使う。
const registerDrcsGlyphs = (
  svg: string,
  map: Map<number, DrcsGlyph>
): number[] => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return []
  const added: number[] = []
  // <font> ごとに font-face(units-per-em, unicode-range)が付く。<font> が
  // 無い文書は全体を 1 つのフォントとして扱う。
  const fonts = Array.from(doc.getElementsByTagName('font'))
  const scopes: Element[] = fonts.length > 0 ? fonts : [doc.documentElement]
  for (const fontEl of scopes) {
    const faceEl = fontEl.getElementsByTagName('font-face')[0]
    const unitsPerEm =
      parseFloat(faceEl?.getAttribute('units-per-em') || '') || 1000
    const fontAdv =
      parseFloat(fontEl.getAttribute('horiz-adv-x') || '') || unitsPerEm
    // 放送のリソースは 1 フォント 1 グリフで、コードポイントを font-face の
    // unicode-range にしか書かないことが多い。glyph 側に無ければこれを使う。
    const faceCp = parseCodepointAttribute(faceEl?.getAttribute('unicode-range'))
    for (const g of Array.from(fontEl.getElementsByTagName('glyph'))) {
      const d = g.getAttribute('d')
      if (!d) continue
      const cp =
        parseCodepointAttribute(g.getAttribute('unicode')) ??
        parseCodepointAttribute(g.getAttribute('unicode-range')) ??
        faceCp
      if (cp === undefined) continue
      const advance = parseFloat(g.getAttribute('horiz-adv-x') || '') || fontAdv
      try {
        const isNew = !map.has(cp)
        map.set(cp, { path: new Path2D(d), unitsPerEm, advance })
        if (isNew) added.push(cp)
      } catch {
        // 無効なパスは無視
      }
    }
  }
  return added
}

// 表示中の TTML。外字のグリフが後から届いたときや OFF→ON で描き直すのに使う。
type ShownTtml = {
  doc: TtmlDocument
  plane: TtmlPair
  // 描いた時点の文書の時刻(秒)。
  at: number
}

const fontOf = (g: TtmlGlyph): string => {
  const family = g.style.fontFamily || 'sans-serif'
  const italic = g.style.fontStyle === 'italic' ? 'italic ' : ''
  const bold = g.style.fontWeight === 'bold' ? 'bold ' : ''
  return `${italic}${bold}${g.h}px "${family}", sans-serif`
}

// 字形を (g.x, g.y) の g.w×g.h の枠に描く。stroke は縁取りだけを描く
// パス(全文字の縁取りを先に描き、本体が隣の縁取りに隠れないようにする)。
const drawGlyph = (
  ctx: CanvasRenderingContext2D,
  g: TtmlGlyph,
  glyphs: Map<number, DrcsGlyph>,
  stroke: boolean
) => {
  const drcs = glyphs.get(g.ch.codePointAt(0) as number)
  const sx = g.w / g.h
  ctx.save()
  if (drcs) {
    if (stroke) {
      ctx.restore()
      return
    }
    // SVGフォントは y-up/ベースライン=0。枠の上端に合わせて反転配置する。
    const s = g.h / drcs.unitsPerEm
    ctx.translate(g.x, g.y)
    ctx.scale(s * sx, -s)
    ctx.translate(0, -drcs.unitsPerEm)
    ctx.fillStyle = ttmlColor(g.style.color) ?? 'white'
    ctx.fill(drcs.path)
    ctx.restore()
    return
  }
  ctx.font = fontOf(g)
  ctx.textBaseline = 'top'
  // 全角の字形は枠いっぱい、それより狭い字形(英数字など)は枠の中央に置く。
  const width = ctx.measureText(g.ch).width * sx
  ctx.translate(g.x + Math.max(0, (g.w - width) / 2), g.y)
  ctx.scale(sx, 1)
  if (stroke) {
    const outline = g.style.textOutline
    if (outline && outline.width > 0) {
      // textOutline の太さは字形の外側の幅。stroke は線の半分が外に出る。
      ctx.lineWidth = outline.width * 2
      ctx.strokeStyle = ttmlColor(outline.color ?? g.style.color) ?? 'black'
      ctx.lineJoin = 'round'
      ctx.strokeText(g.ch, 0, 0)
    }
  } else {
    ctx.fillStyle = ttmlColor(g.style.color) ?? 'white'
    ctx.fillText(g.ch, 0, 0)
  }
  ctx.restore()
}

// 下線と囲み(arib-tt:border)。文字の色で描く。
const drawDecorations = (ctx: CanvasRenderingContext2D, g: TtmlGlyph) => {
  const st = g.style
  if (
    !st.underline &&
    !st.borderTop &&
    !st.borderRight &&
    !st.borderBottom &&
    !st.borderLeft
  ) {
    return
  }
  const lw = Math.max(1, g.h / 24)
  ctx.fillStyle = ttmlColor(st.color) ?? 'white'
  if (st.underline || st.borderBottom) ctx.fillRect(g.x, g.y + g.h - lw, g.w, lw)
  if (st.borderTop) ctx.fillRect(g.x, g.y, g.w, lw)
  if (st.borderLeft) ctx.fillRect(g.x, g.y, lw, g.h)
  if (st.borderRight) ctx.fillRect(g.x + g.w - lw, g.y, lw, g.h)
}

const renderTtml = (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  shown: ShownTtml,
  glyphs: Map<number, DrcsGlyph>
) => {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const layout = layoutTtml(shown.doc, shown.at)
  if (layout.glyphs.length === 0 && layout.backgrounds.length === 0) return
  ctx.save()
  // TTML の座標系(4K なら 3840x2160)のまま描く。
  ctx.scale(canvas.width / shown.plane[0], canvas.height / shown.plane[1])
  for (const r of layout.backgrounds) {
    ctx.fillStyle = ttmlColor(r.color) as string
    ctx.fillRect(r.x, r.y, r.w, r.h)
  }
  for (const g of layout.glyphs) drawGlyph(ctx, g, glyphs, true)
  for (const g of layout.glyphs) {
    drawGlyph(ctx, g, glyphs, false)
    drawDecorations(ctx, g)
  }
  ctx.restore()
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
  // 2K B24 字幕も複数キューが先読みされるため、表示中の世代と予約タイマーを
  // ref で管理する。古い字幕の消去タイマーが後続字幕を消すことを防ぐ。
  const b24TimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const b24SeqRef = useRef(0)
  const b24ShownIdRef = useRef(-1)
  // TTML の時刻合わせの状態(reference_start_time が無いときに使う)と、
  // 表示/消去の予約(setTimeout)一覧。service 切替時にまとめて解除する。
  const ttmlClockRef = useRef<TtmlClock>(initialTtmlClock())
  const ttmlTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  // 世代トークン。各文書に単調増加 id を振り、「今表示中の id」を追跡する。
  // これにより、後続の文書に置き換わった古い文書の表示/消去タイマーが
  // 現在の字幕を上書き・消去してしまうのを防ぐ(字幕が重なる/すぐ消える対策)。
  const ttmlSeqRef = useRef(0)
  const ttmlShownIdRef = useRef(-1)
  // DRCS(外字)グリフ表: コードポイント→SVGパス。字幕リソース(SVGフォント)を
  // 受信するたびに登録し、service 切替でクリアする。
  const glyphMapRef = useRef<Map<number, DrcsGlyph>>(new Map())
  // いま canvas に出ている TTML。字幕本文より後から外字のグリフが届いたときや
  // 字幕表示を OFF→ON したときに描き直すのに使う。
  const shownTtmlRef = useRef<ShownTtml | null>(null)
  const serviceRef = useRef<Service | undefined>(undefined)
  // TTML の解析(parseTtml)に使う。captionCallback(deps 空)から参照する。
  const wasmModuleRef = useRef<WasmModule | undefined>(wasmModule)
  wasmModuleRef.current = wasmModule

  const captionCallback = useCallback(
    (
      pts: number,
      ptsTime: number,
      captionData: Uint8Array,
      streamIndex: number,
      tmd: number,
      resolution: number
    ) => {
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
        const wasm = wasmModuleRef.current
        if (!wasm) return
        try {
          // captionData は WASM の共有メモリ(SharedArrayBuffer)上のビューで、
          // TextDecoder は共有バッファを拒否するため、非共有バッファへコピー
          // してからデコードする。
          const xml = new TextDecoder('utf-8').decode(captionData.slice())

          // DRCS 外字リソース(SVGフォント)も同じ字幕ストリームで届く。<svg> を
          // 判別してグリフ表に登録し、字幕本文としては描画しない。
          if (/<svg[\s>]/.test(xml.slice(0, 400))) {
            const added = registerDrcsGlyphs(xml, glyphMapRef.current)
            // 字幕本文がリソースより先に届くと、外字はグリフ無しで描かれて
            // いる。表示中の字幕がいま届いたグリフを使っていれば描き直す。
            // TTML は同一内容が再送されないので、次の字幕を待つと外字が
            // 欠けたまま表示し終わってしまう。
            const shown = shownTtmlRef.current
            if (shown && ttmlUsesAnyCodepoint(shown.doc, added)) {
              renderTtml(context, canvas, shown, glyphMapRef.current)
            }
            return
          }

          // TMD=1111 は時刻制御なしで、begin/end を読まない(ARIB TR-B39
          // 8.5.9.2)。
          const doc = wasm.parseTtml(xml, tmd === TMD_NO_TIME_CONTROL)
          if (doc.error) {
            console.warn('TTML rejected:', doc.error)
            return
          }
          const plane = ttmlPlaneSize(resolution)
          const now = ptsTime
          ttmlSeqRef.current += 1
          const id = ttmlSeqRef.current
          const show = (at: number) => {
            // 既により新しい字幕が表示済みなら、この古い文書は描かない。
            if (id < ttmlShownIdRef.current) return
            ttmlShownIdRef.current = id
            const shown = { doc, plane, at }
            shownTtmlRef.current = shown
            renderTtml(context, canvas, shown, glyphMapRef.current)
          }
          if (!Number.isFinite(now)) {
            // 再生時刻が分からなければ届いた時点の状態を描く。
            show(ttmlFirstBegin(doc) ?? 0)
            return
          }

          // 文書の時刻 0 を再生時刻に置く。reference_start_time があれば
          // それを起点にし(TMD=0010)、無ければ到着時の再生時刻に合わせる。
          const prevBase = ttmlClockRef.current.base
          const placement = placeTtml(
            doc,
            { tmd, referenceStartTime: pts, now, streamIndex },
            ttmlClockRef.current
          )
          ttmlClockRef.current = placement.clock
          if (placement.immediate) {
            show(0)
            return
          }
          if (prevBase !== null && placement.clock.base !== prevBase) {
            // 時間軸を取り直した(番組境界・アセット乗り換え): 古い時間軸で
            // 予約した表示を破棄する。
            for (const t of ttmlTimersRef.current) clearTimeout(t)
            ttmlTimersRef.current = []
          }

          // 今の状態をすぐ(最初の字幕がまだ先ならその時刻に)描き、以後は
          // begin/end の各時刻に描き直す。表示するものが無くなれば消える。
          const current = now - placement.base
          const first = ttmlFirstBegin(doc) ?? -Infinity
          const times = ttmlBoundaries(doc).filter(t => t > current)
          if (first <= current) {
            show(current)
          } else if (!times.includes(first)) {
            times.unshift(first)
          }
          for (const at of times) {
            const timer = setTimeout(() => {
              ttmlTimersRef.current = ttmlTimersRef.current.filter(
                t => t !== timer
              )
              show(at)
            }, (placement.base + at - now) * 1000)
            ttmlTimersRef.current.push(timer)
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
      b24SeqRef.current += 1
      const id = b24SeqRef.current
      // const font = setting.font || SUBTITLE_DEFAULT_FONT
      // const font = `"Rounded M+ 1m for ARIB"`
      const renderId = setTimeout(() => {
        b24TimersRef.current = b24TimersRef.current.filter(t => t !== renderId)
        // 既に後続字幕が表示済みなら、遅れて発火した古い字幕を描かない。
        if (id < b24ShownIdRef.current) return
        b24ShownIdRef.current = id
        provider.render({
          canvas,
          useStroke: true,
          keepAspectRatio: true,
          // normalFont: font,
          // gaijiFont: font,
          drcsReplacement: true
        })
        if (estimate.endTime === Number.POSITIVE_INFINITY) return
        const clearId = setTimeout(() => {
          b24TimersRef.current = b24TimersRef.current.filter(t => t !== clearId)
          // 後続字幕に置き換わっていれば、現在の字幕を消さない。
          if (b24ShownIdRef.current !== id) return
          context.clearRect(0, 0, canvas.width, canvas.height)
        }, (estimate.endTime - estimate.startTime) * 1000)
        b24TimersRef.current.push(clearId)
      }, estimate.startTime * 1000)
      b24TimersRef.current.push(renderId)
    },
    [canvasRef]
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
    for (const t of b24TimersRef.current) clearTimeout(t)
    b24TimersRef.current = []
    b24ShownIdRef.current = -1
    // TTML 同期状態もリセットする。直近 TTML キャッシュも破棄し、切替後に
    // OFF→ON しても前番組(4K)の字幕が復活しないようにする。
    for (const t of ttmlTimersRef.current) clearTimeout(t)
    ttmlTimersRef.current = []
    ttmlClockRef.current = initialTtmlClock()
    ttmlShownIdRef.current = -1
    shownTtmlRef.current = null
    glyphMapRef.current.clear()
  }, [canvasRef, service, resetToken])

  // アンマウント時にも遅延描画を残さない。
  useEffect(() => {
    return () => {
      for (const t of b24TimersRef.current) clearTimeout(t)
      for (const t of ttmlTimersRef.current) clearTimeout(t)
      b24TimersRef.current = []
      ttmlTimersRef.current = []
    }
  }, [])

  // 字幕表示が OFF→ON になったら、表示中の TTML 字幕を即座に再描画する。TTML は
  // 同一内容が間引かれ再送されないため、これが無いと ON にしても次に内容が
  // 変わるまで何も表示されない。
  useEffect(() => {
    if (!show) return
    if (!shownTtmlRef.current) return
    if (!canvasRef.current) return
    const context = canvasRef.current.getContext('2d')
    if (!context) return
    renderTtml(
      context,
      canvasRef.current,
      shownTtmlRef.current,
      glyphMapRef.current
    )
  }, [canvasRef, show])

  return (
    <canvas
      css={css`
        position: absolute;
        top: 50%;
        left: 50%;
        width: 100%;
        height: 100%;
        /* 映像 canvas と同じ拡縮でないと字幕の位置がずれる。 */
        object-fit: contain;
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

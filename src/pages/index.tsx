/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { NextPage } from 'next'
import dynamic from 'next/dynamic'
import Script from 'next/script'
import { EventHandler, useCallback, useEffect, useRef, useState } from 'react'
import { useAsync, useKey, useLocalStorage } from 'react-use'
import {
  Box,
  Button,
  Checkbox,
  Divider,
  Drawer,
  FormControl,
  FormControlLabel,
  FormGroup,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Stack,
  TextField,
} from '@mui/material'
import { VolumeMute, VolumeUp } from '@mui/icons-material'
import { CartesianGrid, LineChart, XAxis, YAxis, Line, Legend } from 'recharts'
import Head from 'next/head'
import { WasmModule, StatsData, VideoStreamInfo } from '../lib/wasmmodule'
import dayjs from 'dayjs'

import { Program, Service } from 'mirakurun/api'
import { useRouter } from 'next/router'

const Caption = dynamic(() => import('../components/caption'), {
  ssr: false,
})

declare interface EpgRecordedFile {
  id: number
  filename: string
}

let initialized = false;

const Page: NextPage = () => {
  const router = useRouter()
  const { debug } = router.query

  const [debugLog, setDebugLog] = useState<boolean>(false)
  const [webCodecsActive, setWebCodecsActive] = useState<boolean>(false)

  const [drawer, setDrawer] = useState<boolean>(true)
  const [touched, setTouched] = useState<boolean>(false)
  // Mirakurun 管理UIの ▷(TSPlay) ボタン等から
  //   <playerUrl>#http://host/api/services/<id>/stream?decode=1
  // の形で開かれたときに自動再生するための、対象サービス ID。
  const [pendingServiceId, setPendingServiceId] = useState<number | null>(null)

  const [mirakurunServer, setMirakurunServer] = useLocalStorage<string>('mirakurunServer', '')
  const [mirakurunOk, setMirakurunOk] = useState<boolean>(false)
  const [mirakurunVersion, setMirakurunVersion] = useState<string>('unknown')
  const [tvServices, setTvServices] = useState<Array<Service>>([])
  const [activeService, setActiveService] = useLocalStorage<Service>(
    'tsplayerActiveService',
    undefined
  )
  const [programs, setPrograms] = useState<Array<Program>>([])
  const [currentProgram, setCurrentProgram] = useState<Program>()

  const [epgStationServer, setEpgStationServer] = useLocalStorage<string>(
    'tsplayerEpgStationServer',
    undefined
  )
  const [epgStationOk, setEpgStationOk] = useState<boolean>(false)
  const [epgStationVersion, setEpgStationVersion] = useState<string>('unknown')
  const [epgRecordedFiles, setEpgRecordedFiles] = useState<Array<EpgRecordedFile>>()
  const [activeRecordedFileId, setActiveRecordedFileId] = useState<number>()
  // ローカルファイル(デバッグ用)再生の選択状態。BS4K の TLV/HEVC を既定にする。
  const localFileInputRef = useRef<HTMLInputElement>(null)
  const [localFileName, setLocalFileName] = useState<string>('')
  const [localTlvMode, setLocalTlvMode] = useLocalStorage<boolean>('tsplayerLocalTlvMode', true)
  // 直近に開いたローカルファイル(最初から再生/ループ用)と、ループ設定。
  // ループ判定は実行中の非同期フィードから参照するため ref に同期する。
  const lastLocalFileRef = useRef<File | null>(null)
  const [localLoop, setLocalLoop] = useLocalStorage<boolean>('tsplayerLocalLoop', false)
  const localLoopRef = useRef<boolean>(false)
  // ローカル再生のコンテナ種別。'auto'=先頭バイトで TS(2K)/TLV(BS4K)を自動判定、
  // 'ts'=2K(通常TS)固定、'tlv'=BS4K(TLV/HEVC)固定。
  const [localMode, setLocalMode] = useLocalStorage<string>('tsplayerLocalMode', 'auto')
  const [playMode, setPlayMode] = useState<string>('live')
  const [dualMonoMode, setDualMonoMode] = useLocalStorage<number>('tsplayerDualMonoMode', 0)
  const [volume, setVolume] = useLocalStorage<number>('tsplayerVolume', 1.0)
  const [mute, setMute] = useLocalStorage<boolean>('tsplayerMute', false)

  const [stopFunc, setStopFunc] = useState(() => () => {})
  const [chartData, setChartData] = useState<Array<StatsData>>([
    {
      time: 0,
      VideoFrameQueueSize: 0,
      AudioFrameQueueSize: 0,
      InputBufferSize: 0,
      SDLQueuedAudioSize: 0,
    },
  ])
  const [showCharts, setShowCharts] = useState<boolean>(false)
  const [showCaption, setShowCaption] = useLocalStorage<boolean>('tsplayerShowCaption', false)
  // 再生を切り替えるたびに加算し、Caption に字幕クリアを促すトークン。ローカル
  // ファイル切替のように service が変わらないケースで前ファイルの字幕を消す。
  const [captionResetToken, setCaptionResetToken] = useState<number>(0)

  const videoCanvasRef = useRef<HTMLCanvasElement>(null)
  const captionCanvasRef = useRef<HTMLCanvasElement>(null)
  // WebCodecs (BS4K) 用の描画 canvas と再生制御
  const wcCanvasRef = useRef<HTMLCanvasElement>(null)
  const webCodecsCtrlRef = useRef<{ stop: () => void } | null>(null)

  // WebCodecs 用: JS の VideoDecoder(ハードウェアデコード)で映像をデコードし、
  // WASM が保持する音声クロックに同期して canvas へ描画する。対象コーデックは
  // HEVC (BS4K/8K) と H.264 (スカパープレミアム等)。構成は WASM の probe が
  // 通知してくるストリーム情報(info)から決める。
  const buildWebCodecsConfig = (
    info: VideoStreamInfo
  ): VideoDecoderConfig | null => {
    if (info.codec === 'hevc') {
      // BS4K 実績のある Main10 L5.1 固定(プロファイル情報が取れないファイルが
      // あるため info からは組み立てない)
      const config: VideoDecoderConfig = {
        codec: 'hev1.2.4.L153.90',
        optimizeForLatency: true,
      }
      if (info.width > 0 && info.height > 0) {
        config.codedWidth = info.width
        config.codedHeight = info.height
      }
      return config
    }
    if (info.codec === 'h264') {
      // Annex-B (description なし)。codec 文字列は profile/level から生成し、
      // 不明時は High@L4.0 にフォールバックする。
      const profile = info.profile > 0 ? info.profile : 100
      const level = info.level > 0 ? info.level : 40
      const prefix =
        profile === 66
          ? '42C0'
          : profile === 77
          ? '4D40'
          : profile === 100
          ? '6400'
          : profile.toString(16).padStart(2, '0').toUpperCase() + '00'
      const config: VideoDecoderConfig = {
        codec: `avc1.${prefix}${level.toString(16).padStart(2, '0').toUpperCase()}`,
        optimizeForLatency: true,
      }
      if (info.width > 0 && info.height > 0) {
        config.codedWidth = info.width
        config.codedHeight = info.height
      }
      return config
    }
    return null
  }

  const startWebCodecs = (
    Module: WasmModule,
    canvas: HTMLCanvasElement | null,
    info: VideoStreamInfo
  ) => {
    if (!canvas) return
    const config = buildWebCodecsConfig(info)
    if (!config) {
      console.error('WebCodecs: unsupported codec', info.codec)
      return
    }
    // canvas を表示解像度に合わせる。1440x1080 (SAR 4:3) のような非正方画素は
    // 横方向へ引き伸ばして描画する(drawImage が canvas サイズへスケール)。
    const width = info.width > 0 ? info.width : info.codec === 'hevc' ? 3840 : 1920
    const height = info.height > 0 ? info.height : info.codec === 'hevc' ? 2160 : 1080
    const displayWidth =
      info.sarNum > 0 && info.sarDen > 0
        ? Math.round((width * info.sarNum) / info.sarDen)
        : width
    canvas.width = displayWidth
    canvas.height = height
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return

    type WCFrame = { frame: VideoFrame; ts: number }
    let frameQueue: WCFrame[] = []
    let gotKey = false
    let stopped = false
    let rafId = 0
    let droppedBeforeKey = 0

    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (stopped) {
          frame.close()
          return
        }
        frameQueue.push({ frame, ts: frame.timestamp / 1e6 })
        // 万一溜まりすぎたら古い方を捨てる
        while (frameQueue.length > 60) {
          frameQueue.shift()!.frame.close()
        }
      },
      error: (e: DOMException) => {
        console.error('WebCodecs VideoDecoder error:', e.message)
      },
    })
    console.log('WebCodecs configure:', config, 'display:', displayWidth, height)
    decoder.configure(config)

    // WASM から呼ばれる: アクセスユニット 1 個を VideoDecoder へ投入。
    Module.setVideoAuCallback((data: Uint8Array, ptsSec: number, isKey: boolean) => {
      if (stopped) return
      if (!gotKey) {
        if (!isKey) {
          // 最初のキーフレームが来るまで delta は捨てる。長時間キーが来ない
          // 場合はキー判定(AV_PKT_FLAG_KEY)がストリームと合っていない可能性が
          // 高いので診断用に警告する。
          droppedBeforeKey++
          if (droppedBeforeKey === 300) {
            console.warn(
              'WebCodecs: no key frame in first 300 AUs — key detection may be failing for this stream'
            )
          }
          return
        }
        gotKey = true
      }
      // data は WASM ヒープ上のビューなのでコピーしてから渡す
      const buf = new Uint8Array(data)
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: Math.max(0, Math.round(ptsSec * 1e6)),
            data: buf,
          })
        )
      } catch (e) {
        console.error('decode() failed:', e)
      }
    })

    // 描画ループ: 音声再生時刻(WASM の音声クロック)に合うフレームを表示する。
    let wallStart = 0 // 音声クロックが未確立(起動直後)の間のフォールバック用
    let tsStart = 0
    const render = () => {
      if (stopped) return
      rafId = requestAnimationFrame(render)
      let audioTime = Module.getAudioPlaybackTime()
      if (audioTime < 0 && frameQueue.length > 0) {
        // 音声クロックが立ち上がるまではウォールクロックで暫定ペーシング。
        // 音声が流れ始めれば audioTime が正の値になり音声同期へ切り替わる。
        const nowSec = performance.now() / 1000
        if (wallStart === 0) {
          wallStart = nowSec
          tsStart = frameQueue[0].ts
        }
        audioTime = tsStart + (nowSec - wallStart)
      }
      if (audioTime < 0 || frameQueue.length === 0) return
      // ts <= audioTime の中で最新のフレームを表示、古いものは破棄。
      let showIdx = -1
      for (let i = 0; i < frameQueue.length; i++) {
        if (frameQueue[i].ts <= audioTime) showIdx = i
        else break
      }
      if (showIdx < 0) return
      const target = frameQueue[showIdx]
      // showIdx より前(古い)のフレームは閉じて捨てる
      for (let i = 0; i < showIdx; i++) frameQueue[i].frame.close()
      ctx2d.drawImage(target.frame, 0, 0, canvas.width, canvas.height)
      target.frame.close()
      frameQueue = frameQueue.slice(showIdx + 1)
    }
    rafId = requestAnimationFrame(render)

    // AudioContext がブラウザの自動再生ポリシーで suspended のままだと音が
    // 出ない。feedAudioData 内の resume() は非同期でジェスチャから離れており
    // 効かないため、ユーザーの操作(クリック/キー)で確実に resume する。
    const resumeAudio = () => {
      const ctx = (Module as any).myAudio?.ctx as AudioContext | undefined
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {})
      }
    }
    document.addEventListener('pointerdown', resumeAudio)
    document.addEventListener('keydown', resumeAudio)
    resumeAudio()

    webCodecsCtrlRef.current = {
      stop: () => {
        stopped = true
        cancelAnimationFrame(rafId)
        document.removeEventListener('pointerdown', resumeAudio)
        document.removeEventListener('keydown', resumeAudio)
        Module.setVideoAuCallback(null as any)
        try {
          decoder.close()
        } catch (e) {}
        for (const f of frameQueue) f.frame.close()
        frameQueue = []
      },
    }
  }

  const [wakeLock, setWakeLock] = useState<WakeLockSentinel>()
  const [wasmMod, setWasmMod] = useState<WasmModule | null>(null)

  useEffect(() => {
    let mounted = true;
    console.log("useEffect", initialized)
    if (initialized) {
      return
    }
    initialized = true;
    ;(async () => {
      console.log("async", wasmMod, initialized)

      const adapter = await (navigator as any).gpu.requestAdapter()
      const device = await adapter.requestDevice()
      const script = document.createElement('script')
      script.onload = () => {
        console.log("onload")
        ;(window as any)
          .createWasmModule({ preinitializedWebGPUDevice: device })
          .then((m: WasmModule) => {
            console.log('then', m)
            console.log("setWasmMod")
            setWasmMod(m)
          })
      }
      script.src = "/wasm/ts-live.js"
      document.head.appendChild(script)
      console.log("script element created")
    })();
}, [])

  useEffect(() => {
    if (!wasmMod) return
    if (dualMonoMode === undefined) return
    wasmMod.setDualMonoMode(dualMonoMode)
  }, [wasmMod, dualMonoMode])

  useEffect(() => {
    if (!wasmMod) return
    if (debugLog === undefined) return
    if (debugLog) {
      wasmMod.setLogLevelDebug()
    } else {
      wasmMod.setLogLevelInfo()
    }
  }, [wasmMod, debugLog])

  // const canvasProviderState = useAsync(async () => {
  //   const CanvasProvider = await import('aribb24.js').then(
  //     mod => mod.CanvasProvider
  //   )
  //   return CanvasProvider
  // })
  const statsCallback = useCallback(function statsCallbackFunc(statsDataList: StatsData[]) {
    setChartData(prev => {
      if (prev.length + statsDataList.length > 300) {
        const overLength = prev.length + statsDataList.length - 300
        prev.copyWithin(0, overLength)
        prev.length -= statsDataList.length + overLength
      }
      return prev.concat(statsDataList)
    })
  }, [])

  useEffect(() => {
    if (!mirakurunServer) return
    fetch(`${mirakurunServer}/api/version`)
      .then(response => {
        if (response.ok && response.body !== null) {
          return response.json().then(({ current }) => {
            setMirakurunOk(true)
            setMirakurunVersion(current)
          })
        }
      })
      .catch(e => {
        console.log(e)
        setMirakurunOk(false)
      })
  }, [mirakurunServer])

  useEffect(() => {
    if (!mirakurunServer || !mirakurunOk) {
      return
    }
    fetch(`${mirakurunServer}/api/services?type=1`).then(response => {
      if (response.ok && response.body !== null) {
        response.json().then((retval: Array<Service>) => {
          const registeredIdMap: { [key: string]: boolean } = {}
          setTvServices(
            retval
              .map(v => {
                if (v.id in registeredIdMap) {
                  return null
                } else {
                  registeredIdMap[v.id] = true
                  return v
                }
              })
              .filter(v => v) as Array<Service>
          )
        })
      }
    })
  }, [mirakurunOk, mirakurunServer])

  // 起動時: URL ハッシュに stream URL があれば Mirakurun サーバーと対象
  // サービスを取り出して自動再生の準備をする。
  useEffect(() => {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''))
    if (!hash) return
    const m = hash.match(/^(https?:\/\/[^/]+)\/api\/services\/(\d+)\/stream/)
    if (!m) return
    setMirakurunServer(m[1])
    setPendingServiceId(parseInt(m[2], 10))
    setTouched(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // サービス一覧が揃ったら、ハッシュで指定されたサービスを選択して再生する。
  useEffect(() => {
    if (pendingServiceId == null) return
    if (!tvServices || tvServices.length === 0) return
    const svc = tvServices.find(s => s.id === pendingServiceId)
    if (svc) {
      setActiveService(svc)
      setTouched(true)
      setPendingServiceId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingServiceId, tvServices])

  useEffect(() => {
    if (!mirakurunServer || !mirakurunOk) {
      return
    }
    fetch(`${mirakurunServer}/api/programs`).then(response => {
      if (response.ok && response.body !== null) {
        response.json().then((retVal: Array<Program>) => {
          setPrograms(retVal)
        })
      }
    })
  }, [mirakurunOk, mirakurunServer])

  const findCurrentProgram = (programs: Array<Program>, activeService: Service) => {
    const currentTime = Date.now()
    const current = programs.find(v => {
      if (
        v.networkId === activeService.networkId &&
        v.serviceId === activeService.serviceId &&
        v.startAt <= currentTime &&
        currentTime < v.startAt + v.duration
      ) {
        return true
      } else {
        return false
      }
    })
    if (current !== undefined) {
      setCurrentProgram(current)
      setTimeout(() => {
        setPrograms(prev => [...prev.filter(p => p.id !== current.id)])
      }, current.startAt + current.duration - currentTime)
    }
  }

  useEffect(() => {
    if (!activeService) {
      return
    }
    findCurrentProgram(programs, activeService)
  }, [programs, activeService])

  useEffect(() => {
    if (!epgStationServer) return
    fetch(`${epgStationServer}/api/version`)
      .then(response => {
        if (response.ok && response.body !== null) {
          return response.json().then(({ version }) => {
            setEpgStationOk(true)
            setEpgStationVersion(version)
          })
        }
      })
      .catch(e => {
        console.log(e)
        setEpgStationOk(false)
      })
  }, [epgStationServer])

  useEffect(() => {
    if (!epgStationServer || !epgStationOk) return
    fetch(`${epgStationServer}/api/recorded?isHalfWidth=false&offset=0&limit=30`)
      .then(response => {
        if (response.ok && response.body !== null) {
          return response.json().then(ret => {
            const recordedFileList: Array<EpgRecordedFile> = []
            ret.records?.forEach((v: any) => {
              v.videoFiles.forEach((r: any) => {
                if (r.type === 'ts') {
                  recordedFileList.push({ filename: v.name, id: r.id })
                }
              })
            })
            setEpgRecordedFiles(recordedFileList)
          })
        }
      })
      .catch(e => {
        console.log(e)
        setEpgRecordedFiles([])
      })
  }, [epgStationServer, epgStationOk])

  useEffect(() => {
    if (!touched) {
      console.log('not touched')
      return
    }
    if (!mirakurunOk || !mirakurunServer || !activeService) {
      console.log('mirakurunServer or activeService', mirakurunOk, mirakurunServer, activeService)
      return
    }
    if (!wasmMod) {
      console.log('WasmModule not loaded', wasmMod)
      return
    }
    const Module = wasmMod
    // 現在の再生中を止める（or 何もしない）
    stopFunc()
    // 再生開始のたびに前の字幕を消す(同一 service の再選択や EPGStation ファイル
    // 切替では service が変わらないため、token で明示的にクリアする)
    setCaptionResetToken(t => t + 1)

    // 視聴中のスリープを避ける
    if (!wakeLock) {
      navigator.wakeLock.request('screen').then(lock => setWakeLock(lock))
    }

    // ARIB字幕パケットそのものを受け取るコールバック
    // Module.setCaptionCallback(captionData => {
    //   console.log('Caption Callback', captionData)
    // })
    if (showCharts) {
      // depsに入れると毎回リスタートするので入れない
      Module.setStatsCallback(statsCallback)
    } else {
      Module.setStatsCallback(null)
    }

    // 0.2秒遅らす
    setTimeout(() => {
      // 再生スタート
      if (playMode === 'live') {
        const ac = new AbortController()
        const channelType = activeService.channel?.type as string
        const isBS4K = channelType === 'BS4K'
        // WebCodecs (ハードウェアデコード) を試みる対象: BS4K (HEVC) と
        // SKY=スカパープレミアム (H.264)。実際に使うかは WASM が probe 後に
        // コーデックを見て決め、videoStreamInfo で通知してくる(非対応コーデック
        // は WASM ソフトデコードへ自動フォールバック)。
        const wantWebCodecs =
          (isBS4K || channelType === 'SKY') && typeof VideoDecoder !== 'undefined'
        if (wantWebCodecs) {
          Module.setVideoStreamInfoCallback((info: VideoStreamInfo) => {
            console.log('videoStreamInfo:', info)
            if (info.webCodecs) {
              startWebCodecs(Module, wcCanvasRef.current, info)
              setWebCodecsActive(true)
            }
          })
        } else {
          Module.setVideoStreamInfoCallback(null as any)
        }
        setStopFunc(() => () => {
          console.log('abort fetch')
          ac.abort()
          Module.setVideoStreamInfoCallback(null as any)
          if (webCodecsCtrlRef.current) {
            webCodecsCtrlRef.current.stop()
            webCodecsCtrlRef.current = null
          }
          setWebCodecsActive(false)
          Module.reset()
          console.log('abort fetch done.')
        })
        Module.setTlvMode(isBS4K)
        Module.setWebCodecsMode(wantWebCodecs)
        const url = `${mirakurunServer}/api/services/${activeService.id}/stream?decode=1`
        console.log('start fetch', url, Module)
        // NOTE: カスタムヘッダーを付けると CORS preflight が必須になり、HTTPS(公開)
        // オリジンから LAN 上の HTTP Mirakurun への Local Network Access が
        // preflight 経路で拒否される (Chrome)。ヘッダーを付けず simple request に
        // することで /api/services などと同じく通す。優先度は既定(0)で十分。
        fetch(url, {
          signal: ac.signal,
        })
          .then(async response => {
            if (!response.body) {
              console.error('response body is not supplied.')
              return
            }
            const sleep = (msec: number) => new Promise(resolve => setTimeout(resolve, msec))
            const reader = response.body.getReader()
            let ret = await reader.read()
            while (!ret.done) {
              if (ret.value) {
                try {
                  while (true) {
                    const buffer = Module.getNextInputBuffer(ret.value.length)
                    if (!buffer) {
                      await sleep(100)
                      continue
                    }
                    buffer.set(ret.value)
                    // console.debug('calling enqueueData', chunk.length)
                    Module.commitInputData(ret.value.length)
                    // console.debug('enqueData done.')
                    break
                  }
                } catch (ex) {
                  if (typeof ex === 'number') {
                    console.error(Module.getExceptionMsg(ex))
                    throw ex
                  }
                }
              }
              ret = await reader.read()
            }
          })
          .catch(ex => {
            console.log('fetch aborted ex:', ex)
          })
      } else if (playMode === 'file') {
        setStopFunc(() => () => {
          Module.reset()
        })
        // 直前の再生のモードが残らないよう明示的にリセットする(EPGStation の
        // 録画は 2K TS 前提で WASM ソフトデコード)。
        Module.setVideoStreamInfoCallback(null as any)
        Module.setTlvMode(false)
        Module.setWebCodecsMode(false)
        const url = `${epgStationServer}/api/videos/${activeRecordedFileId}`
        Module.playFile(url)
      }
    }, 500)
  }, [
    touched,
    mirakurunOk,
    epgStationOk,
    activeService,
    activeRecordedFileId,
    playMode,
    wasmMod,
  ])

  // ローカルに保存した TS/TLV ファイルを再生する(字幕デバッグ用)。ライブ視聴と
  // 同じ push 入力経路(getNextInputBuffer/commitInputData)へ File を流し込むので
  // サーバー不要で、デコード・字幕経路もライブと完全に同一になる。
  useEffect(() => {
    localLoopRef.current = !!localLoop
  }, [localLoop])

  // ファイル先頭を読み、MPEG-TS(同期バイト 0x47 が 188/192 バイト間隔で並ぶ)なら
  // 2K(TS)=false、それ以外は BS4K TLV とみなす。'auto' モードで使う。
  const detectTlvFromHeader = async (file: File): Promise<boolean> => {
    const buf = new Uint8Array(await file.slice(0, 192 * 24).arrayBuffer())
    const looksTs = (start: number, stride: number) => {
      let hit = 0
      for (let i = 0; i < 8; i++) {
        const pos = start + i * stride
        if (pos < buf.length && buf[pos] === 0x47) hit++
      }
      return hit >= 6
    }
    // 188=通常TS, 192(offset4)=M2TS(4バイトタイムスタンプ付), 192(offset0)も一応
    const isTs = looksTs(0, 188) || looksTs(4, 192) || looksTs(0, 192)
    return !isTs
  }

  const playLocalFile = (file: File) => {
    if (!wasmMod) {
      console.error('WasmModule not loaded')
      return
    }
    const Module = wasmMod
    lastLocalFileRef.current = file
    setLocalFileName(file.name)
    setPlayMode('localfile')
    // 現在の再生を止める
    stopFunc()
    // 前ファイルの字幕を消す(service が変わらないので token で明示的にクリア)
    setCaptionResetToken(t => t + 1)
    setDrawer(false)

    // 視聴中のスリープを避ける
    if (!wakeLock) {
      navigator.wakeLock.request('screen').then(lock => setWakeLock(lock)).catch(() => {})
    }

    if (showCharts) {
      Module.setStatsCallback(statsCallback)
    } else {
      Module.setStatsCallback(null)
    }

    const sleep = (msec: number) => new Promise(resolve => setTimeout(resolve, msec))
    ;(async () => {
      // 再生モード(TLV=BS4K / TS=2K)を確定する。auto は先頭バイトで判定。
      const tlv =
        localMode === 'tlv' ? true : localMode === 'ts' ? false : await detectTlvFromHeader(file)
      console.log('local file mode', file.name, { localMode, tlv })
      // 直前の再生停止(reset)が落ち着くまで少し待つ
      await sleep(500)

      // ローカルファイルは常に WebCodecs を試みる。実際に使うかは WASM が
      // probe 後にコーデックで決める(HEVC/H.264 なら WebCodecs、MPEG-2 等は
      // WASM ソフトデコードへ自動フォールバック)。
      const wantWebCodecs = typeof VideoDecoder !== 'undefined'
      if (wantWebCodecs) {
        Module.setVideoStreamInfoCallback((info: VideoStreamInfo) => {
          console.log('videoStreamInfo:', info)
          if (info.webCodecs) {
            startWebCodecs(Module, wcCanvasRef.current, info)
            setWebCodecsActive(true)
          }
        })
      } else {
        Module.setVideoStreamInfoCallback(null as any)
      }
      let aborted = false
      setStopFunc(() => () => {
        console.log('abort local file')
        aborted = true
        Module.setVideoStreamInfoCallback(null as any)
        if (webCodecsCtrlRef.current) {
          webCodecsCtrlRef.current.stop()
          webCodecsCtrlRef.current = null
        }
        setWebCodecsActive(false)
        Module.reset()
      })
      Module.setTlvMode(tlv)
      Module.setWebCodecsMode(wantWebCodecs)

      console.log('start local file', file.name, file.size)
      {
        const reader = file.stream().getReader()
        let ret = await reader.read()
        while (!ret.done) {
          if (aborted) {
            reader.cancel().catch(() => {})
            break
          }
          if (ret.value) {
            try {
              while (true) {
                if (aborted) break
                const buffer = Module.getNextInputBuffer(ret.value.length)
                if (!buffer) {
                  // バッファ満杯: ライブと同じくデコード側が消費するまで待つ
                  await sleep(100)
                  continue
                }
                buffer.set(ret.value)
                Module.commitInputData(ret.value.length)
                break
              }
            } catch (ex) {
              if (typeof ex === 'number') {
                console.error(Module.getExceptionMsg(ex))
                throw ex
              }
            }
          }
          ret = await reader.read()
        }
        console.log('local file feed done.', file.name)

        // ループ再生: フィード完了後もバッファ(最大48MB)分は再生が続くため、音声
        // クロックが進まなくなった=バッファ枯渇を待ってから頭出しし直す。
        if (!aborted && localLoopRef.current) {
          let last = -999
          let stable = 0
          while (!aborted && localLoopRef.current) {
            await sleep(500)
            const t = Module.getAudioPlaybackTime()
            if (t >= 0 && Math.abs(t - last) < 0.05) {
              // 約1秒(2回連続)進捗が無ければ枯渇とみなす
              if (++stable >= 2) break
            } else {
              stable = 0
            }
            last = t
          }
          if (!aborted && localLoopRef.current) {
            console.log('local file loop: restart', file.name)
            playLocalFile(file)
          }
        }
      }
    })().catch(ex => {
      console.log('local file read ex:', ex)
    })
  }

  useKey(
    'F2',
    () => {
      console.log('Hotkey s pressed!!!')
      if (!videoCanvasRef.current || !captionCanvasRef.current) return
      const video = videoCanvasRef.current
      const caption = captionCanvasRef.current
      const canvas = document.createElement('canvas')
      canvas.width = video.width
      canvas.height = video.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0)
      if (showCaption) {
        ctx.drawImage(caption, 0, 0)
      }
      const a = document.createElement('a')
      a.href = canvas.toDataURL('image/png')
      a.download = `${dayjs().format('YYYYMMDD-HHmmss_SSS')}.png`
      a.click()
    },
    {},
    [showCaption]
  )

  const getServicesOptions = useCallback(() => {
    return tvServices.map((service, idx) => {
      return (
        <MenuItem key={service.id} value={service.id}>
          {service.name}
        </MenuItem>
      )
    })
  }, [tvServices])

  const getProgramFilesOptions = useCallback(() => {
    return epgRecordedFiles?.map(prog => {
      return (
        <MenuItem key={prog.id} value={prog.id}>
          {prog.filename}
        </MenuItem>
      )
    })
  }, [epgRecordedFiles, activeRecordedFileId])

  useEffect(() => {
    if (!wasmMod) return
    if (volume === undefined) return
    wasmMod.setAudioGain(mute ? 0.0 : volume)
  }, [wasmMod, volume, mute])

  return (
    <Box
      css={css`
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        background: #1e1e1e;
      `}
    >
      <Head>
        <title>
          TS-Live! {currentProgram && currentProgram.name && `| ${currentProgram.name}`}
        </title>
      </Head>
      <Script
        src="https://www.googletagmanager.com/gtag/js?id=G-SR7L1XYNV0"
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){window.dataLayer.push(arguments);}
            gtag('js', new Date());

            gtag('config', 'G-SR7L1XYNV0');
          `}
      </Script>
      <Drawer
        anchor="left"
        open={drawer}
        onClose={() => {
          // Mirakurun 接続時に加え、ローカルファイル再生中も背景クリック/Escape で
          // 閉じられるようにする(未接続だと閉じられず操作不能になる不具合の対策)。
          if (mirakurunOk || localFileName) {
            setTouched(true)
            setDrawer(false)
          }
        }}
      >
        <Box
          css={css`
            width: 320px;
            padding: 24px 24px;
          `}
        >
          <div
            css={css`
              font-weight: bold;
              font-size: 19px;
            `}
          >
            {'TS-Live!'} {debug ? 'Debug' : ''}
          </div>
          <div>{`version: ${process.env.VERSION}`}</div>
          <Divider
            css={css`
              margin: 10px 0px;
            `}
          ></Divider>
          <FormGroup>
            <TextField
              label="Mirakurun Server"
              placeholder="http://mirakurun:40772"
              css={css`
                width: 100%;
              `}
              onChange={ev => {
                setMirakurunServer(ev.target.value)
              }}
              value={mirakurunServer}
            ></TextField>
            <div
              css={css`
                margin-top: 16px;
              `}
            >
              {mirakurunOk ? `Mirakurun: OK (version: ${mirakurunVersion})` : 'Mirakurun: NG'}
            </div>
          </FormGroup>
          <FormGroup>
            <FormControl
              fullWidth
              css={css`
                margin-top: 24px;
                width: 100%;
              `}
            >
              <InputLabel id="services-label">Services</InputLabel>
              <Select
                css={css`
                  width: 100%;
                `}
                label="Services"
                labelId="services-label"
                defaultValue={
                  activeService ? activeService.id : tvServices.length > 0 ? tvServices[0].id : null
                }
                onChange={ev => {
                  if (ev.target.value !== null && typeof (ev.target.value === 'number')) {
                    const id = ev.target.value
                    const active = tvServices.find(v => v.id === id)
                    if (active) setActiveService(active)
                    setTouched(true)
                  }
                  setDrawer(false)
                }}
              >
                {getServicesOptions()}
              </Select>
            </FormControl>
          </FormGroup>
          <FormGroup>
            <FormControl
              fullWidth
              css={css`
                margin-top: 24px;
                width: 100%;
              `}
            >
              <Stack spacing={2} direction="row" sx={{ mb: 1 }} alignItems="center">
                <Button
                  size="small"
                  variant="outlined"
                  css={css`
                    padding: 3px 3px;
                    min-width: 32px;
                  `}
                  onClick={() => setMute(!mute)}
                >
                  {mute ? <VolumeMute /> : <VolumeUp />}
                </Button>
                <Slider
                  aria-label="Volume"
                  min={0}
                  max={2}
                  step={0.05}
                  value={mute ? 0 : volume}
                  disabled={mute}
                  valueLabelDisplay="auto"
                  onChange={(ev, val) => {
                    if (typeof val === 'number') setVolume(val)
                  }}
                />
              </Stack>
            </FormControl>
          </FormGroup>
          <FormControl
            fullWidth
            css={css`
              margin-top: 24px;
              width: 100%;
            `}
          >
            <InputLabel id="dualmonomode-label">音声 主/副</InputLabel>
            <Select
              css={css`
                width: 100%;
              `}
              label="音声 0主/副"
              labelId="dualmonomode-label"
              value={dualMonoMode}
              onChange={ev => {
                if (ev.target.value !== null && typeof ev.target.value === 'number') {
                  setDualMonoMode(ev.target.value)
                }
              }}
            >
              <MenuItem value={0}>主</MenuItem>
              <MenuItem value={1}>副</MenuItem>
            </Select>
          </FormControl>
          <FormGroup>
            <FormControlLabel
              control={
                <Checkbox
                  checked={showCaption}
                  onChange={ev => {
                    setShowCaption(ev.target.checked)
                  }}
                ></Checkbox>
              }
              label="字幕を表示する"
            ></FormControlLabel>
          </FormGroup>
          {debug ? (
            <div>
              <Divider
                css={css`
                  margin: 10px 0px;
                `}
              ></Divider>
              <FormGroup>
                <TextField
                  label="EPGStation Server"
                  placeholder="http://epgstation:8888"
                  css={css`
                    width: 100%;
                  `}
                  onChange={ev => {
                    setEpgStationServer(ev.target.value)
                  }}
                  value={epgStationServer}
                ></TextField>
                <div>
                  {epgStationOk
                    ? `EPGStation: OK (version: ${epgStationVersion})`
                    : 'EPGStation: NG'}
                </div>
              </FormGroup>
              <FormGroup>
                <FormControl
                  fullWidth
                  css={css`
                    margin-top: 24px;
                    width: 100%;
                  `}
                >
                  <InputLabel id="program-files-label">録画ファイル</InputLabel>
                  <Select
                    css={css`
                      width: 100%;
                    `}
                    label="ProgramFiles"
                    labelId="program-files-label"
                    value={activeRecordedFileId !== undefined ? activeRecordedFileId : ''}
                    onChange={ev => {
                      if (ev.target.value !== null && typeof ev.target.value === 'number') {
                        setActiveRecordedFileId(ev.target.value)
                        setPlayMode('file')
                      }
                    }}
                  >
                    {getProgramFilesOptions()}
                  </Select>
                </FormControl>
              </FormGroup>
              <FormGroup>
                <FormControl
                  fullWidth
                  css={css`
                    margin-top: 24px;
                    width: 100%;
                  `}
                >
                  <InputLabel id="playmode-label">再生モード</InputLabel>
                  <Select
                    css={css`
                      width: 100%;
                    `}
                    label="再生モード"
                    labelId="playmode-label"
                    value={playMode}
                    onChange={ev => {
                      if (ev.target.value !== null && typeof ev.target.value === 'string') {
                        setPlayMode(ev.target.value)
                      }
                    }}
                  >
                    <MenuItem value="live">ライブ視聴</MenuItem>
                    {activeRecordedFileId !== undefined && (
                      <MenuItem value="file">ファイル再生</MenuItem>
                    )}
                    {localFileName && (
                      <MenuItem value="localfile">ローカルファイル</MenuItem>
                    )}
                  </Select>
                </FormControl>
              </FormGroup>
              <Divider
                css={css`
                  margin: 16px 0px 8px;
                `}
              ></Divider>
              <FormGroup>
                <FormControl
                  fullWidth
                  css={css`
                    width: 100%;
                  `}
                >
                  <InputLabel id="localmode-label">ローカル再生の種別</InputLabel>
                  <Select
                    css={css`
                      width: 100%;
                    `}
                    label="ローカル再生の種別"
                    labelId="localmode-label"
                    value={localMode}
                    onChange={ev => {
                      if (typeof ev.target.value === 'string') setLocalMode(ev.target.value)
                    }}
                  >
                    <MenuItem value="auto">自動判定</MenuItem>
                    <MenuItem value="ts">2K (TS)</MenuItem>
                    <MenuItem value="tlv">BS4K (TLV/HEVC)</MenuItem>
                  </Select>
                </FormControl>
                <input
                  ref={localFileInputRef}
                  type="file"
                  accept=".ts,.m2ts,.tlv,.mmts,application/octet-stream"
                  hidden
                  onChange={ev => {
                    const file = ev.target.files?.[0]
                    if (file) playLocalFile(file)
                    // 同じファイルを再選択しても onChange が発火するようクリア
                    ev.target.value = ''
                  }}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={!!localLoop}
                      onChange={ev => setLocalLoop(ev.target.checked)}
                    ></Checkbox>
                  }
                  label="ループ再生"
                ></FormControlLabel>
                <Stack spacing={1} direction="row" css={css`margin-top: 8px;`}>
                  <Button
                    variant="outlined"
                    css={css`flex: 1;`}
                    onClick={() => localFileInputRef.current?.click()}
                  >
                    ファイルを開く
                  </Button>
                  <Button
                    variant="outlined"
                    css={css`flex: 1;`}
                    disabled={!localFileName}
                    onClick={() => {
                      if (lastLocalFileRef.current) playLocalFile(lastLocalFileRef.current)
                    }}
                  >
                    最初から再生
                  </Button>
                </Stack>
                {localFileName && (
                  <div
                    css={css`
                      margin-top: 8px;
                      font-size: 12px;
                      word-break: break-all;
                    `}
                  >
                    {`再生中: ${localFileName}`}
                  </div>
                )}
              </FormGroup>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={showCharts}
                      onChange={ev => {
                        setShowCharts(ev.target.checked)
                        if (ev.target.checked) {
                          wasmMod?.setStatsCallback(statsCallback)
                        } else {
                          wasmMod?.setStatsCallback(null)
                        }
                      }}
                    ></Checkbox>
                  }
                  label="統計グラフを表示する"
                ></FormControlLabel>
              </FormGroup>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={debugLog}
                      onChange={ev => {
                        setDebugLog(ev.target.checked)
                      }}
                    ></Checkbox>
                  }
                  label="デバッグログを出力する"
                ></FormControlLabel>
              </FormGroup>
            </div>
          ) : (
            <></>
          )}
        </Box>
      </Drawer>
      <div
        css={css`
          position: relative;
          width: 100%;
          height: 100%;
        `}
      >
        <canvas
          css={css`
            position: absolute;
            top: 50%;
            left: 50%;
            max-width: 100%;
            max-height: 100%;
            z-index: 1;
          `}
          id="video"
          ref={videoCanvasRef}
          tabIndex={-1}
          width={1920}
          height={1080}
          onClick={() => setDrawer(true)}
          onContextMenu={ev => ev.preventDefault()}
          // transformはWasmが書き換えるので要素のタグに直接書くこと
          style={{
            transform: 'translate(-50%, -50%)',
          }}
        ></canvas>
        <canvas
          css={css`
            position: absolute;
            top: 50%;
            left: 50%;
            max-width: 100%;
            max-height: 100%;
            z-index: 2;
          `}
          id="videoWC"
          ref={wcCanvasRef}
          tabIndex={-1}
          width={3840}
          height={2160}
          hidden={!webCodecsActive}
          onClick={() => setDrawer(true)}
          onContextMenu={ev => ev.preventDefault()}
          style={{
            transform: 'translate(-50%, -50%)',
          }}
        ></canvas>
        <div hidden={!showCaption}>
          <Caption
            service={activeService}
            wasmModule={wasmMod!}
            canvasRef={captionCanvasRef}
            width={1920}
            height={1080}
            show={showCaption}
            resetToken={captionResetToken}
          ></Caption>
        </div>
        <div
          css={css`
            position: absolute;
            z-index: 99;
            width: 100%;
            height: 100%;
          `}
          onClick={() => setDrawer(true)}
        ></div>
        {debug ? (
          <div
            css={css`
              display: ${showCharts ? 'flex' : 'none'};
              align-content: flex-start;
              flex-direction: column;
              flex-wrap: wrap;
              position: absolute;
              left: 0px;
              top: 0px;
              width: 100%;
              height: 100%;
              padding: 28px 12px;
              pointer-events: none;
              z-index: 5;
            `}
          >
            <LineChart
              width={550}
              height={250}
              data={showCharts ? chartData : []}
              css={css`
                position: absolute;
                left: 0px;
                top: 0px;
              `}
            >
              <CartesianGrid strokeDasharray={'3 3'} />
              <XAxis dataKey="time" />
              <YAxis />
              <Legend />
              <Line
                type="linear"
                dataKey="VideoFrameQueueSize"
                name="Video Queue Size"
                stroke="#8884d8"
                isAnimationActive={false}
                dot={false}
              />
            </LineChart>
            <LineChart width={550} height={250} data={showCharts ? chartData : []}>
              <CartesianGrid strokeDasharray={'3 3'} />
              <XAxis dataKey="time" />
              <YAxis />
              <Legend />
              <Line
                type="linear"
                dataKey="AudioFrameQueueSize"
                name="Audio Queue Size"
                stroke="#82ca9d"
                isAnimationActive={false}
                dot={false}
              />
            </LineChart>
            <LineChart width={550} height={250} data={showCharts ? chartData : []}>
              <CartesianGrid strokeDasharray={'3 3'} />
              <XAxis dataKey="time" />
              <YAxis />
              <Legend />
              <Line
                type="linear"
                dataKey="CaptionDataQueueSize"
                name="Caption Data Size"
                stroke="#9dca82"
                isAnimationActive={false}
                dot={false}
              />
            </LineChart>
            <LineChart width={550} height={250} data={showCharts ? chartData : []}>
              <CartesianGrid strokeDasharray={'3 3'} />
              <XAxis dataKey="time" />
              <YAxis />
              <Legend />
              <Line
                type="linear"
                dataKey="AudioWorkletBufferSize"
                name="AudioWorklet Buffer Size"
                stroke="#9d82ca"
                isAnimationActive={false}
                dot={false}
              />
            </LineChart>
            <LineChart width={550} height={250} data={showCharts ? chartData : []}>
              <CartesianGrid strokeDasharray={'3 3'} />
              <XAxis dataKey="time" />
              <YAxis />
              <Legend />
              <Line
                type="linear"
                dataKey="InputBufferSize"
                name="Input Buffer Size"
                stroke="#ca829d"
                isAnimationActive={false}
                dot={false}
              />
            </LineChart>
          </div>
        ) : (
          <></>
        )}
      </div>
    </Box>
  )
}

export default Page

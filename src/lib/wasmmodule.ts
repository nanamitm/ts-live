// decoderMainloop() が statsCallback へ渡す 1 サンプル。キー名は WASM 側の
// data.set(...) と一致させること。
export declare interface StatsData {
  time: number
  VideoFrameQueueSize: number
  AudioFrameQueueSize: number
  AudioWorkletBufferSize: number
  InputBufferSize: number
  CaptionDataQueueSize: number
}

// probe 後に WASM から通知される映像ストリーム情報。webCodecs は「実際に
// WebCodecs 経路を使うか」(非対応コーデックはソフトデコードへフォールバック)。
export declare interface VideoStreamInfo {
  codec: string
  width: number
  height: number
  profile: number
  level: number
  sarNum: number
  sarDen: number
  webCodecs: boolean
}

export declare interface WasmModule extends EmscriptenModule {
  getExceptionMsg(ex: number): string
  setLogLevelDebug(): void
  setLogLevelInfo(): void
  showVersionInfo(): void
  setCaptionCallback(
    callback: (
      pts: number,
      ptsTime: number,
      captionData: Uint8Array,
      // 字幕が届いたアセットの stream index。番組内で字幕アセットが乗り換わる
      // (=時間軸が変わりうる)ことの検出に使う。
      streamIndex: number
    ) => void
  ): void
  setStatsCallback(
    callback: ((statsDataList: Array<StatsData>) => void) | null
  ): void
  playFile(url: string): void
  // 入力リングバッファが満杯のときは null を返す (バックプレッシャ)。
  getNextInputBuffer(size: number): Uint8Array | null
  commitInputData(size: number): void
  // 入力の供給が終わったことを伝える。デマルチプレクサはバッファを読み切った
  // ところで EOF として扱う。
  setInputEnded(): void
  // 一時停止。メインループでの描画・音声供給が止まる。
  setPaused(paused: boolean): void
  reset(): void
  // reset() の後片付けはデコードスレッドで非同期に進む。完了したら true。
  isResetCompleted(): boolean
  setAudioGain(volume: number): void
  setDualMonoMode(mode: number): void
  setTlvMode(isTlv: boolean): void
  setWebCodecsMode(enabled: boolean): void
  setVideoAuCallback(
    callback: ((data: Uint8Array, ptsSec: number, isKey: boolean) => void) | null
  ): void
  setVideoStreamInfoCallback(
    callback: ((info: VideoStreamInfo) => void) | null
  ): void
  getAudioPlaybackTime(): number
}
export declare var Module: WasmModule

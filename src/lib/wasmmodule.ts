export declare interface StatsData {
  time: number
  VideoFrameQueueSize: number
  AudioFrameQueueSize: number
  SDLQueuedAudioSize: number
  InputBufferSize: number
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
    callback: (pts: number, ptsTime: number, captionData: Uint8Array) => void
  ): void
  setStatsCallback(
    callback: ((statsDataList: Array<StatsData>) => void) | null
  ): void
  playFile(url: string): void
  getNextInputBuffer(size: number): Uint8Array
  commitInputData(size: number): void
  reset(): void
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

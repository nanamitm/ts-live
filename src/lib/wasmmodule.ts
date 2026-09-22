// decoderMainloop() が statsCallback へ渡す 1 サンプル。キー名は WASM 側の
// data.set(...) と一致させること。
export declare interface StatsData {
  time: number
  VideoFrameQueueSize: number
  AudioFrameQueueSize: number
  AudioWorkletBufferSize: number
  InputBufferSize: number
  CaptionDataQueueSize: number
  // wasm のヒープの現在サイズ(MB)。INITIAL_MEMORY の妥当性を見るため。
  HeapSizeMB: number
  // 逆テレシネが有効なときだけ付く。そのフレームをテレシネとして扱ったか。
  TelecineFlag?: boolean
}

// grabFirstFrame() が返す画像。元の半分の解像度の RGBA (buffer は WASM
// ヒープ上のビューなので、次の呼び出しまでに使い切るかコピーすること)。
export declare interface GrabbedFrame {
  width: number
  height: number
  buffer: Uint8Array
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
  // 表示済みの映像フレーム数 (単調増加)。シーク後に最初の1枚が出たかの判定用。
  getDisplayedFrameCount(): number
  reset(): void
  // reset() の後片付けはデコードスレッドで非同期に進む。完了したら true。
  isResetCompleted(): boolean
  setAudioGain(volume: number): void
  setDualMonoMode(mode: number): void
  // インターレース解除の方式を 'yadif' | 'bwdif' | 'none' で指定し、実際に
  // 適用された方式を返す (WASM ソフトデコード経路のみ。WebCodecs 経路の映像は
  // ブラウザ側でデコード・表示するのでこの設定は効かない)。
  setDeinterlace(filter: string): string
  // WASM 経路の描画バッファ(= #video canvas)の解像度。表示している大きさを
  // デバイスピクセルで渡す。
  resizeSwapChain(width: number, height: number): void
  // 逆テレシネ。0=しない, 1=常にかける, 2=テレシネと判定したときだけ。
  setDetelecineMode(mode: number): void
  // 再生速度 (0.1〜100)。音声を伸縮し、映像は音声クロックに従う。0.5 未満は
  // 音が出ない (無音で引き伸ばす)。ライブでは供給が実時間なので 1.0 より速く
  // すると足りなくなる。
  setPlaybackRate(rate: number): void
  // サムネイル用のフレーム取得。再生系とは独立した状態を持つので再生中でも
  // 使える。入力は MPEG-2 の生ES のみ (TS/TLV コンテナは不可)。
  // getGrabberInputBuffer() が返すビューへ書いてから grabFirstFrame() を呼ぶ。
  getGrabberInputBuffer(size: number): Uint8Array
  grabFirstFrame(size: number): GrabbedFrame | null
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

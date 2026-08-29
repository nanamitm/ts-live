#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstring>
#include <deque>
#include <emscripten/bind.h>
#include <emscripten/emscripten.h>
#include <emscripten/fetch.h>
#include <emscripten/threading.h>
#include <emscripten/val.h>
#include <mutex>
#include <spdlog/spdlog.h>
#include <thread>

#include "../audio/audioworklet.hpp"
#include "../video/webgpu.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

// tsreadex
#include <servicefilter.hpp>

CServiceFilter servicefilter;
int servicefilterRemain = 0;

// BS4K/8K (MMT/TLV) は 2K放送(~15-20Mbps)より高ビットレート(~25-30Mbps)で、
// resync待ちなどでデコードスレッドが一時的に詰まった際の余裕を持たせるため
// 通常より大きめに確保する。
const size_t MAX_INPUT_BUFFER = 48 * 1024 * 1024;
const size_t PROBE_SIZE = 1024 * 1024;
const size_t DEFAULT_WIDTH = 1920;
const size_t DEFAULT_HEIGHT = 1080;

std::chrono::system_clock::time_point startTime;

std::atomic<bool> resetedDecoder{false};
std::uint8_t inputBuffer[MAX_INPUT_BUFFER];
std::mutex inputBufferMtx;
std::condition_variable waitCv;

// これまでに表示した映像フレーム数 (単調増加)。JS が「シーク後に最初の1枚が
// 出たか」を判定して一時停止し直すのに使う。
std::atomic<int64_t> displayedFrameCount{0};

double getDisplayedFrameCount() {
  return (double)displayedFrameCount.load(std::memory_order_relaxed);
}

// 一時停止中。メインループでのフレーム取り出し・描画・音声供給を止める。
// デコード側は各キューの上限に当たって自然に止まるので、ここだけで足りる。
std::atomic<bool> paused{false};

void setPaused(bool value) {
  paused = value;
  spdlog::info("setPaused: {}", value);
}

// 入力の終端に達した (ローカルファイルを流し切った / Range ダウンロードが
// 最後のチャンクまで届いた)。read_packet はバッファを読み切ったところで
// AVERROR_EOF を返し、デマルチプレクサに「もう来ない」と伝える。これが無いと
// ffmpeg は次のデータを待ち続け、バッファ末尾に残ったぶんが処理されないまま
// 再生が止まる。
std::atomic<bool> inputEnded{false};

// 入力の供給側 (JS のローカルファイル読み込みループ) から呼ぶ。
void setInputEnded();

// BS4K/8K (MMT/TLV) 再生時は true。read_packet() 内の 0x47 (MPEG2-TS
// sync_byte) 探索・188バイト単位の servicefilter 処理は通常放送(MPEG2-TS)
// 専用のロジックであり、可変長パケットの TLV データに対して行うと
// バイト列を破壊してしまうため、TLV モードでは素通しに切り替える。
std::atomic<bool> tlvMode{false};

void setTlvMode(bool isTlv) {
  tlvMode = isTlv;
  spdlog::info("setTlvMode: {}", isTlv);
}

size_t inputBufferReadIndex = 0;
size_t inputBufferWriteIndex = 0;

// for libav
AVCodecContext *videoCodecContext = nullptr;
AVCodecContext *audioCodecContext = nullptr;

std::deque<AVFrame *> videoFrameQueue, audioFrameQueue;
// 字幕キューの 1 件。streamIndex は届いた字幕アセットの AVStream index で、
// 番組内でアセットが乗り換わったことを JS 側が検出するために添えて渡す。
struct CaptionData {
  int64_t pts = 0;
  int streamIndex = -1;
  AVRational timeBase = {0, 1};
  bool isTtml = false;
  std::vector<uint8_t> data;
};
std::deque<CaptionData> captionDataQueue;
std::mutex videoFrameMtx, audioFrameMtx, captionDataMtx;

// 直前に送出した TTML 字幕。放送は同一内容を繰り返し送るため間引きに使う。
// リセット(サービス/ファイル切替)のたびに捨てる必要があるので、間引き処理の
// 関数ローカル static ではなくここに置く。
std::mutex ttmlMtx;
std::string lastTtml;
int lastTtmlStreamIndex = -1;
std::atomic<bool> videoFrameFound{false};

// 10bit→8bit 変換を専用スレッドに分離するための中間キュー。
// 「デコード(高速・並列)」「変換(4K swscale)」「描画」を別スレッドで
// パイプライン化し、各段が単独で実時間を維持できるようにする。デコードと
// 変換を同一スレッドで直列に行うと合計スループットが実時間を割り、映像が
// 遅れる (Video Queue が空に張り付く)。
std::deque<AVFrame *> videoConvertQueue;
std::mutex videoConvertMtx;
std::condition_variable videoConvertCv;

std::deque<AVPacket *> videoPacketQueue, audioPacketQueue;
std::mutex videoPacketMtx, audioPacketMtx;
std::condition_variable videoPacketCv, audioPacketCv;

AVStream *videoStream = nullptr;
std::vector<AVStream *> audioStreamList;
AVStream *captionStream = nullptr;
// 4K/8K (MMT/TLV) の字幕は ARIB-TTML (AV_CODEC_ID_TTML) で、2K の
// ARIB STD-B24 (AV_CODEC_ID_ARIB_CAPTION) とは符号体系が異なる。現状の
// aribb24.js は B24 専用なので、TTML のときは描画せずダンプ観測に留める。
bool captionIsTtml = false;

// AVFrame の参照バッファサイズ。buf[n] は平面数より多いインデックスや
// モノラル音声では nullptr になるため、ログ用に安全に取り出す。
static int64_t frameBufSize(const AVFrame *frame, int index) {
  if (frame == nullptr || index < 0 || index >= AV_NUM_DATA_POINTERS ||
      frame->buf[index] == nullptr) {
    return 0;
  }
  return (int64_t)frame->buf[index]->size;
}

emscripten::val captionCallback = emscripten::val::null();

// WebCodecs (JS 側ハードウェアデコード) モード。true のとき映像は WASM で
// ソフトデコードせず、アクセスユニットをそのまま JS の VideoDecoder へ渡す。
// 対応コーデックは HEVC (BS4K/8K) と H.264 (スカパープレミアム等)。probe の
// 結果が非対応コーデック(MPEG-2 等)だった場合はソフトデコードへ自動で
// フォールバックし、下の videoStreamInfoCallback で JS に通知する。
std::atomic<bool> webCodecsMode{false};
emscripten::val videoAuCallback = emscripten::val::null();

// probe 完了後に映像ストリーム情報(コーデック/解像度/profile/level/SAR と
// WebCodecs を実際に使うか)を JS へ 1 回通知するコールバック。JS はこれを
// 見て VideoDecoder の構成を決める。通知はメインループで AU の受け渡しより
// 先に行うので、JS は最初の AU が届く前に必ず構成できる。
emscripten::val videoStreamInfoCallback = emscripten::val::null();
struct VideoStreamInfo {
  std::string codecName;
  int width, height;
  int profile, level;
  int sarNum, sarDen;
  bool webCodecs;
};
VideoStreamInfo pendingVideoStreamInfo;
std::mutex videoStreamInfoMtx;
std::atomic<bool> videoStreamInfoPending{false};

// WebCodecs モード用の HEVC アクセスユニットキュー。デマルチプレクスは
// 別スレッド(Worker)で動くため、VideoDecoder(メインスレッド API)を触る
// コールバックはここに積んでおき、メインループ(メインスレッド)で呼び出す。
struct VideoAu {
  double ptsSec;
  bool key;
  std::vector<uint8_t> data;
};
std::deque<VideoAu> videoAuQueue;
std::mutex videoAuMtx;
// キューが溢れて捨てた後、次のキーフレームまでは積まない (videoAuMtx で保護)。
bool videoAuDropUntilKey = false;

// メインループが更新する「現在の推定音声再生時刻(秒)」。JS 側の映像表示を
// これに同期させる (音声クロック)。
double currentAudioPlaybackTime = -1.0;

void setWebCodecsMode(bool enabled) {
  webCodecsMode = enabled;
  spdlog::info("setWebCodecsMode: {}", enabled);
}

void setVideoAuCallback(emscripten::val callback) {
  videoAuCallback = callback;
}

void setVideoStreamInfoCallback(emscripten::val callback) {
  videoStreamInfoCallback = callback;
}

double getAudioPlaybackTime() { return currentAudioPlaybackTime; }

std::string playFileUrl;
std::thread downloaderThread;

std::atomic<bool> resetedDownloader{false};

std::vector<emscripten::val> statsBuffer;

emscripten::val statsCallback = emscripten::val::null();

const size_t donwloadRangeSize = 2 * 1024 * 1024;
size_t downloadCount = 0;

// Callback register
void setCaptionCallback(emscripten::val callback) {
  captionCallback = callback;
}

void setStatsCallback(emscripten::val callback) {
  //
  statsCallback = callback;
}

enum DualMonoMode { MAIN = 0, SUB = 1 };
// JS(メインスレッド)が書き、デマルチプレクススレッドが読むのでアトミック。
std::atomic<int> dualMonoMode{DualMonoMode::MAIN};

// 実際に再生している音声ストリーム (audioStreamList 内の位置)。デマルチプレクサ
// が dualMonoMode から決め、音声デコードスレッドはこれが変わったらデコーダを
// 開き直す。以前は「パケットは選択したストリーム、デコーダと time_base は常に
// [0]」という不整合があり、主/副でストリーム構成が異なる放送では別ストリームの
// パケットを別コンテキストへ送り込んでいた。
std::atomic<int> selectedAudioStreamIndex{0};

// メインループ(decoderMainloop)が参照する値のスナップショット。
//
// AVStream の実体は AVFormatContext のもので、リセット時にデマルチプレクス
// スレッドが avformat_close_input() で解放し audioStreamList も clear() する。
// メインループから audioStreamList や AVStream を直接触ると、
// 「empty() を通った直後に解放される」窓と、vector への無同期アクセスという
// 二重の未定義動作になる。必要な値だけをアトミックに写し取り、メインループは
// そちらだけを見る。
std::atomic<int> currentAudioSampleRate{0};
std::atomic<bool> streamsReady{false};

void setDualMonoMode(int mode) {
  //
  dualMonoMode.store(mode, std::memory_order_relaxed);
}

// 選択中の音声 AVStream。AVFormatContext の寿命内で動くスレッド
// (デマルチプレクス/音声デコード) からのみ呼ぶこと。メインループから呼ぶと
// リセットと競合して解放済みメモリを読む。呼び出し側で audioStreamList が
// 空でないことを確認する。
AVStream *selectedAudioStream() {
  int index = selectedAudioStreamIndex.load(std::memory_order_relaxed);
  if (index < 0 || index >= (int)audioStreamList.size()) {
    index = 0;
  }
  return audioStreamList[index];
}

// Buffer control
emscripten::val getNextInputBuffer(size_t nextSize) {
  std::lock_guard<std::mutex> lock(inputBufferMtx);
  if (inputBufferWriteIndex + nextSize >= MAX_INPUT_BUFFER &&
      inputBufferReadIndex > 0) {
    size_t remainSize = inputBufferWriteIndex - inputBufferReadIndex;
    memmove(&inputBuffer[0], &inputBuffer[inputBufferReadIndex], remainSize);
    inputBufferReadIndex = 0;
    inputBufferWriteIndex = remainSize;
  }
  if (inputBufferWriteIndex + nextSize >= MAX_INPUT_BUFFER) {
    // 入力リングバッファが満杯。JS 側へ null を返して投入を待たせるための
    // 正常なバックプレッシャであり(特にローカルファイル再生では常時満杯に
    // なりやすい)、エラーではないので debug レベルで記録する。
    spdlog::debug("input buffer full (backpressure)");
    return emscripten::val::null();
  }
  auto retVal = emscripten::val(emscripten::typed_memory_view<uint8_t>(
      nextSize, &inputBuffer[inputBufferWriteIndex]));
  waitCv.notify_all();
  return retVal;
}

int read_packet(void *opaque, uint8_t *buf, int bufSize) {
  std::unique_lock<std::mutex> lock(inputBufferMtx);

  if (tlvMode) {
    // ffmpeg 側 (mmttlv デマルチプレクサの resync 処理などで
    // ffio_ensure_seekback を通じて) は状況によって大きめの bufSize を
    // 要求することがある。TS モードと同じく「bufSize 分たまるまで待つ」
    // 実装のままだと、ネットワークから小分けに届く BS4K の高ビットレート
    // データに対してデコーダースレッドが不必要に長くブロックされ、その間
    // 供給側だけが溜まり続けてリングバッファを溢れさせてしまう
    // (コマ送り/Buffer overflow の原因)。AVIOContext の read_packet は
    // 部分読み出し (要求より少ないバイト数を返す) が正式に許容されている
    // ため、TLV モードでは 1 バイトでも届いていればすぐ返す。
    waitCv.wait(lock, [&] {
      return inputBufferWriteIndex > inputBufferReadIndex || resetedDecoder ||
             inputEnded;
    });
    if (resetedDecoder) {
      spdlog::debug("resetedDecoder detected in read_packet");
      return AVERROR_EXIT;
    }
    if (inputBufferWriteIndex <= inputBufferReadIndex) {
      // 終端に達していて、かつ読み切った。
      spdlog::debug("input ended in read_packet (tlv)");
      return AVERROR_EOF;
    }
    // TLV は可変長パケットで 0x47 探索や 188 バイト単位の servicefilter
    // 処理が意味を持たない (むしろデータを破壊する) ため、ffmpeg 側の
    // mmttlv デマルチプレクサに生バイト列をそのまま渡す。
    int copySize = static_cast<int>(std::min<size_t>(
        bufSize, inputBufferWriteIndex - inputBufferReadIndex));
    memcpy(buf, &inputBuffer[inputBufferReadIndex], copySize);
    inputBufferReadIndex += copySize;
    waitCv.notify_all();
    return copySize;
  }

  // 終端に達したら bufSize 分たまるのを待たない。待ち続けると末尾の端数が
  // 永遠に処理されない。
  waitCv.wait(lock, [&] {
    return inputBufferWriteIndex - inputBufferReadIndex >= bufSize ||
           resetedDecoder || inputEnded;
  });
  if (resetedDecoder) {
    spdlog::debug("resetedDecoder detected in read_packet");
    return AVERROR_EXIT;
  }

  // 0x47: TS packet header sync_byte
  // 添字を使う前に必ず範囲を確認する (読み切った位置で配列外を読まないよう
  // 境界チェックを先に置く)。
  while (inputBufferReadIndex < inputBufferWriteIndex &&
         inputBuffer[inputBufferReadIndex] != 0x47) {
    inputBufferReadIndex++;
  }

  // 前回返しきれなかったパケットがあれば消費する
  int copySize = 0;
  if (servicefilterRemain) {
    copySize = bufSize / 188 * 188;
    if (copySize > servicefilterRemain) {
      copySize = servicefilterRemain;
    }
    const auto &packets = servicefilter.GetPackets();
    memcpy(buf, packets.data() + packets.size() - servicefilterRemain,
           copySize);
    servicefilterRemain -= copySize;
    if (!servicefilterRemain) {
      servicefilter.ClearPackets();
    }
  }

  // servicefilterに1パケット（188バイト）だけ入れたからといって、
  // 出てくるのは1パケットとは限らない。色々追加される可能性がある
  while (!servicefilterRemain &&
         inputBufferReadIndex + 188 <= inputBufferWriteIndex) {
    servicefilter.AddPacket(&inputBuffer[inputBufferReadIndex]);
    inputBufferReadIndex += 188;
    const auto &packets = servicefilter.GetPackets();
    servicefilterRemain = static_cast<int>(packets.size());
    if (servicefilterRemain) {
      int addSize = bufSize / 188 * 188 - copySize;
      if (addSize > servicefilterRemain) {
        addSize = servicefilterRemain;
      }
      memcpy(buf + copySize, packets.data(), addSize);
      copySize += addSize;
      servicefilterRemain -= addSize;
      if (!servicefilterRemain) {
        servicefilter.ClearPackets();
      }
    }
  }

  waitCv.notify_all();
  if (copySize == 0) {
    if (inputEnded && inputBufferReadIndex + 188 > inputBufferWriteIndex) {
      // 終端に達していて、もう 1 パケットも取り出せない。
      spdlog::debug("input ended in read_packet (ts)");
      return AVERROR_EOF;
    }
    // servicefilter が何も吐かなかった場合。AVIOContext の read_packet で 0 を
    // 返すと ffmpeg
    // 側が即座に呼び直してビジーループになるため、「今は読めない」 を意味する
    // EAGAIN を返す。
    return AVERROR(EAGAIN);
  }
  return copySize;
}

void setInputEnded() {
  spdlog::info("setInputEnded");
  std::lock_guard<std::mutex> lock(inputBufferMtx);
  inputEnded = true;
  waitCv.notify_all();
}

void commitInputData(size_t nextSize) {
  std::lock_guard<std::mutex> lock(inputBufferMtx);
  inputBufferWriteIndex += nextSize;
  waitCv.notify_all();
  spdlog::debug("commit {} bytes", nextSize);
}

// reset
void resetInternal() {
  downloadCount = 0;
  playFileUrl = std::string("");

  spdlog::info("downloaderThread joinable: {}", downloaderThread.joinable());
  if (downloaderThread.joinable()) {
    spdlog::info("join to downloader thread");
    downloaderThread.join();
    spdlog::info("done.");
  }
  {
    std::lock_guard<std::mutex> lock(inputBufferMtx);
    inputEnded = false;
    // 新しい再生は必ず再生状態から始める。
    paused = false;
    inputBufferReadIndex = 0;
    inputBufferWriteIndex = 0;
    servicefilter.ClearPackets();
    servicefilterRemain = 0;
  }
  {
    std::lock_guard<std::mutex> lock(videoPacketMtx);
    while (!videoPacketQueue.empty()) {
      auto ppacket = videoPacketQueue.front();
      videoPacketQueue.pop_front();
      av_packet_free(&ppacket);
    }
  }
  {
    std::lock_guard<std::mutex> lock(audioPacketMtx);
    while (!audioPacketQueue.empty()) {
      auto ppacket = audioPacketQueue.front();
      audioPacketQueue.pop_front();
      av_packet_free(&ppacket);
    }
  }
  {
    std::lock_guard<std::mutex> lock(videoConvertMtx);
    while (!videoConvertQueue.empty()) {
      auto frame = videoConvertQueue.front();
      videoConvertQueue.pop_front();
      av_frame_free(&frame);
    }
  }
  {
    std::lock_guard<std::mutex> lock(videoAuMtx);
    videoAuQueue.clear();
    videoAuDropUntilKey = false;
  }
  currentAudioPlaybackTime = -1.0;
  {
    std::lock_guard<std::mutex> lock(videoFrameMtx);
    while (!videoFrameQueue.empty()) {
      auto frame = videoFrameQueue.front();
      videoFrameQueue.pop_front();
      av_frame_free(&frame);
    }
  }
  {
    std::lock_guard<std::mutex> lock(audioFrameMtx);
    while (!audioFrameQueue.empty()) {
      auto frame = audioFrameQueue.front();
      audioFrameQueue.pop_front();
      av_frame_free(&frame);
    }
  }
  {
    // 再生切替後に前番組の字幕が排出されないよう、stream を捨てる前に
    // キューも空にする。
    std::lock_guard<std::mutex> lock(captionDataMtx);
    captionDataQueue.clear();
  }
  {
    // 間引き用の直前 TTML も捨てる。JS 側は切替で canvas と直近字幕の
    // キャッシュを消すので、これを持ち越すと「同じ番組に戻ったとき、放送中の
    // TTML が直前と同一内容だと間引かれ、内容が変わるまで字幕が出ない」。
    std::lock_guard<std::mutex> lock(ttmlMtx);
    lastTtml.clear();
    lastTtmlStreamIndex = -1;
  }
  streamsReady = false;
  currentAudioSampleRate = 0;
  videoStream = nullptr;
  audioStreamList.clear();
  captionStream = nullptr;
  captionIsTtml = false;
  videoFrameFound = false;
  {
    std::lock_guard<std::mutex> lock(videoStreamInfoMtx);
    videoStreamInfoPending = false;
  }
}

// reset() の完了フラグ。JS はこれが立つのを待ってから次の再生データを流す。
// 以前は reset() がメインスレッドから resetInternal() を直接呼び、まだ動いて
// いるデコードスレッドと同じ状態を触っていた (JS 側は「たぶん落ち着くだろう」
// という 500ms の待ちで誤魔化していた)。今は片付けそのものをデコードスレッド
// に任せ、終わったことをこのフラグで知らせる。
std::atomic<bool> resetCompleted{true};

bool isResetCompleted() { return resetCompleted.load(); }

void reset() {
  spdlog::debug("reset()");
  resetCompleted = false;
  resetedDecoder = true;
  resetedDownloader = true;
  // read_packet で待っているデコードスレッドを起こす。
  std::lock_guard<std::mutex> lock(inputBufferMtx);
  waitCv.notify_all();
}

void videoDecoderThreadFunc(std::atomic<bool> &terminateFlag) {
  // find decoder
  const AVCodec *videoCodec =
      avcodec_find_decoder(videoStream->codecpar->codec_id);
  if (videoCodec == nullptr) {
    spdlog::error("No supported decoder for Video ...");
    return;
  } else {
    spdlog::debug("Video Decoder created.");
  }

  // Codec Context
  videoCodecContext = avcodec_alloc_context3(videoCodec);
  if (videoCodecContext == nullptr) {
    spdlog::error("avcodec_alloc_context3 for video failed");
    return;
  } else {
    spdlog::debug("avcodec_alloc_context3 for video success.");
  }
  // open codec
  if (avcodec_parameters_to_context(videoCodecContext, videoStream->codecpar) <
      0) {
    spdlog::error("avcodec_parameters_to_context failed");
    avcodec_free_context(&videoCodecContext);
    return;
  }
  // BS4K/8K (HEVC 4K/8K 60p) のソフトウェアデコードはシングルスレッドでは
  // リアルタイムに間に合わず、入力バッファ溢れ・コマ送りの原因になる。
  // フレーム並列デコードを有効化して利用可能な論理コアを使い切る。
  {
    int cores = emscripten_num_logical_cores();
    if (cores < 1) {
      cores = 4;
    }
    // HEVC のフレーム並列デコードはこのコンテンツでは 4 スレッド前後が最適で、
    // それ以上はスレッド間同期のオーバーヘッドでかえって遅くなる (native
    // ベンチで 4 スレッド 102fps に対し 8 スレッド 98fps / 16 スレッド 88fps)。
    // 音声デコード・デマルチプレクス・描画スレッド用の余力も残す。
    int threadCount = std::min(cores, 4);
    if (threadCount < 1) {
      threadCount = 1;
    }
    videoCodecContext->thread_count = threadCount;
    videoCodecContext->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    spdlog::info("video decoder thread_count={} (logical cores={})",
                 threadCount, cores);
  }
  // BS4K (HEVC 4K) のソフトウェアデコードはリアルタイム余裕が薄く、少しの
  // 遅延でフレームバッファが枯渇して映像/音声が途切れる。デコード時間の
  // 2-3割を占めるループフィルター(デブロッキング)を省いて余裕を作る。
  // 画質は多少ブロックノイズが乗るが、リアルタイム再生を優先する。
  videoCodecContext->skip_loop_filter = AVDISCARD_ALL;
  if (avcodec_open2(videoCodecContext, videoCodec, nullptr) != 0) {
    spdlog::error("avcodec_open2 failed");
    avcodec_free_context(&videoCodecContext);
    return;
  }
  spdlog::debug("avcodec for video open success.");

  AVFrame *frame = av_frame_alloc();
  if (frame == nullptr) {
    spdlog::error("av_frame_alloc for video failed");
    avcodec_free_context(&videoCodecContext);
    return;
  }

  while (!terminateFlag) {
    // パイプラインが詰まったら、ここ(映像デコーダー)だけを一時停止する。
    // デマルチプレクスを止めると音声パケット供給まで止まりデッドロックする
    // ため、抑制は映像側に閉じ込める。下流(変換待ちキュー)が溜まっていたら
    // 減るまで待つ。
    while (!terminateFlag) {
      size_t cq;
      {
        std::lock_guard<std::mutex> lock(videoConvertMtx);
        cq = videoConvertQueue.size();
      }
      if (cq <= 8) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(3));
    }
    if (terminateFlag) {
      break;
    }

    AVPacket *ppacket;
    {
      std::unique_lock<std::mutex> lock(videoPacketMtx);
      videoPacketCv.wait(
          lock, [&] { return !videoPacketQueue.empty() || terminateFlag; });
      if (terminateFlag) {
        break;
      }
      ppacket = videoPacketQueue.front();
      videoPacketQueue.pop_front();
    }
    AVPacket &packet = *ppacket;

    int ret = avcodec_send_packet(videoCodecContext, &packet);
    if (ret != 0) {
      spdlog::error("avcodec_send_packet(video) failed: {} {}", ret,
                    av_err2str(ret));
      // return;
    }
    while (avcodec_receive_frame(videoCodecContext, frame) == 0) {
      // spdlog::debug() は関数呼び出しなので、ログレベルに関わらず引数が必ず
      // 評価される。frame->buf[n] は平面数の少ないピクセルフォーマットでは
      // nullptr になり得るため、ダンプ全体をレベル判定で囲う (毎フレームの
      // av_image_get_buffer_size 呼び出しも省ける)。
      if (spdlog::should_log(spdlog::level::debug)) {
        const AVPixFmtDescriptor *desc =
            av_pix_fmt_desc_get((AVPixelFormat)(frame->format));
        int bufferSize = av_image_get_buffer_size(
            (AVPixelFormat)frame->format, frame->width, frame->height, 1);
        spdlog::debug("VideoFrame: {}x{}x{} pixfmt:{} key:{} interlace:{} "
                      "tff:{} codecContext->field_order:?? pts:{} "
                      "stream.timebase:{} bufferSize:{}",
                      frame->width, frame->height, frame->ch_layout.nb_channels,
                      frame->format, frame->flags & AV_FRAME_FLAG_KEY,
                      frame->flags & AV_FRAME_FLAG_INTERLACED,
                      frame->flags & AV_FRAME_FLAG_TOP_FIELD_FIRST, frame->pts,
                      av_q2d(videoStream->time_base), bufferSize);
        if (desc == nullptr) {
          spdlog::debug("desc is NULL");
        } else {
          spdlog::debug(
              "desc name:{} nb_components:{} comp[0].plane:{} .offet:{} "
              "comp[1].plane:{} .offset:{} comp[2].plane:{} .offset:{}",
              desc->name, desc->nb_components, desc->comp[0].plane,
              desc->comp[0].offset, desc->comp[1].plane, desc->comp[1].offset,
              desc->comp[2].plane, desc->comp[2].offset);
        }
        spdlog::debug(
            "buf[0]size:{} buf[1].size:{} buf[2].size:{} buffer_size:{}",
            frameBufSize(frame, 0), frameBufSize(frame, 1),
            frameBufSize(frame, 2), bufferSize);
      }
      frame->time_base.den = videoStream->time_base.den;
      frame->time_base.num = videoStream->time_base.num;

      // 変換 (10bit→8bit) は専用スレッドに任せ、ここでは生フレームの参照を
      // 中間キューへ渡すだけ。これでデコードスレッドは変換に時間を取られず
      // フル速度でデコードでき、変換 (4K swscale) は別スレッドで並列に進む。
      AVFrame *cloneFrame = av_frame_clone(frame);
      {
        std::lock_guard<std::mutex> lock(videoConvertMtx);
        videoConvertQueue.push_back(cloneFrame);
        videoConvertCv.notify_all();
      }
    }
    av_packet_free(&ppacket);
  }

  av_frame_free(&frame);
  spdlog::debug("freeing videoCodecContext");
  avcodec_free_context(&videoCodecContext);
}

// 10bit→8bit 変換専用スレッド。videoConvertQueue から生フレームを取り出し、
// 必要なら 8bit yuv420p に変換して videoFrameQueue へ送る。デコード・描画と
// 並列に動くことで、各段が単独で実時間を維持できる。
void videoConvertThreadFunc(std::atomic<bool> &terminateFlag) {
  // swscale の状態はこのスレッドだけが持つ。以前はグローバルに置いていたため、
  // 変換中に別スレッド(reset())が sws_freeContext して解放済みポインタを
  // 使う可能性があった。
  SwsContext *swsContext = nullptr;
  AVPixelFormat swsSrcFormat = AV_PIX_FMT_NONE;
  int swsWidth = 0, swsHeight = 0;

  while (!terminateFlag) {
    // 下流 (描画待ちの videoFrameQueue) が溜まっていたら抑制する。
    while (!terminateFlag) {
      size_t vq;
      {
        std::lock_guard<std::mutex> lock(videoFrameMtx);
        vq = videoFrameQueue.size();
      }
      if (vq <= 16) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(3));
    }
    if (terminateFlag) {
      break;
    }

    AVFrame *raw = nullptr;
    {
      std::unique_lock<std::mutex> lock(videoConvertMtx);
      videoConvertCv.wait(
          lock, [&] { return !videoConvertQueue.empty() || terminateFlag; });
      if (terminateFlag) {
        break;
      }
      raw = videoConvertQueue.front();
      videoConvertQueue.pop_front();
    }

    AVFrame *outFrame = nullptr;
    if ((AVPixelFormat)raw->format != AV_PIX_FMT_YUV420P) {
      if (swsContext == nullptr || swsSrcFormat != (AVPixelFormat)raw->format ||
          swsWidth != raw->width || swsHeight != raw->height) {
        if (swsContext != nullptr) {
          sws_freeContext(swsContext);
        }
        swsContext =
            sws_getContext(raw->width, raw->height, (AVPixelFormat)raw->format,
                           raw->width, raw->height, AV_PIX_FMT_YUV420P,
                           SWS_POINT, nullptr, nullptr, nullptr);
        swsSrcFormat = (AVPixelFormat)raw->format;
        swsWidth = raw->width;
        swsHeight = raw->height;
      }
      if (swsContext != nullptr) {
        outFrame = av_frame_alloc();
        outFrame->format = AV_PIX_FMT_YUV420P;
        outFrame->width = raw->width;
        outFrame->height = raw->height;
        if (av_frame_get_buffer(outFrame, 0) < 0) {
          spdlog::error("av_frame_get_buffer for conversion failed");
          av_frame_free(&outFrame);
        } else {
          av_frame_copy_props(outFrame, raw);
          sws_scale(swsContext, raw->data, raw->linesize, 0, raw->height,
                    outFrame->data, outFrame->linesize);
        }
      }
    }
    if (outFrame == nullptr) {
      outFrame = av_frame_clone(raw);
    }
    av_frame_free(&raw);

    {
      std::lock_guard<std::mutex> lock(videoFrameMtx);
      videoFrameFound = true;
      videoFrameQueue.push_back(outFrame);
    }
  }

  if (swsContext != nullptr) {
    sws_freeContext(swsContext);
  }
}

// 指定した音声ストリーム用にデコーダを開き直す。主/副の切替時に呼ぶ。
static bool openAudioDecoder(AVStream *stream) {
  if (audioCodecContext != nullptr) {
    avcodec_free_context(&audioCodecContext);
  }
  const AVCodec *audioCodec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (audioCodec == nullptr) {
    spdlog::error("No supported decoder for Audio ...");
    return false;
  }
  audioCodecContext = avcodec_alloc_context3(audioCodec);
  if (audioCodecContext == nullptr) {
    spdlog::error("avcodec_alloc_context3 for audio failed");
    return false;
  }
  if (avcodec_parameters_to_context(audioCodecContext, stream->codecpar) < 0) {
    spdlog::error("avcodec_parameters_to_context failed");
    avcodec_free_context(&audioCodecContext);
    return false;
  }
  if (avcodec_open2(audioCodecContext, audioCodec, nullptr) != 0) {
    spdlog::error("avcodec_open2 failed");
    avcodec_free_context(&audioCodecContext);
    return false;
  }
  currentAudioSampleRate.store(stream->codecpar->sample_rate,
                               std::memory_order_relaxed);
  spdlog::info("audio decoder opened for stream index:{} codec:{} ch:{} "
               "sample_rate:{}",
               stream->index, avcodec_get_name(stream->codecpar->codec_id),
               stream->codecpar->ch_layout.nb_channels,
               stream->codecpar->sample_rate);
  return true;
}

void audioDecoderThreadFunc(std::atomic<bool> &terminateFlag) {
  int openedIndex = selectedAudioStreamIndex.load(std::memory_order_relaxed);
  AVStream *openedStream = selectedAudioStream();
  if (!openAudioDecoder(openedStream)) {
    return;
  }

  AVFrame *frame = av_frame_alloc();
  if (frame == nullptr) {
    spdlog::error("av_frame_alloc for audio failed");
    avcodec_free_context(&audioCodecContext);
    return;
  }

  while (!terminateFlag) {
    // 主/副が切り替わったらそのストリーム用にデコーダを開き直す。積んである
    // 旧ストリームのパケットは別コンテキスト向けなので捨てる。
    int wantIndex = selectedAudioStreamIndex.load(std::memory_order_relaxed);
    if (wantIndex != openedIndex) {
      {
        std::lock_guard<std::mutex> lock(audioPacketMtx);
        while (!audioPacketQueue.empty()) {
          auto stale = audioPacketQueue.front();
          audioPacketQueue.pop_front();
          av_packet_free(&stale);
        }
      }
      openedIndex = wantIndex;
      openedStream = selectedAudioStream();
      if (!openAudioDecoder(openedStream)) {
        break;
      }
    }

    AVPacket *ppacket;
    {
      std::unique_lock<std::mutex> lock(audioPacketMtx);
      audioPacketCv.wait(
          lock, [&] { return !audioPacketQueue.empty() || terminateFlag; });
      if (terminateFlag) {
        break;
      }
      ppacket = audioPacketQueue.front();
      audioPacketQueue.pop_front();
    }
    AVPacket &packet = *ppacket;

    int ret = avcodec_send_packet(audioCodecContext, &packet);
    if (ret != 0) {
      spdlog::error("avcodec_send_packet(audio) failed: {} {}", ret,
                    av_err2str(ret));
      // return;
    }
    while (avcodec_receive_frame(audioCodecContext, frame) == 0) {
      // buf[1] はモノラル(=1プレーン)やパック形式では nullptr。引数は常に
      // 評価されるので frameBufSize() 経由で参照する。
      spdlog::debug("AudioFrame: format:{} pts:{} frame timebase:{} stream "
                    "timebase:{} buf[0].size:{} buf[1].size:{} nb_samples:{} "
                    "ch:{}",
                    frame->format, frame->pts, av_q2d(frame->time_base),
                    av_q2d(openedStream->time_base), frameBufSize(frame, 0),
                    frameBufSize(frame, 1), frame->nb_samples,
                    frame->ch_layout.nb_channels);
      frame->time_base = openedStream->time_base;
      // 通常は最初の映像フレームが出るまで音声を積まない(起動時 A/V 同期)。
      // WebCodecs モードは映像を JS 側でデコードするため videoFrameFound が
      // 立たない。この場合は音声がクロックの基準になるので、映像を待たずに
      // 積む。
      if (videoFrameFound || webCodecsMode) {
        AVFrame *cloneFrame = av_frame_clone(frame);
        std::lock_guard<std::mutex> lock(audioFrameMtx);
        audioFrameQueue.push_back(cloneFrame);
      }
    }
    av_packet_free(&ppacket);
  }
  av_frame_free(&frame);
  spdlog::debug("freeing audioCodecContext");
  if (audioCodecContext != nullptr) {
    avcodec_free_context(&audioCodecContext);
  }
}

// decoder
void decoderThreadFunc() {
  spdlog::info("Decoder Thread started.");
  // 前回の再生の後片付け。reset() を呼んだ JS はこれが終わるのを待っている。
  resetInternal();
  resetCompleted = true;
  AVFormatContext *formatContext = nullptr;
  AVIOContext *avioContext = nullptr;
  uint8_t *ibuf = nullptr;
  size_t ibufSize = 64 * 1024;

  // probe 失敗などの途中終了でも ffmpeg のコンテキストを取りこぼさない。
  // decoderThreadFunc() は initDecoder() のループから繰り返し呼ばれるので、
  // 1 回あたりの取りこぼしがそのまま累積する。
  auto releaseContexts = [&]() {
    if (formatContext != nullptr) {
      avformat_close_input(&formatContext);
    }
    if (avioContext != nullptr) {
      // ffmpeg がバッファを付け替えている場合があるので avioContext が今
      // 持っているものを解放する (元の ibuf ではなく)。
      av_freep(&avioContext->buffer);
      avio_context_free(&avioContext);
    }
  };

  // probe phase
  {
    // probe
    if (ibuf == nullptr) {
      ibuf = static_cast<uint8_t *>(av_malloc(ibufSize));
    }
    if (avioContext == nullptr) {
      avioContext = avio_alloc_context(ibuf, ibufSize, 0, 0, &read_packet,
                                       nullptr, nullptr);
    }
    if (formatContext == nullptr) {
      formatContext = avformat_alloc_context();
      formatContext->pb = avioContext;
      spdlog::debug("calling avformat_open_input");

      if (avformat_open_input(&formatContext, nullptr, nullptr, nullptr) != 0) {
        spdlog::error("avformat_open_input error");
        releaseContexts();
        return;
      }
      spdlog::debug("open success");
      formatContext->probesize = PROBE_SIZE;
    }

    if (avformat_find_stream_info(formatContext, nullptr) < 0) {
      spdlog::error("avformat_find_stream_info error");
      releaseContexts();
      return;
    }
    spdlog::debug("avformat_find_stream_info success");
    spdlog::debug("nb_streams:{}", formatContext->nb_streams);

    // find video/audio/caption stream
    for (int i = 0; i < (int)formatContext->nb_streams; ++i) {
      spdlog::debug(
          "stream[{}]: tag:{:x} codecName:{} video_delay:{} "
          "dim:{}x{}",
          i, formatContext->streams[i]->codecpar->codec_tag,
          avcodec_get_name(formatContext->streams[i]->codecpar->codec_id),
          formatContext->streams[i]->codecpar->video_delay,
          formatContext->streams[i]->codecpar->width,
          formatContext->streams[i]->codecpar->height);

      if (formatContext->streams[i]->codecpar->codec_type ==
              AVMEDIA_TYPE_VIDEO &&
          videoStream == nullptr) {
        videoStream = formatContext->streams[i];
      }
      if (formatContext->streams[i]->codecpar->codec_type ==
          AVMEDIA_TYPE_AUDIO) {
        audioStreamList.push_back(formatContext->streams[i]);
      }
      if (formatContext->streams[i]->codecpar->codec_type ==
              AVMEDIA_TYPE_SUBTITLE &&
          (formatContext->streams[i]->codecpar->codec_id ==
               AV_CODEC_ID_ARIB_CAPTION ||
           formatContext->streams[i]->codecpar->codec_id == AV_CODEC_ID_TTML) &&
          captionStream == nullptr) {
        captionStream = formatContext->streams[i];
        captionIsTtml =
            formatContext->streams[i]->codecpar->codec_id == AV_CODEC_ID_TTML;
      }
    }
    if (videoStream == nullptr) {
      spdlog::error("No video stream ...");
      releaseContexts();
      return;
    }
    if (audioStreamList.empty()) {
      spdlog::error("No audio stream ...");
      releaseContexts();
      return;
    }
    spdlog::info("Found video stream index:{} codec:{} dim:{}x{} "
                 "colorspace:{} colorrange:{} delay:{}",
                 videoStream->index,
                 avcodec_get_name(videoStream->codecpar->codec_id),
                 videoStream->codecpar->width, videoStream->codecpar->height,
                 av_color_space_name(videoStream->codecpar->color_space),
                 av_color_range_name(videoStream->codecpar->color_range),
                 videoStream->codecpar->video_delay);
    for (auto &&audioStream : audioStreamList) {
      spdlog::info("Found audio stream index:{} codecID:{} channels:{} "
                   "sample_rate:{}",
                   audioStream->index,
                   avcodec_get_name(audioStream->codecpar->codec_id),
                   audioStream->codecpar->ch_layout.nb_channels,
                   audioStream->codecpar->sample_rate);
    }

    if (captionStream) {
      spdlog::info("Found caption stream index:{} codecID:{} ttml:{}",
                   captionStream->index,
                   avcodec_get_name(captionStream->codecpar->codec_id),
                   captionIsTtml);
    }

    // WebCodecs を使うのは HEVC (BS4K/8K) と「プログレッシブの」H.264 のみ。
    //  - MPEG-2 (地デジ/BS 2K) はブラウザの WebCodecs が非対応。
    //  - 放送の 1080i H.264 (スカパープレミアム等) は、Chrome のハードウェア
    //    デコーダがインターレースを受け付けず(Decoding error)、ソフトウェア
    //    指定でもフィールド対の扱いで出力が得られない。WASM ソフトデコード
    //    なら WebGPU の yadif デインターレースも効くため、そちらへ回す。
    // 判定はスレッド起動前に行うため、以降の挙動は最初から
    // webCodecsMode=false と同じになる。
    if (webCodecsMode) {
      bool h264Progressive =
          videoStream->codecpar->codec_id == AV_CODEC_ID_H264 &&
          videoStream->codecpar->field_order == AV_FIELD_PROGRESSIVE;
      bool supported = videoStream->codecpar->codec_id == AV_CODEC_ID_HEVC ||
                       h264Progressive;
      if (!supported) {
        spdlog::info("WebCodecs unsupported for codec {} field_order {}. "
                     "fallback to software decode.",
                     avcodec_get_name(videoStream->codecpar->codec_id),
                     (int)videoStream->codecpar->field_order);
        webCodecsMode = false;
      }
    }
    // JS へ通知する映像ストリーム情報を積む(メインループが1回だけ届ける)。
    {
      std::lock_guard<std::mutex> lock(videoStreamInfoMtx);
      pendingVideoStreamInfo.codecName =
          avcodec_get_name(videoStream->codecpar->codec_id);
      pendingVideoStreamInfo.width = videoStream->codecpar->width;
      pendingVideoStreamInfo.height = videoStream->codecpar->height;
      pendingVideoStreamInfo.profile = videoStream->codecpar->profile;
      pendingVideoStreamInfo.level = videoStream->codecpar->level;
      pendingVideoStreamInfo.sarNum =
          videoStream->codecpar->sample_aspect_ratio.num;
      pendingVideoStreamInfo.sarDen =
          videoStream->codecpar->sample_aspect_ratio.den;
      pendingVideoStreamInfo.webCodecs = webCodecsMode;
      videoStreamInfoPending = true;
    }

    // 主/副の選択を新しいストリーム構成に合わせ直し、メインループが見る値を
    // 確定させる。ここから先、メインループは AVStream を触らずに済む。
    selectedAudioStreamIndex.store(
        dualMonoMode.load(std::memory_order_relaxed) %
            (int)audioStreamList.size(),
        std::memory_order_relaxed);
    currentAudioSampleRate.store(selectedAudioStream()->codecpar->sample_rate,
                                 std::memory_order_relaxed);
    streamsReady = true;
  }

  std::atomic<bool> videoTerminateFlag{false};
  std::atomic<bool> audioTerminateFlag{false};
  std::atomic<bool> convertTerminateFlag{false};
  // WebCodecs モードでは映像は JS 側でデコードするので、WASM の映像デコード/
  // 変換スレッドは起動しない。音声スレッドは共通で起動する。
  std::thread videoDecoderThread;
  std::thread videoConvertThread;
  if (!webCodecsMode) {
    videoDecoderThread =
        std::thread([&]() { videoDecoderThreadFunc(videoTerminateFlag); });
    videoConvertThread =
        std::thread([&]() { videoConvertThreadFunc(convertTerminateFlag); });
  }
  std::thread audioDecoderThread =
      std::thread([&]() { audioDecoderThreadFunc(audioTerminateFlag); });

  // decode phase
  bool eofReported = false;
  while (!resetedDecoder) {
    // デマルチプレクスの読み進み制御 (throttle)。
    //
    // 実時間ペーシングは「音声再生バッファ (bufferedAudioSamples)」で行う。
    // これは AudioWorklet が実時間で消費 (再生) するので、これが十分たまる
    // まで読み進め、たまったら止める、を繰り返すことでパイプライン全体が
    // 実時間に律速される。音声はバッファから再生され続けて減るのでデッド
    // ロックせず、供給過多による A/V ドリフトも起きない。
    //  - videoFrameQueue で律速すると、映像が速く溜まった時にデマルチプレ
    //    クスが止まり音声パケット供給まで止まってフリーズする (過去の不具合)。
    //  - パケット枚数だけで律速すると、音声先行でバッファが膨らみドリフト
    //    する (過去の不具合)。
    // パケットキューの上限は暴走防止の安全弁として高めに残す。
    const int audioBufferTarget = 48000; // 約1秒 @48kHz
    size_t videoPacketQueueSize;
    size_t audioPacketQueueSize;
    {
      std::lock_guard<std::mutex> lock(videoPacketMtx);
      videoPacketQueueSize = videoPacketQueue.size();
    }
    {
      std::lock_guard<std::mutex> lock(audioPacketMtx);
      audioPacketQueueSize = audioPacketQueue.size();
    }
    if (bufferedAudioSamples.load(std::memory_order_relaxed) >
            audioBufferTarget ||
        videoPacketQueueSize > 600 || audioPacketQueueSize > 600) {
      std::this_thread::sleep_for(std::chrono::milliseconds(3));
      continue;
    }
    AVPacket *ppacket = av_packet_alloc();
    int ret = av_read_frame(formatContext, ppacket);
    if (ret != 0) {
      // 終端に達した後は同じログを出し続けないよう 1 回だけ記録する。
      if (ret != AVERROR_EOF || !eofReported) {
        spdlog::info("av_read_frame: {} {}", ret, av_err2str(ret));
        eofReported = eofReported || ret == AVERROR_EOF;
      }
      // 失敗しても確保済みパケットは必ず解放する (解放漏れのままリトライすると
      // 読み出しエラーが続く間ずっとリークし続ける)。
      av_packet_free(&ppacket);
      // エラーが続くときに CPU を食い潰さないよう少し待つ。終端に達した場合は
      // ここでスレッドを畳まない。畳むと次の周回の resetInternal() が、まだ
      // 再生していないキューのフレームまで捨ててしまう。デコード済みぶんを
      // 鳴らし切れるよう、そのまま待機して reset() を待つ。
      std::this_thread::sleep_for(
          std::chrono::milliseconds(ret == AVERROR_EOF ? 100 : 3));
      continue;
    }
    if (ppacket->stream_index == videoStream->index) {
      if (webCodecsMode) {
        // WebCodecs モード: HEVC アクセスユニット(mmttlv が Annex-B 形式で
        // 出力済み)をキューへ積む。実際に JS の VideoDecoder へ渡すのは
        // メインループ(メインスレッド)。
        VideoAu au;
        au.ptsSec = (ppacket->pts == AV_NOPTS_VALUE)
                        ? -1.0
                        : ppacket->pts * av_q2d(videoStream->time_base);
        au.key = (ppacket->flags & AV_PKT_FLAG_KEY) != 0;
        au.data.assign(ppacket->data, ppacket->data + ppacket->size);
        {
          std::lock_guard<std::mutex> lock(videoAuMtx);
          // 供給過多で暴走しないよう上限を設ける。ただし GOP の途中の AU を
          // 抜くと次のキーフレームまで映像が壊れるので、1個ずつ古いものを
          // 捨てるのではなく、まとめて捨てて次のキーフレームから作り直す。
          if (videoAuQueue.size() >= 300) {
            spdlog::warn("videoAuQueue overflow: drop {} AUs and resync at the "
                         "next key frame",
                         videoAuQueue.size());
            videoAuQueue.clear();
            videoAuDropUntilKey = true;
          }
          if (videoAuDropUntilKey && au.key) {
            videoAuDropUntilKey = false;
          }
          if (!videoAuDropUntilKey) {
            videoAuQueue.push_back(std::move(au));
          }
        }
      } else {
        AVPacket *clonePacket = av_packet_clone(ppacket);
        {
          std::lock_guard<std::mutex> lock(videoPacketMtx);
          videoPacketQueue.push_back(clonePacket);
          videoPacketCv.notify_all();
        }
      }
    }
    if (!audioStreamList.empty()) {
      // 主/副の選択を音声デコードスレッドへ伝える (向こうで開き直す)。
      int wantIndex = dualMonoMode.load(std::memory_order_relaxed) %
                      (int)audioStreamList.size();
      if (wantIndex !=
          selectedAudioStreamIndex.load(std::memory_order_relaxed)) {
        spdlog::info("audio stream select: {} -> {}",
                     selectedAudioStreamIndex.load(std::memory_order_relaxed),
                     wantIndex);
        selectedAudioStreamIndex.store(wantIndex, std::memory_order_relaxed);
      }
    }
    if (!audioStreamList.empty() &&
        ppacket->stream_index == selectedAudioStream()->index) {
      AVPacket *clonePacket = av_packet_clone(ppacket);
      {
        std::lock_guard<std::mutex> lock(audioPacketMtx);
        audioPacketQueue.push_back(clonePacket);
        audioPacketCv.notify_all();
      }
    }
    // [解][字] など複数の字幕アセットを持つ放送では、開始時のストリーム走査で
    // 最初に見つかる字幕ストリームが実データを運ばず(後から別の字幕ストリームが
    // 出現しそちらに字幕が流れる)、固定選択だと字幕が出ない。到着パケットの
    // codec
    // で字幕を判定し、実際に届いたストリームを字幕として扱う(必要なら乗り換える)。
    AVStream *pktCapStream = formatContext->streams[ppacket->stream_index];
    bool pktIsCaption =
        pktCapStream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE &&
        (pktCapStream->codecpar->codec_id == AV_CODEC_ID_ARIB_CAPTION ||
         pktCapStream->codecpar->codec_id == AV_CODEC_ID_TTML);
    if (pktIsCaption) {
      bool pktIsTtml = pktCapStream->codecpar->codec_id == AV_CODEC_ID_TTML;
      if (captionStream != pktCapStream) {
        // 同じ stream index に戻るケースも含め、アセット乗り換え後の最初の
        // TTML は必ず JS へ届ける。
        {
          std::lock_guard<std::mutex> lock(ttmlMtx);
          lastTtml.clear();
          lastTtmlStreamIndex = -1;
        }
        captionStream = pktCapStream;
        captionIsTtml = pktIsTtml;
        spdlog::info("Caption stream -> index:{} codec:{}", pktCapStream->index,
                     avcodec_get_name(pktCapStream->codecpar->codec_id));
      }
      if (pktIsTtml) {
        // 4K/8K の ARIB-TTML 字幕。PTS を持たない(AV_NOPTS_VALUE)ため 0 を
        // 積み、表示タイミングは当面 JS 側で到着時に描画する(精密な
        // begin/end 同期は後段で対応)。放送は同一 TTML を繰り返し送るので
        // 直前と同一のものは間引く。
        std::string ttml(reinterpret_cast<const char *>(ppacket->data),
                         ppacket->size);
        bool changed = false;
        {
          std::lock_guard<std::mutex> lock(ttmlMtx);
          // 同じ本文でも字幕アセットが変われば、JS 側へ streamIndex を通知して
          // 時刻オフセットを再校正する必要がある。
          if (ttml != lastTtml || pktCapStream->index != lastTtmlStreamIndex) {
            lastTtml = ttml;
            lastTtmlStreamIndex = pktCapStream->index;
            changed = true;
          }
        }
        if (changed && !captionCallback.isNull()) {
          std::vector<uint8_t> buffer(ppacket->data,
                                      ppacket->data + ppacket->size);
          std::lock_guard<std::mutex> lock(captionDataMtx);
          captionDataQueue.push_back(CaptionData{0, pktCapStream->index,
                                                 pktCapStream->time_base, true,
                                                 std::move(buffer)});
        }
      } else {
        // 16進ダンプの生成は debug 出力時だけに限定する (毎字幕パケットで
        // 文字列を組み立てるとログレベルに関わらずコストがかかる)。空パケット
        // では data[0] を参照しない。
        if (spdlog::should_log(spdlog::level::debug)) {
          std::string str;
          for (int i = 0; i < ppacket->size; i++) {
            if (i > 0) {
              str += ' ';
            }
            str += fmt::format("{:02x}", ppacket->data[i]);
          }
          spdlog::debug("CaptionPacket received. size: {} data: [{}]",
                        ppacket->size, str);
        }
        if (ppacket->size > 0 && !captionCallback.isNull()) {
          std::vector<uint8_t> buffer(ppacket->data,
                                      ppacket->data + ppacket->size);
          {
            std::lock_guard<std::mutex> lock(captionDataMtx);
            captionDataQueue.push_back(
                CaptionData{ppacket->pts, pktCapStream->index,
                            pktCapStream->time_base, false, std::move(buffer)});
          }
        }
      }
    }
    av_packet_free(&ppacket);
  }

  spdlog::debug("decoderThreadFunc breaked.");

  {
    std::lock_guard<std::mutex> lock(videoPacketMtx);
    videoTerminateFlag = true;
    videoPacketCv.notify_all();
  }
  {
    std::lock_guard<std::mutex> lock(videoConvertMtx);
    convertTerminateFlag = true;
    videoConvertCv.notify_all();
  }
  {
    std::lock_guard<std::mutex> lock(audioPacketMtx);
    audioTerminateFlag = true;
    audioPacketCv.notify_all();
  }
  spdlog::debug("join to videoDecoderThread");
  if (videoDecoderThread.joinable()) {
    videoDecoderThread.join();
  }
  spdlog::debug("join to videoConvertThread");
  if (videoConvertThread.joinable()) {
    videoConvertThread.join();
  }
  spdlog::debug("join to audioDecoderThread");
  audioDecoderThread.join();

  spdlog::debug("freeing avformat/avio context");
  releaseContexts();

  spdlog::debug("decoderThreadFunc end.");
}

std::thread decoderThread;

// FFmpeg のログを spdlog 経由(=stdout)に集約する。既定の av_log は stderr へ
// 出力され、ブラウザのコンソールでは全て赤いエラー扱いになるため、ARIB の
// 5.1ch AAC が毎フレーム吐く "audio config changed" などが大量のエラーに
// 見えてしまう。レベルを spdlog にマッピングしつつ、直前と同一のメッセージは
// 間引いてノイズを抑える。
static void tsLiveAvLogCallback(void *avcl, int level, const char *fmt,
                                va_list vl) {
  if (level > av_log_get_level()) {
    return;
  }
  char line[1024];
  int printPrefix = 1;
  int ret = av_log_format_line2(avcl, level, fmt, vl, line, sizeof(line),
                                &printPrefix);
  if (ret <= 0) {
    return;
  }
  // 末尾の改行を除去
  size_t len = strlen(line);
  while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
    line[--len] = '\0';
  }
  if (len == 0) {
    return;
  }

  // 毎フレーム繰り返される同一メッセージ(例: aac_latm の "audio config
  // changed")を間引く。連続で同一の場合は 500 回に 1 回だけ出力する。
  static std::mutex logMtx;
  static std::string lastLine;
  static long repeatCount = 0;
  {
    std::lock_guard<std::mutex> lock(logMtx);
    if (lastLine == line) {
      if (++repeatCount % 500 != 0) {
        return;
      }
    } else {
      lastLine = line;
      repeatCount = 0;
    }
  }

  switch (level) {
  case AV_LOG_PANIC:
  case AV_LOG_FATAL:
    spdlog::critical("[ffmpeg] {}", line);
    break;
  case AV_LOG_ERROR:
    // stderr の赤エラー表示を避けるため warning に格下げして出す。
    spdlog::warn("[ffmpeg] {}", line);
    break;
  case AV_LOG_WARNING:
    spdlog::warn("[ffmpeg] {}", line);
    break;
  case AV_LOG_INFO:
    spdlog::info("[ffmpeg] {}", line);
    break;
  default:
    spdlog::debug("[ffmpeg] {}", line);
    break;
  }
}

void initDecoder() {
  // FFmpeg ログを spdlog に集約(コンソールの赤エラー抑制 + 繰り返し間引き)
  av_log_set_callback(tsLiveAvLogCallback);

  // デコーダスレッド起動
  spdlog::info("Starting decoder thread.");
  decoderThread = std::thread([]() {
    while (true) {
      resetedDecoder = false;
      decoderThreadFunc();
      // probe に失敗した場合 decoderThreadFunc() は即座に戻る。そのまま回すと
      // CPU を食い潰すので少し待ってから再挑戦する。
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  });

  servicefilter.SetProgramNumberOrIndex(-1);
  servicefilter.SetAudio1Mode(13);
  servicefilter.SetAudio2Mode(7);
  servicefilter.SetCaptionMode(1);
  servicefilter.SetSuperimposeMode(2);
}

SwrContext *swr = nullptr;
uint8_t *swrOutput[2] = {nullptr, nullptr};
int swrOutputSize = 0;
int channel_layout = 0;
int sample_rate = 0;
// swr を構成したときの入力サンプル形式。以前は FLTP 決め打ちで、実際の
// frame->format と食い違うと変換結果が壊れていた。
AVSampleFormat swrInputFormat = AV_SAMPLE_FMT_NONE;

// 現在再生中の音声 PTS(秒)の推定値。AudioWorklet に積まれている未再生ぶんを
// フレームの PTS から引く。sample_rate が取れないときはフレームの PTS をその
// まま返す (0除算回避)。
static double estimateAudioPlayTime(const AVFrame *audioFrame,
                                    int bufferedSamples) {
  double audioPtsTime = audioFrame->pts * av_q2d(audioFrame->time_base);
  int sampleRate = currentAudioSampleRate.load(std::memory_order_relaxed);
  if (sampleRate <= 0) {
    return audioPtsTime;
  }
  return audioPtsTime - (double)bufferedSamples / sampleRate;
}

void decoderMainloop() {
  const int currentBufferedAudioSamples =
      bufferedAudioSamples.load(std::memory_order_relaxed);
  size_t videoFrameQueueSize;
  size_t audioFrameQueueSize;
  size_t videoPacketQueueSize;
  size_t audioPacketQueueSize;
  {
    std::lock_guard<std::mutex> lock(videoFrameMtx);
    videoFrameQueueSize = videoFrameQueue.size();
  }
  {
    std::lock_guard<std::mutex> lock(audioFrameMtx);
    audioFrameQueueSize = audioFrameQueue.size();
  }
  {
    std::lock_guard<std::mutex> lock(videoPacketMtx);
    videoPacketQueueSize = videoPacketQueue.size();
  }
  {
    std::lock_guard<std::mutex> lock(audioPacketMtx);
    audioPacketQueueSize = audioPacketQueue.size();
  }
  spdlog::debug("decoderMainloop videoFrameQueue:{} audioFrameQueue:{} "
                "videoPacketQueue:{} audioPacketQueue:{}",
                videoFrameQueueSize, audioFrameQueueSize, videoPacketQueueSize,
                audioPacketQueueSize);

  // probe 済みの映像ストリーム情報を JS へ通知する(1回)。JS はこれを見て
  // VideoDecoder を構成するため、下の AU 受け渡しより必ず先に届ける。
  if (videoStreamInfoPending && !videoStreamInfoCallback.isNull()) {
    VideoStreamInfo info;
    bool deliver = false;
    {
      std::lock_guard<std::mutex> lock(videoStreamInfoMtx);
      // 取り出しと同時にフラグを降ろす (降ろせなければ既に配信済み)。
      deliver = videoStreamInfoPending.exchange(false);
      info = pendingVideoStreamInfo;
    }
    if (deliver) {
      auto obj = emscripten::val::object();
      obj.set("codec", info.codecName);
      obj.set("width", info.width);
      obj.set("height", info.height);
      obj.set("profile", info.profile);
      obj.set("level", info.level);
      obj.set("sarNum", info.sarNum);
      obj.set("sarDen", info.sarDen);
      obj.set("webCodecs", info.webCodecs);
      videoStreamInfoCallback(obj);
    }
  }

  // 一時停止中は、映像の取り出し・描画も、字幕の排出も、AudioWorklet への
  // 音声供給も行わない。音声が供給されない = 再生時刻が進まないので、映像は
  // 現在のフレームで止まる。デマルチプレクス/デコードは各キューの上限に当たって
  // 自然に停止し、解除すれば続きから再開する。
  if (paused) {
    return;
  }

  // WebCodecs モード: 溜まったアクセスユニット(HEVC/H.264)を JS の
  // VideoDecoder へ渡す。ここはメインスレッドなので VideoDecoder を安全に
  // 触れる。
  if (webCodecsMode && !videoAuCallback.isNull()) {
    for (;;) {
      VideoAu au;
      {
        std::lock_guard<std::mutex> lock(videoAuMtx);
        if (videoAuQueue.empty()) {
          break;
        }
        au = std::move(videoAuQueue.front());
        videoAuQueue.pop_front();
      }
      emscripten::val data(emscripten::typed_memory_view<uint8_t>(
          au.data.size(), au.data.data()));
      videoAuCallback(data, au.ptsSec, au.key);
    }
  }

  if (streamsReady && !statsCallback.isNull()) {
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now() - startTime);
    auto data = emscripten::val::object();
    data.set("time", duration.count() / 1000.0);
    data.set("VideoFrameQueueSize", videoFrameQueueSize);
    data.set("AudioFrameQueueSize", audioFrameQueueSize);
    data.set("AudioWorkletBufferSize", currentBufferedAudioSamples);
    size_t inputBufferSize;
    {
      std::lock_guard<std::mutex> lock(inputBufferMtx);
      inputBufferSize = inputBufferWriteIndex - inputBufferReadIndex;
    }
    data.set("InputBufferSize", inputBufferSize / 1000000.0);
    size_t captionDataQueueSize;
    {
      std::lock_guard<std::mutex> lock(captionDataMtx);
      captionDataQueueSize = captionDataQueue.size();
    }
    data.set("CaptionDataQueueSize", captionDataQueueSize);
    statsBuffer.push_back(std::move(data));
    if (statsBuffer.size() >= 6) {
      auto statsArray = emscripten::val::array();
      for (int i = 0; i < statsBuffer.size(); i++) {
        statsArray.set(i, statsBuffer[i]);
      }
      statsBuffer.clear();
      statsCallback(statsArray);
    }
  }

  // time_base が 0/0 な不正フレームが入ってたら捨てる
  AVFrame *currentFrame = nullptr;
  {
    std::lock_guard<std::mutex> lock(videoFrameMtx);
    while (!videoFrameQueue.empty()) {
      AVFrame *frame = videoFrameQueue.front();
      if (frame->time_base.den == 0 || frame->time_base.num == 0) {
        videoFrameQueue.pop_front();
        av_frame_free(&frame);
      } else {
        currentFrame = frame;
        break;
      }
    }
  }
  AVFrame *audioFrame = nullptr;
  {
    std::lock_guard<std::mutex> lock(audioFrameMtx);
    while (!audioFrameQueue.empty()) {
      AVFrame *frame = audioFrameQueue.front();
      if (frame->time_base.den == 0 || frame->time_base.num == 0) {
        audioFrameQueue.pop_front();
        av_frame_free(&frame);
      } else {
        audioFrame = frame;
        break;
      }
    }
  }

  // 音声クロック(推定再生時刻)を映像の有無に依らず更新する。WebCodecs モード
  // では映像フレームが videoFrameQueue に来ない(JS 側でデコード)ため、ここで
  // 独立に計算しておき、JS の映像表示同期に使わせる。
  if (audioFrame &&
      currentAudioSampleRate.load(std::memory_order_relaxed) > 0) {
    currentAudioPlaybackTime =
        estimateAudioPlayTime(audioFrame, currentBufferedAudioSamples);
  }

  if (currentFrame && audioFrame) {
    // 次のVideoFrameをまずは見る（条件を満たせばpopする）
    // AudioFrameは完全に見るだけ
    // spdlog::info("found Current Frame {}x{} bufferSize:{}",
    // currentFrame->width,
    //              currentFrame->height, bufferSize);
    size_t queuedAudioFrames;
    {
      std::lock_guard<std::mutex> lock(audioFrameMtx);
      queuedAudioFrames = audioFrameQueue.size();
    }
    spdlog::debug(
        "VideoFrame@mainloop pts:{} time_base:{} {}/{} AudioQueueSize:{}",
        currentFrame->pts, av_q2d(currentFrame->time_base),
        currentFrame->time_base.num, currentFrame->time_base.den,
        queuedAudioFrames);

    // WindowSize確認＆リサイズ
    // TODO:
    // if (ww != videoStream->codecpar->width ||
    //     wh != videoStream->codecpar->height) {
    //   set_style(videoStream->codecpar->width);
    // }

    // 上記から推定される、現在再生している音声のPTS（時間）
    double estimatedAudioPlayTime =
        estimateAudioPlayTime(audioFrame, currentBufferedAudioSamples);

    // 再生時刻を過ぎたフレームはまとめて取り出し、最後の 1 枚だけを描画して
    // 残りは捨てる。1 回の呼び出しで 1 枚しか進めないと、メインループが遅く
    // なった間に溜まったフレームを「1枚/呼び出し」で消化することになり、映像が
    // 早送りで音声に追いつく動きになる。
    //
    // 特にタブが非表示の間は、fps 指定のメインループが setTimeout で回るため
    // ブラウザに約 1Hz まで絞られる (音声は AudioWorklet
    // 側で実時間のまま進む)。
    // 表示に戻した瞬間に数百フレームの遅れが生じているので、ここで捨てないと
    // 目に見える早送りになる。
    AVFrame *frameToShow = nullptr;
    int droppedFrames = 0;
    {
      std::lock_guard<std::mutex> lock(videoFrameMtx);
      while (!videoFrameQueue.empty()) {
        AVFrame *head = videoFrameQueue.front();
        if (head->time_base.den == 0 || head->time_base.num == 0) {
          videoFrameQueue.pop_front();
          av_frame_free(&head);
          continue;
        }
        // まだ再生時刻に達していないフレームはキューに残す。
        if (head->pts * av_q2d(head->time_base) >= estimatedAudioPlayTime) {
          break;
        }
        videoFrameQueue.pop_front();
        if (frameToShow != nullptr) {
          // 一つ前に取り出したものは既に表示時刻を過ぎているので捨てる。
          av_frame_free(&frameToShow);
          droppedFrames++;
        }
        frameToShow = head;
      }
    }

    if (frameToShow != nullptr) {
      if (droppedFrames > 0) {
        spdlog::debug("dropped {} late video frames", droppedFrames);
      }
      // 10bit→8bit 変換は映像デコーダースレッド側で済ませてあるので、
      // メインループ(=描画スレッド)は描画に専念する。ここで 4K の swscale を
      // やると描画レートが実時間を割り、映像が音声から遅れていく。
      drawWebGpu(frameToShow);
      displayedFrameCount.fetch_add(1, std::memory_order_relaxed);

      av_frame_free(&frameToShow);
    }
  }

  // 字幕項目は stream 固有の time_base/codec 種別を保持する。キュー滞留中に
  // 字幕アセットが乗り換わっても、最新のグローバル状態で誤処理しない。
  if (!captionCallback.isNull() && audioFrame) {
    for (;;) {
      CaptionData p;
      {
        std::lock_guard<std::mutex> lock(captionDataMtx);
        if (captionDataQueue.empty()) {
          break;
        }
        p = std::move(captionDataQueue.front());
        captionDataQueue.pop_front();
      }
      double pts = (double)p.pts;
      std::vector<uint8_t> &buffer = p.data;
      double ptsTime = pts * av_q2d(p.timeBase);

      // AudioFrameは完全に見るだけ
      // TODO: クロック一回転したときの処理
      double estimatedAudioPlayTime =
          estimateAudioPlayTime(audioFrame, currentBufferedAudioSamples);

      auto data = emscripten::val(
          emscripten::typed_memory_view<uint8_t>(buffer.size(), &buffer[0]));
      if (p.isTtml) {
        // TTML(4K/8K)は PTS を持たず、表示時刻は TTML 内の begin/end で表現
        // される。JS 側で同期できるよう、ここでは現在の再生メディア時刻
        // (音声再生時刻・秒)を ptsTime として渡す。あわせて字幕アセットの
        // stream index を渡し、JS 側が時間軸の乗り換えを検出できるようにする。
        captionCallback((double)0, estimatedAudioPlayTime, data, p.streamIndex);
      } else {
        captionCallback(pts, ptsTime - estimatedAudioPlayTime, data,
                        p.streamIndex);
      }
    }
  }

  // AudioFrameはVideoFrame処理でのPTS参照用に1個だけキューに残す
  for (;;) {
    AVFrame *frame = nullptr;
    {
      std::lock_guard<std::mutex> lock(audioFrameMtx);
      if (audioFrameQueue.size() <= 1) {
        break;
      }
      frame = audioFrameQueue.front();
      audioFrameQueue.pop_front();
    }
    spdlog::debug("AudioFrame@mainloop pts:{} time_base:{} nb_samples:{} ch:{}",
                  frame->pts, av_q2d(frame->time_base), frame->nb_samples,
                  frame->ch_layout.nb_channels);

    const int inChannels = frame->ch_layout.nb_channels;
    const AVSampleFormat inFormat = (AVSampleFormat)frame->format;
    // AudioWorklet へそのまま渡せるのは「2ch のプレーナ float」だけ。それ以外
    // (22.2ch や 5.1ch、パック形式) は swresample でステレオ FLTP へ変換する。
    const bool directFeed =
        inChannels == 2 && inFormat == AV_SAMPLE_FMT_FLTP && frame->data[1];

    if (frame->sample_rate <= 0 || inChannels <= 0) {
      spdlog::warn("skip audio frame: sample_rate:{} channels:{}",
                   frame->sample_rate, inChannels);
      av_frame_free(&frame);
      continue;
    }

    if (!directFeed) {
      if (!swr || channel_layout != inChannels ||
          sample_rate != frame->sample_rate || swrInputFormat != inFormat) {
        const char *fromName = av_get_sample_fmt_name(swrInputFormat);
        const char *toName = av_get_sample_fmt_name(inFormat);
        spdlog::info("SWR {}: sample_rate:{}->{} channels:{}->{} format:{}->{}",
                     swr ? "Changed" : "Initialized", sample_rate,
                     frame->sample_rate, channel_layout, inChannels,
                     fromName ? fromName : "none", toName ? toName : "none");
        swr_free(&swr);
        channel_layout = 0;
        sample_rate = 0;
        swrInputFormat = AV_SAMPLE_FMT_NONE;

        AVChannelLayout outLayout = AV_CHANNEL_LAYOUT_STEREO;
        AVChannelLayout inLayout;
        if (frame->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
          // レイアウトが未指定のままだと swr_init が失敗する。チャンネル数から
          // 既定のレイアウトを当てる。
          av_channel_layout_default(&inLayout, inChannels);
        } else {
          av_channel_layout_copy(&inLayout, &frame->ch_layout);
        }
        int ret =
            swr_alloc_set_opts2(&swr,       // we're allocating a new context
                                &outLayout, // out_ch_layout (downmix to stereo)
                                AV_SAMPLE_FMT_FLTP, // out_sample_fmt
                                48000,              // out_sample_rate
                                &inLayout,          // in_ch_layout
                                inFormat,           // in_sample_fmt
                                frame->sample_rate, // in_sample_rate
                                0,                  // log_offset
                                nullptr);           // log_ctx
        av_channel_layout_uninit(&inLayout);
        if (ret >= 0) {
          ret = swr_init(swr);
        }
        if (ret < 0) {
          // 初期化に失敗したまま変換すると、そのまま雑音を再生してしまう。
          spdlog::error("swr init failed: {} {}", ret, av_err2str(ret));
          swr_free(&swr);
          av_frame_free(&frame);
          continue;
        }
        channel_layout = inChannels;
        sample_rate = frame->sample_rate;
        swrInputFormat = inFormat;
      }

      int out_samples = (int)av_rescale_rnd(
          swr_get_delay(swr, frame->sample_rate) + frame->nb_samples, 48000,
          frame->sample_rate, AV_ROUND_UP);
      if (swrOutputSize != out_samples) {
        if (swrOutput[0]) {
          av_freep(&swrOutput[0]);
        }
        int linesize;
        int ret = av_samples_alloc(swrOutput, &linesize, 2, out_samples,
                                   AV_SAMPLE_FMT_FLTP, 0);
        spdlog::info("swr out_samples:{}->{} in_samples:{} linesize:{}",
                     swrOutputSize, out_samples, frame->nb_samples, linesize);
        if (ret < 0) {
          spdlog::error("av_samples_alloc failed: {} {}", ret, av_err2str(ret));
          swrOutput[0] = nullptr;
          swrOutput[1] = nullptr;
          swrOutputSize = 0;
          av_frame_free(&frame);
          continue;
        }
        swrOutputSize = out_samples;
      }

      // 22.2ch (24プレーン) のようにチャンネル数が AV_NUM_DATA_POINTERS(8) を
      // 超えるプレーナ音声では、frame->data には先頭 8 プレーンしか入らず、全
      // プレーンは extended_data からしか辿れない。data を渡すと 9 番目以降と
      // してフレーム構造体の隣 (linesize 配列など) を音声データとして読むため、
      // 雑音が出続ける。
      out_samples = swr_convert(swr, swrOutput, out_samples,
                                (const uint8_t **)frame->extended_data,
                                frame->nb_samples);
      if (out_samples < 0) {
        spdlog::error("swr_convert failed: {} {}", out_samples,
                      av_err2str(out_samples));
      } else if (out_samples > 0) {
        feedAudioData(reinterpret_cast<float *>(swrOutput[0]),
                      reinterpret_cast<float *>(swrOutput[1]), out_samples);
      }
    } else {
      if (swr) {
        spdlog::info("swr free (now 2ch audio).");
        swr_free(&swr);
        channel_layout = 0;
        sample_rate = 0;
        swrInputFormat = AV_SAMPLE_FMT_NONE;
      }
      feedAudioData(reinterpret_cast<float *>(frame->data[0]),
                    reinterpret_cast<float *>(frame->data[1]),
                    frame->nb_samples);
    }

    av_frame_free(&frame);
  }
}

// 戻り値: まだ続きがあるなら true、終端に達したら false。
bool downloadNextRange() {
  emscripten_fetch_attr_t attr;
  emscripten_fetch_attr_init(&attr);
  strcpy(attr.requestMethod, "GET");
  attr.attributes =
      EMSCRIPTEN_FETCH_LOAD_TO_MEMORY | EMSCRIPTEN_FETCH_SYNCHRONOUS;
  std::string range = fmt::format("bytes={}-{}", downloadCount,
                                  downloadCount + donwloadRangeSize - 1);
  const char *headers[] = {"Range", range.c_str(), NULL};
  attr.requestHeaders = headers;

  spdlog::debug("request {} Range: {}", playFileUrl, range);
  emscripten_fetch_t *fetch = emscripten_fetch(&attr, playFileUrl.c_str());
  bool hasMore = true;
  if (fetch->status == 416) {
    // Range が範囲外 = ちょうど読み切っていた。
    spdlog::info("fetch reached the end of {} ({} bytes)", playFileUrl,
                 downloadCount);
    emscripten_fetch_close(fetch);
    return false;
  }
  if (fetch->status == 206) {
    spdlog::debug("fetch success size: {}", fetch->numBytes);
    {
      std::lock_guard<std::mutex> lock(inputBufferMtx);
      if (inputBufferWriteIndex + fetch->numBytes >= MAX_INPUT_BUFFER) {
        size_t remainSize = inputBufferWriteIndex - inputBufferReadIndex;
        // 詰め直しは領域が重なりうるので memmove を使う (memcpy は UB)。
        memmove(&inputBuffer[0], &inputBuffer[inputBufferReadIndex],
                remainSize);
        inputBufferReadIndex = 0;
        inputBufferWriteIndex = remainSize;
      }
      // 詰め直してもなお入らない場合は書かずに捨てる。ここで書き込むと
      // 入力リングバッファの外へはみ出す。次のループで消費を待って再取得する。
      if (inputBufferWriteIndex + fetch->numBytes >= MAX_INPUT_BUFFER) {
        spdlog::warn("input buffer full: drop fetched {} bytes (offset {})",
                     fetch->numBytes, downloadCount);
        emscripten_fetch_close(fetch);
        // 消費待ち。まだ終端ではないので、同じ Range をやり直す。
        return true;
      }
      memcpy(&inputBuffer[inputBufferWriteIndex], &fetch->data[0],
             fetch->numBytes);
      inputBufferWriteIndex += fetch->numBytes;
      downloadCount += fetch->numBytes;
      waitCv.notify_all();
    }
    // 要求より短いチャンクが返ってきたら、それが最後のチャンク。
    if (fetch->numBytes < donwloadRangeSize) {
      spdlog::info("fetch reached the end of {} ({} bytes)", playFileUrl,
                   downloadCount);
      hasMore = false;
    }
  } else {
    spdlog::error("fetch failed URL: {} status code: {}", playFileUrl,
                  fetch->status);
    hasMore = false;
  }
  emscripten_fetch_close(fetch);
  return hasMore;
}

void downloaderThraedFunc() {
  resetedDownloader = false;
  while (!resetedDownloader) {
    size_t remainSize;
    {
      std::lock_guard<std::mutex> lock(inputBufferMtx);
      remainSize = inputBufferWriteIndex - inputBufferReadIndex;
    }
    if (remainSize < donwloadRangeSize / 2) {
      if (!downloadNextRange()) {
        // 全部落とし終えた。デマルチプレクサへ終端を伝えて、このスレッドは
        // 役目を終える (残りはバッファから再生される)。
        setInputEnded();
        return;
      }
    } else {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
  }
}

void playFile(std::string url) {
  spdlog::info("playFile: {}", url);
  playFileUrl = url;
  downloaderThread = std::thread([]() { downloaderThraedFunc(); });
}

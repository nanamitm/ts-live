#include <algorithm>
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

bool resetedDecoder = false;
std::uint8_t inputBuffer[MAX_INPUT_BUFFER];
std::mutex inputBufferMtx;
std::condition_variable waitCv;

// BS4K/8K (MMT/TLV) 再生時は true。read_packet() 内の 0x47 (MPEG2-TS
// sync_byte) 探索・188バイト単位の servicefilter 処理は通常放送(MPEG2-TS)
// 専用のロジックであり、可変長パケットの TLV データに対して行うと
// バイト列を破壊してしまうため、TLV モードでは素通しに切り替える。
bool tlvMode = false;

void setTlvMode(bool isTlv) {
  tlvMode = isTlv;
  spdlog::info("setTlvMode: {}", isTlv);
}

size_t inputBufferReadIndex = 0;
size_t inputBufferWriteIndex = 0;

// for libav
AVCodecContext *videoCodecContext = nullptr;
AVCodecContext *audioCodecContext = nullptr;

// WebGPU側は 8bit yuv420p 前提のため、HEVC Main10 (yuv420p10le) 等の
// 高ビット深度フレームは描画直前 (メインループ = 消費側の単一スレッド) で
// 8bit に変換する。デコードスレッド側で毎フレーム 12MB を malloc/free して
// 変換していた旧実装は、WASM の単一 malloc ロックを複数デコードワーカーと
// 奪い合ってコマ送りの一因になっていた。変換先フレームは 1 枚だけ確保して
// 使い回すことで malloc 競合を無くす。
SwsContext *videoSwsContext = nullptr;
AVPixelFormat videoSwsSrcFormat = AV_PIX_FMT_NONE;
int videoSwsWidth = 0, videoSwsHeight = 0;
AVFrame *conversionFrame = nullptr; // 8bit 変換先 (使い回し)

std::deque<AVFrame *> videoFrameQueue, audioFrameQueue;
std::deque<std::pair<int64_t, std::vector<uint8_t>>> captionDataQueue;
std::mutex videoFrameMtx, audioFrameMtx, captionDataMtx;
bool videoFrameFound = false;

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

int64_t initPts = -1;

emscripten::val captionCallback = emscripten::val::null();

// WebCodecs (JS 側ハードウェア HEVC デコード) モード。true のとき映像は
// WASM でソフトデコードせず、HEVC アクセスユニットをそのまま JS の
// VideoDecoder へ渡す。BS4K など HEVC チャンネルで使う。
bool webCodecsMode = false;
emscripten::val videoAuCallback = emscripten::val::null();

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

double getAudioPlaybackTime() { return currentAudioPlaybackTime; }

std::string playFileUrl;
std::thread downloaderThread;

bool resetedDownloader = false;

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
DualMonoMode dualMonoMode = DualMonoMode::MAIN;

void setDualMonoMode(int mode) {
  //
  dualMonoMode = (DualMonoMode)mode;
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
      return inputBufferWriteIndex > inputBufferReadIndex || resetedDecoder;
    });
    if (resetedDecoder) {
      spdlog::debug("resetedDecoder detected in read_packet");
      return -1;
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

  waitCv.wait(lock, [&] {
    return inputBufferWriteIndex - inputBufferReadIndex >= bufSize ||
           resetedDecoder;
  });
  if (resetedDecoder) {
    spdlog::debug("resetedDecoder detected in read_packet");
    return -1;
  }

  // 0x47: TS packet header sync_byte
  while (inputBuffer[inputBufferReadIndex] != 0x47 &&
         inputBufferReadIndex < inputBufferWriteIndex) {
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
         inputBufferReadIndex + 188 < inputBufferWriteIndex) {
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
  return copySize;
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
  videoStream = nullptr;
  audioStreamList.clear();
  captionStream = nullptr;
  captionIsTtml = false;
  videoFrameFound = false;

  if (videoSwsContext != nullptr) {
    sws_freeContext(videoSwsContext);
    videoSwsContext = nullptr;
  }
  if (conversionFrame != nullptr) {
    av_frame_free(&conversionFrame);
  }
  videoSwsSrcFormat = AV_PIX_FMT_NONE;
  videoSwsWidth = 0;
  videoSwsHeight = 0;
}

void reset() {
  spdlog::debug("reset()");
  resetedDecoder = true;
  resetedDownloader = true;
  resetInternal();
}

void videoDecoderThreadFunc(bool &terminateFlag) {
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
    return;
  }
  spdlog::debug("avcodec for video open success.");

  AVFrame *frame = av_frame_alloc();

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
      const AVPixFmtDescriptor *desc =
          av_pix_fmt_desc_get((AVPixelFormat)(frame->format));
      int bufferSize = av_image_get_buffer_size((AVPixelFormat)frame->format,
                                                frame->width, frame->height, 1);
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
          frame->buf[0]->size, frame->buf[1]->size, frame->buf[2]->size,
          bufferSize);
      if (initPts < 0) {
        initPts = frame->pts;
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

  spdlog::debug("freeing videoCodecContext");
  avcodec_free_context(&videoCodecContext);
}

// 10bit→8bit 変換専用スレッド。videoConvertQueue から生フレームを取り出し、
// 必要なら 8bit yuv420p に変換して videoFrameQueue へ送る。デコード・描画と
// 並列に動くことで、各段が単独で実時間を維持できる。
void videoConvertThreadFunc(bool &terminateFlag) {
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
      if (videoSwsContext == nullptr ||
          videoSwsSrcFormat != (AVPixelFormat)raw->format ||
          videoSwsWidth != raw->width || videoSwsHeight != raw->height) {
        if (videoSwsContext != nullptr) {
          sws_freeContext(videoSwsContext);
        }
        videoSwsContext =
            sws_getContext(raw->width, raw->height, (AVPixelFormat)raw->format,
                           raw->width, raw->height, AV_PIX_FMT_YUV420P,
                           SWS_POINT, nullptr, nullptr, nullptr);
        videoSwsSrcFormat = (AVPixelFormat)raw->format;
        videoSwsWidth = raw->width;
        videoSwsHeight = raw->height;
      }
      if (videoSwsContext != nullptr) {
        outFrame = av_frame_alloc();
        outFrame->format = AV_PIX_FMT_YUV420P;
        outFrame->width = raw->width;
        outFrame->height = raw->height;
        av_frame_get_buffer(outFrame, 0);
        av_frame_copy_props(outFrame, raw);
        sws_scale(videoSwsContext, raw->data, raw->linesize, 0, raw->height,
                  outFrame->data, outFrame->linesize);
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
}

void audioDecoderThreadFunc(bool &terminateFlag) {
  const AVCodec *audioCodec =
      avcodec_find_decoder(audioStreamList[0]->codecpar->codec_id);
  if (audioCodec == nullptr) {
    spdlog::error("No supported decoder for Audio ...");
    return;
  } else {
    spdlog::debug("Audio Decoder created.");
  }
  audioCodecContext = avcodec_alloc_context3(audioCodec);
  if (audioCodecContext == nullptr) {
    spdlog::error("avcodec_alloc_context3 for audio failed");
    return;
  } else {
    spdlog::debug("avcodec_alloc_context3 for audio success.");
  }
  // open codec
  if (avcodec_parameters_to_context(audioCodecContext,
                                    audioStreamList[0]->codecpar) < 0) {
    spdlog::error("avcodec_parameters_to_context failed");
    return;
  }

  if (avcodec_open2(audioCodecContext, audioCodec, nullptr) != 0) {
    spdlog::error("avcodec_open2 failed");
    return;
  }
  spdlog::debug("avcodec for audio open success.");

  // 巻き戻す
  // inputBufferReadIndex = 0;

  AVFrame *frame = av_frame_alloc();

  while (!terminateFlag) {
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
      spdlog::debug("AudioFrame: format:{} pts:{} frame timebase:{} stream "
                    "timebase:{} buf[0].size:{} buf[1].size:{} nb_samples:{} "
                    "ch:{}",
                    frame->format, frame->pts, av_q2d(frame->time_base),
                    av_q2d(audioStreamList[0]->time_base), frame->buf[0]->size,
                    frame->buf[1]->size, frame->nb_samples,
                    frame->ch_layout.nb_channels);
      if (initPts < 0) {
        initPts = frame->pts;
      }
      frame->time_base = audioStreamList[0]->time_base;
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
  spdlog::debug("freeing videoCodecContext");
  avcodec_free_context(&audioCodecContext);
}

// decoder
void decoderThreadFunc() {
  spdlog::info("Decoder Thread started.");
  resetInternal();
  AVFormatContext *formatContext = nullptr;
  AVIOContext *avioContext = nullptr;
  uint8_t *ibuf = nullptr;
  size_t ibufSize = 64 * 1024;
  size_t requireBufSize = 2 * 1024 * 1024;

  AVFrame *frame = nullptr;

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
        return;
      }
      spdlog::debug("open success");
      formatContext->probesize = PROBE_SIZE;
    }

    if (avformat_find_stream_info(formatContext, nullptr) < 0) {
      spdlog::error("avformat_find_stream_info error");
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
      return;
    }
    if (audioStreamList.empty()) {
      spdlog::error("No audio stream ...");
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
  }

  bool videoTerminateFlag = false;
  bool audioTerminateFlag = false;
  bool convertTerminateFlag = false;
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
    if (bufferedAudioSamples > audioBufferTarget ||
        videoPacketQueue.size() > 600 || audioPacketQueue.size() > 600) {
      std::this_thread::sleep_for(std::chrono::milliseconds(3));
      continue;
    }
    // decode frames
    if (frame == nullptr) {
      frame = av_frame_alloc();
    }
    AVPacket *ppacket = av_packet_alloc();
    int videoCount = 0;
    int audioCount = 0;
    int ret = av_read_frame(formatContext, ppacket);
    if (ret != 0) {
      spdlog::info("av_read_frame: {} {}", ret, av_err2str(ret));
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
          // 供給過多で暴走しないよう上限を設ける(古いものを捨てる)。
          if (videoAuQueue.size() > 300) {
            videoAuQueue.pop_front();
          }
          videoAuQueue.push_back(std::move(au));
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
    if (audioStreamList.size() > 0 &&
        (ppacket->stream_index ==
         audioStreamList[(int)dualMonoMode % audioStreamList.size()]->index)) {
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
        static std::mutex ttmlMtx;
        static std::string lastTtml;
        bool changed = false;
        {
          std::lock_guard<std::mutex> lock(ttmlMtx);
          if (ttml != lastTtml) {
            lastTtml = ttml;
            changed = true;
          }
        }
        if (changed && !captionCallback.isNull()) {
          std::vector<uint8_t> buffer(ppacket->size);
          memcpy(&buffer[0], ppacket->data, ppacket->size);
          std::lock_guard<std::mutex> lock(captionDataMtx);
          captionDataQueue.push_back(
              std::make_pair<int64_t, std::vector<uint8_t>>(0,
                                                            std::move(buffer)));
        }
      } else {
        std::string str = fmt::format("{:02X}", ppacket->data[0]);
        for (int i = 1; i < ppacket->size; i++) {
          str += fmt::format(" {:02x}", ppacket->data[i]);
        }
        spdlog::debug("CaptionPacket received. size: {} data: [{}]",
                      ppacket->size, str);
        if (!captionCallback.isNull()) {
          std::vector<uint8_t> buffer(ppacket->size);
          memcpy(&buffer[0], ppacket->data, ppacket->size);
          {
            std::lock_guard<std::mutex> lock(captionDataMtx);
            int64_t pts = ppacket->pts;
            captionDataQueue.push_back(
                std::make_pair<int64_t, std::vector<uint8_t>>(
                    std::move(pts), std::move(buffer)));
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

  spdlog::debug("freeing avio_context");
  avio_context_free(&avioContext);
  // spdlog::debug("freeing avformat context");
  avformat_free_context(formatContext);

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

void decoderMainloop() {
  spdlog::debug("decoderMainloop videoFrameQueue:{} audioFrameQueue:{} "
                "videoPacketQueue:{} audioPacketQueue:{}",
                videoFrameQueue.size(), audioFrameQueue.size(),
                videoPacketQueue.size(), audioPacketQueue.size());

  // WebCodecs モード: 溜まった HEVC アクセスユニットを JS の VideoDecoder へ
  // 渡す。ここはメインスレッドなので VideoDecoder を安全に触れる。
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

  if (videoStream && !audioStreamList.empty() && !statsCallback.isNull()) {
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now() - startTime);
    auto data = emscripten::val::object();
    data.set("time", duration.count() / 1000.0);
    data.set("VideoFrameQueueSize", videoFrameQueue.size());
    data.set("AudioFrameQueueSize", audioFrameQueue.size());
    data.set("AudioWorkletBufferSize", bufferedAudioSamples);
    data.set("InputBufferSize",
             (inputBufferWriteIndex - inputBufferReadIndex) / 1000000.0);
    data.set("CaptionDataQueueSize",
             captionStream ? captionDataQueue.size() : 0);
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
  if (audioFrame && !audioStreamList.empty() &&
      audioStreamList[0]->codecpar->sample_rate > 0) {
    double audioPtsTimeForClock =
        audioFrame->pts * av_q2d(audioFrame->time_base);
    currentAudioPlaybackTime =
        audioPtsTimeForClock - (double)bufferedAudioSamples /
                                   audioStreamList[0]->codecpar->sample_rate;
  }

  if (currentFrame && audioFrame) {
    // 次のVideoFrameをまずは見る（条件を満たせばpopする）
    // AudioFrameは完全に見るだけ
    // spdlog::info("found Current Frame {}x{} bufferSize:{}",
    // currentFrame->width,
    //              currentFrame->height, bufferSize);
    spdlog::debug(
        "VideoFrame@mainloop pts:{} time_base:{} {}/{} AudioQueueSize:{}",
        currentFrame->pts, av_q2d(currentFrame->time_base),
        currentFrame->time_base.num, currentFrame->time_base.den,
        audioFrameQueue.size());

    // WindowSize確認＆リサイズ
    // TODO:
    // if (ww != videoStream->codecpar->width ||
    //     wh != videoStream->codecpar->height) {
    //   set_style(videoStream->codecpar->width);
    // }

    // VideoとAudioのPTSをクロックから時間に直す
    // TODO: クロック一回転したときの処理
    double videoPtsTime = currentFrame->pts * av_q2d(currentFrame->time_base);
    double audioPtsTime = audioFrame->pts * av_q2d(audioFrame->time_base);

    // 上記から推定される、現在再生している音声のPTS（時間）
    // double estimatedAudioPlayTime =
    //     audioPtsTime - (double)queuedSize / ctx.openedAudioSpec.freq;
    double estimatedAudioPlayTime =
        audioPtsTime - (double)bufferedAudioSamples /
                           audioStreamList[0]->codecpar->sample_rate;

    // 1フレーム分くらいはズレてもいいからこれでいいか。フレーム真面目に考えると良くわからない。
    bool showFlag = estimatedAudioPlayTime > videoPtsTime;

    // リップシンク条件を満たしてたらVideoFrame再生
    if (showFlag) {
      {
        std::lock_guard<std::mutex> lock(videoFrameMtx);
        videoFrameQueue.pop_front();
      }
      double timestamp =
          currentFrame->pts * av_q2d(currentFrame->time_base) * 1000000;

      // 10bit→8bit 変換は映像デコーダースレッド側で済ませてあるので、
      // メインループ(=描画スレッド)は描画に専念する。ここで 4K の swscale を
      // やると描画レートが実時間を割り、映像が音声から遅れていく。
      drawWebGpu(currentFrame);

      av_frame_free(&currentFrame);
    }
  }

  if (!captionCallback.isNull() && audioFrame) {
    while (captionDataQueue.size() > 0) {
      std::pair<int64_t, std::vector<uint8_t>> p;
      {
        std::lock_guard<std::mutex> lock(captionDataMtx);
        p = std::move(captionDataQueue.front());
        captionDataQueue.pop_front();
      }
      double pts = (double)p.first;
      std::vector<uint8_t> &buffer = p.second;
      double ptsTime = pts * av_q2d(captionStream->time_base);

      // AudioFrameは完全に見るだけ
      // VideoとAudioのPTSをクロックから時間に直す
      // TODO: クロック一回転したときの処理
      double audioPtsTime = audioFrame->pts * av_q2d(audioFrame->time_base);

      // 上記から推定される、現在再生している音声のPTS（時間）
      // double estimatedAudioPlayTime =
      //     audioPtsTime - (double)queuedSize / ctx.openedAudioSpec.freq;
      // 0除算を避けるためsample_rateがおかしいときはAudioのPTSをそのまま返す
      int sampleRate = audioStreamList[0]->codecpar->sample_rate;
      double estimatedAudioPlayTime =
          sampleRate ? audioPtsTime - (double)bufferedAudioSamples / sampleRate
                     : audioPtsTime;

      auto data = emscripten::val(
          emscripten::typed_memory_view<uint8_t>(buffer.size(), &buffer[0]));
      if (captionIsTtml) {
        // TTML(4K/8K)は PTS を持たず、表示時刻は TTML 内の begin/end で表現
        // される。JS 側で同期できるよう、ここでは現在の再生メディア時刻
        // (音声再生時刻・秒)を ptsTime として渡す。
        captionCallback((double)0, estimatedAudioPlayTime, data);
      } else {
        captionCallback(pts, ptsTime - estimatedAudioPlayTime, data);
      }
    }
  }

  // AudioFrameはVideoFrame処理でのPTS参照用に1個だけキューに残す
  while (audioFrameQueue.size() > 1) {
    AVFrame *frame = nullptr;
    {
      std::lock_guard<std::mutex> lock(audioFrameMtx);
      frame = audioFrameQueue.front();
      audioFrameQueue.pop_front();
    }
    spdlog::debug("AudioFrame@mainloop pts:{} time_base:{} nb_samples:{} ch:{}",
                  frame->pts, av_q2d(frame->time_base), frame->nb_samples,
                  frame->ch_layout.nb_channels);

    if (frame->ch_layout.nb_channels != 2) {
      if (!swr || channel_layout != frame->ch_layout.nb_channels ||
          sample_rate != frame->sample_rate) {
        spdlog::info("SWR {}: sample_rate:{}->{} layout:{}->{}",
                     swr ? "Changed" : "Initialized", sample_rate,
                     frame->sample_rate, channel_layout,
                     frame->ch_layout.nb_channels);
        channel_layout = frame->ch_layout.nb_channels;
        sample_rate = frame->sample_rate;
        if (swr) {
          swr_free(&swr);
        }
        AVChannelLayout outLayout = AV_CHANNEL_LAYOUT_STEREO;
        swr_alloc_set_opts2(&swr,       // we're allocating a new context
                            &outLayout, // out_ch_layout (downmix to stereo)
                            AV_SAMPLE_FMT_FLTP, // out_sample_fmt
                            48000,              // out_sample_rate
                            &frame->ch_layout,  // in_ch_layout
                            AV_SAMPLE_FMT_FLTP, // in_sample_fmt
                            frame->sample_rate, // in_sample_rate
                            0,                  // log_offset
                            NULL);              // log_ctx

        swr_init(swr);
      }

      int output_linesize;
      int out_samples =
          av_rescale_rnd(swr_get_delay(swr, 48000) + frame->nb_samples, 48000,
                         48000, AV_ROUND_UP);
      if (swrOutputSize != out_samples) {
        if (swrOutput[0]) {
          av_freep(&swrOutput[0]);
        }
        int linesize;
        av_samples_alloc(swrOutput, &linesize, 2, out_samples,
                         AV_SAMPLE_FMT_FLTP, sizeof(float));
        spdlog::info("swr out_samples:{}->{} "
                     "in_samples:{} linesize:{}",
                     swrOutputSize, out_samples, frame->nb_samples, linesize);
        swrOutputSize = out_samples;
      }

      out_samples =
          swr_convert(swr, swrOutput, out_samples,
                      (const uint8_t **)frame->data, frame->nb_samples);

      feedAudioData(reinterpret_cast<float *>(swrOutput[0]),
                    reinterpret_cast<float *>(swrOutput[1]), out_samples);
    } else {
      if (swr) {
        spdlog::info("swr free (now 2ch audio).");
        swr_free(&swr);
      }
      feedAudioData(reinterpret_cast<float *>(frame->data[0]),
                    reinterpret_cast<float *>(frame->data[1]),
                    frame->nb_samples);
    }

    av_frame_free(&frame);
  }
}

void downloadNextRange() {
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
  if (fetch->status == 206) {
    spdlog::debug("fetch success size: {}", fetch->numBytes);
    {
      std::lock_guard<std::mutex> lock(inputBufferMtx);
      if (inputBufferWriteIndex + fetch->numBytes >= MAX_INPUT_BUFFER) {
        size_t remainSize = inputBufferWriteIndex - inputBufferReadIndex;
        memcpy(&inputBuffer[0], &inputBuffer[inputBufferReadIndex], remainSize);
        inputBufferReadIndex = 0;
        inputBufferWriteIndex = remainSize;
      }
      memcpy(&inputBuffer[inputBufferWriteIndex], &fetch->data[0],
             fetch->numBytes);
      inputBufferWriteIndex += fetch->numBytes;
      downloadCount += fetch->numBytes;
      waitCv.notify_all();
    }
  } else {
    spdlog::error("fetch failed URL: {} status code: {}", playFileUrl,
                  fetch->status);
  }
  emscripten_fetch_close(fetch);
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
      downloadNextRange();
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

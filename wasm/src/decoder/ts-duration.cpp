#include "ts-duration.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
}

namespace {
// 再生系のリングバッファや AVFormatContext とは共有しない。
std::vector<uint8_t> input;

// 最大数十MBの一時領域を次の解析まで持ち越さない。どの経路で抜けても
// 手放せるよう、確保した側ではなくスコープの終わりで解放する。
struct InputRelease {
  ~InputRelease() { std::vector<uint8_t>().swap(input); }
};

struct ProbeInput {
  int64_t headSize, tailOffset, tailSize, fileSize;
  int64_t pos = 0;
};

int readProbe(void *opaque, uint8_t *dst, int size) {
  auto &p = *static_cast<ProbeInput *>(opaque);
  if (p.pos >= p.fileSize)
    return AVERROR_EOF;
  const uint8_t *src;
  int64_t available;
  if (p.pos < p.headSize) {
    src = input.data() + p.pos;
    available = p.headSize - p.pos;
  } else if (p.pos >= p.tailOffset) {
    src = input.data() + p.headSize + (p.pos - p.tailOffset);
    available = p.fileSize - p.pos;
  } else {
    // 未取得の中間部分を EOF と偽ると、先頭だけの長さを返してしまう。
    return AVERROR(EIO);
  }
  int count = static_cast<int>(std::min<int64_t>(size, available));
  memcpy(dst, src, count);
  p.pos += count;
  return count;
}

int64_t seekProbe(void *opaque, int64_t offset, int whence) {
  auto &p = *static_cast<ProbeInput *>(opaque);
  if (whence == AVSEEK_SIZE)
    return p.fileSize;
  whence &= ~AVSEEK_FORCE;
  int64_t base;
  if (whence == SEEK_SET)
    base = 0;
  else if (whence == SEEK_CUR)
    base = p.pos;
  else if (whence == SEEK_END)
    base = p.fileSize;
  else
    return AVERROR(EINVAL);
  if (offset < -base || offset > p.fileSize - base)
    return AVERROR(EINVAL);
  p.pos = base + offset;
  return p.pos;
}
} // namespace

emscripten::val getTsDurationInputBuffer(size_t size) {
  input.resize(size);
  return emscripten::val(emscripten::typed_memory_view(size, input.data()));
}

namespace {
// 先頭と末尾を seek 可能な1本の入力として FFmpeg に見せ、open() に渡す。
// 入力の検証と IO の後始末をここに寄せ、TS と TLV の解析で共有する。
template <typename Open>
double probeWithInput(size_t headSize, double tailOffset, size_t tailSize,
                      double fileSize, Open open) {
  InputRelease release;
  // バイト位置は 4GB を超えうるので、JS Number から int64_t に渡す。
  if (!std::isfinite(fileSize) || !std::isfinite(tailOffset) || fileSize < 1 ||
      fileSize > 9007199254740991.0 || tailOffset < 0 ||
      tailOffset > fileSize || tailOffset + tailSize != fileSize ||
      headSize > fileSize || headSize > input.size() ||
      tailSize > input.size() - headSize)
    return 0;
  ProbeInput source{
      static_cast<int64_t>(headSize), static_cast<int64_t>(tailOffset),
      static_cast<int64_t>(tailSize), static_cast<int64_t>(fileSize)};
  auto buffer = static_cast<uint8_t *>(av_malloc(32768));
  if (!buffer)
    return 0;
  auto io = avio_alloc_context(buffer, 32768, 0, &source, readProbe, nullptr,
                               seekProbe);
  if (!io) {
    av_free(buffer);
    return 0;
  }
  double duration = open(io, source);
  av_freep(&io->buffer);
  avio_context_free(&io);
  return duration;
}
} // namespace

double probeTsDuration(size_t headSize, double tailOffset, size_t tailSize,
                       double fileSize) {
  return probeWithInput(
      headSize, tailOffset, tailSize, fileSize,
      [](AVIOContext *io, const ProbeInput &source) {
        auto format = avformat_alloc_context();
        double duration = 0;
        if (format) {
          format->pb = io;
          format->flags |= AVFMT_FLAG_CUSTOM_IO;
          format->probesize = source.headSize;
          format->max_analyze_duration = AV_TIME_BASE;
          // FFmpeg の末尾探索範囲を、実際に用意したデータに収める。
          format->duration_probesize =
              source.tailSize ? source.tailSize : source.headSize;
          if (avformat_open_input(&format, nullptr,
                                  av_find_input_format("mpegts"),
                                  nullptr) >= 0) {
            avformat_find_stream_info(format, nullptr);
            // ビットレートによるフォールバック値は採用しない。
            if (format->duration_estimation_method == AVFMT_DURATION_FROM_PTS) {
              // 再生系の tsreadex は PAT の先頭サービスを選ぶ。同じ番組の
              // 映像・音声だけを対象にし、別番組や字幕の長さを混ぜない。
              const AVProgram *program =
                  format->nb_programs ? format->programs[0] : nullptr;
              unsigned count =
                  program ? program->nb_stream_indexes : format->nb_streams;
              for (unsigned i = 0; i < count; ++i) {
                auto st =
                    format->streams[program ? program->stream_index[i] : i];
                if ((st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO ||
                     st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) &&
                    st->duration != AV_NOPTS_VALUE && st->duration > 0) {
                  duration =
                      std::max(duration, st->duration * av_q2d(st->time_base));
                }
              }
            }
          }
        }
        avformat_close_input(&format);
        return duration;
      });
}

// mmts-dsfilter の PreScanFile と同じ求め方。先頭で映像・音声の最小 PTS を、
// 同じデマルチプレクサを末尾へ移して映像の最大 PTS を取り、その差を総時間と
// する。FFmpeg の mmttlv はビットレートでしか総時間を推定しないので自前で読む。
// MMT の PTS は MPU タイムスタンプ(NTP 時刻)由来で、先頭と末尾で比べられる。
double probeTlvDuration(size_t headSize, double tailOffset, size_t tailSize,
                        double fileSize) {
  return probeWithInput(
      headSize, tailOffset, tailSize, fileSize,
      [](AVIOContext *io, const ProbeInput &source) {
        auto format = avformat_alloc_context();
        double duration = 0;
        if (format) {
          format->pb = io;
          format->flags |= AVFMT_FLAG_CUSTOM_IO;
          format->probesize = source.headSize;
          // PTS は 33bit に収まらない NTP 時刻なので、TS 向けの折り返し
          // 補正をかけると先頭と末尾で別の値を引かれうる。生の値で比べる。
          format->correct_ts_overflow = 0;
          if (avformat_open_input(&format, nullptr,
                                  av_find_input_format("mmttlv"),
                                  nullptr) >= 0) {
            double first = 0, last = 0;
            bool hasFirst = false, hasLast = false;
            // 先頭と末尾が地続き(ファイル全体を渡した)なら移る必要がない。
            const bool contiguous = source.tailOffset == source.headSize;
            bool seeked = false;
            auto packet = av_packet_alloc();
            int errors = 0;
            while (packet) {
              int err = av_read_frame(format, packet);
              // 途中の壊れたパケット(INVALIDDATA など)は再生系と同じく読み
              // 飛ばす。終わり扱いにすると、そこまでの長さしか取れない。
              if (err < 0 && err != AVERROR_EOF && !avio_feof(format->pb) &&
                  ++errors < 1000)
                continue;
              if (err < 0) {
                errors = 0;
                // 先頭の終わり(未取得の中間部分)に着いたら末尾へ移る。
                // MPT で分かった映像・音声の対応はそのまま使い、読み位置の
                // 飛びはデマルチプレクサの resync が吸収する。
                if (seeked || contiguous || !source.tailSize)
                  break;
                seeked = true;
                avformat_flush(format);
                if (avio_seek(format->pb, source.tailOffset, SEEK_SET) < 0)
                  break;
                format->pb->error = 0;
                continue;
              }
              auto st = format->streams[packet->stream_index];
              auto type = st->codecpar->codec_type;
              if (packet->pts != AV_NOPTS_VALUE &&
                  (type == AVMEDIA_TYPE_VIDEO || type == AVMEDIA_TYPE_AUDIO)) {
                double pts = packet->pts * av_q2d(st->time_base);
                if (!seeked && (!hasFirst || pts < first)) {
                  first = pts;
                  hasFirst = true;
                }
                // 先頭の映像を数えると、末尾に PTS が無いファイルで先頭だけの
                // 長さを総時間と誤認する。
                if ((seeked || contiguous) && type == AVMEDIA_TYPE_VIDEO &&
                    (!hasLast || pts > last)) {
                  last = pts;
                  hasLast = true;
                }
              }
              av_packet_unref(packet);
            }
            av_packet_free(&packet);
            if (hasFirst && hasLast && last > first)
              duration = last - first;
          }
        }
        avformat_close_input(&format);
        return duration;
      });
}

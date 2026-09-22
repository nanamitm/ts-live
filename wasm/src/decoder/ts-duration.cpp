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

double probeTsDuration(size_t headSize, double tailOffset, size_t tailSize,
                       double fileSize) {
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
  auto format = avformat_alloc_context();
  double duration = 0;
  if (format) {
    format->pb = io;
    format->flags |= AVFMT_FLAG_CUSTOM_IO;
    format->probesize = headSize;
    format->max_analyze_duration = AV_TIME_BASE;
    // FFmpeg の末尾探索範囲を、実際に用意したデータに収める。
    format->duration_probesize = tailSize ? tailSize : headSize;
    if (avformat_open_input(&format, nullptr, av_find_input_format("mpegts"),
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
          auto st = format->streams[program ? program->stream_index[i] : i];
          if ((st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO ||
               st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) &&
              st->duration != AV_NOPTS_VALUE && st->duration > 0) {
            duration = std::max(duration, st->duration * av_q2d(st->time_base));
          }
        }
      }
    }
  }
  avformat_close_input(&format);
  av_freep(&io->buffer);
  avio_context_free(&io);
  // 最大数十MBの一時領域を次の再生まで保持しない。
  std::vector<uint8_t>().swap(input);
  return duration;
}

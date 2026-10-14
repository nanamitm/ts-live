#pragma once

// emscripten の libc++ には浮動小数点版の std::from_chars が無い(整数版
// だけ)。dantto4k の TTML パーサは長さや不透明度の数値をこれで読むので、
// dantto4k_ttml のコンパイル時だけ -include で補う。libc++ が対応したら
// __cpp_lib_to_chars が定義されるので、そのときはこちらを使わない。
#include <cerrno>
#include <charconv>
#include <cstdlib>
#include <string>
#include <system_error>
#include <version>

#if !defined(__cpp_lib_to_chars)
namespace std {

inline from_chars_result from_chars(const char *first, const char *last,
                                    double &value,
                                    chars_format = chars_format::general) {
  // from_chars は先頭の空白も '+' も受け付けない。strtod はどちらも読むので
  // 先に弾く。
  if (first == last || *first == '+' || *first == ' ' || *first == '\t' ||
      *first == '\n' || *first == '\r' || *first == '\f' || *first == '\v') {
    return {first, errc::invalid_argument};
  }
  // strtod は NUL 終端を要るので、範囲を文字列に写してから読む。
  const string text(first, last);
  char *end = nullptr;
  errno = 0;
  const double parsed = strtod(text.c_str(), &end);
  const auto consumed = end - text.c_str();
  if (consumed == 0) {
    return {first, errc::invalid_argument};
  }
  if (errno == ERANGE) {
    return {first + consumed, errc::result_out_of_range};
  }
  value = parsed;
  return {first + consumed, errc{}};
}

} // namespace std
#endif

#pragma once

#include <emscripten/val.h>
#include <string>

// ARIB-TTML (4K/8K MMT 字幕) を dantto4k の parser/resolver で解析し、スタイル
// 継承・タイミングの合成まで済ませた文書を JS オブジェクトで返す。
// ignoreTiming は TMD=1111(時刻制御なし)用で、begin/end を読まない。
// 解析できなければ { error: string } を返す。
emscripten::val parseTtml(const std::string &xml, bool ignoreTiming);

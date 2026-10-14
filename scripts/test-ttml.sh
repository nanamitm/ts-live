#!/bin/bash
# WASM に組み込んだ dantto4k の TTML parser/resolver (parseTtml) を Node で
# 確かめる。Emscripten 3.1.74 と、dantto4k を取得済みの wasm/build が必要。
# 例: emsdkコンテナで bash scripts/test-ttml.sh
set -euo pipefail
dantto4k=wasm/build/_deps/dantto4k-src
em++ -O2 -std=c++20 \
  -include wasm/src/caption/from_chars_double.hpp \
  -I"$dantto4k/src" \
  wasm/src/caption/ttml.cpp test/wasm/ttml-bindings.cpp \
  "$dantto4k/src/ttml/parser.cpp" "$dantto4k/src/ttml/resolver.cpp" \
  "$dantto4k/src/ttml/style.cpp" "$dantto4k/src/pugixml.cpp" \
  -lembind --no-entry -sMODULARIZE=1 -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH=1 \
  -o wasm/build/ttml-test.cjs
node --experimental-strip-types --no-warnings test/wasm/ttml.mjs

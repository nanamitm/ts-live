#!/bin/bash
# Emscripten 3.1.74、FFmpeg/FFprobeと、ビルド済みwasm/build/installが必要。
# 例: emsdkコンテナで bash scripts/test-ts-duration.sh
set -euo pipefail
em++ -O2 -std=c++20 -pthread -msimd128 \
  -Iwasm/build/install/include \
  wasm/src/decoder/ts-duration.cpp test/wasm/ts-duration-bindings.cpp \
  -Wl,--start-group wasm/build/install/lib/libavformat.a \
  wasm/build/install/lib/libavcodec.a wasm/build/install/lib/libavutil.a \
  wasm/build/install/lib/libswresample.a -Wl,--end-group \
  -lembind --no-entry -sMODULARIZE=1 -sENVIRONMENT=node \
  -sPTHREAD_POOL_SIZE=2 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  -o wasm/build/ts-duration-test.cjs
node test/wasm/ts-duration.mjs

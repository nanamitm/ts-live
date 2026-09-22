#include "../../wasm/src/decoder/ts-duration.hpp"
#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(ts_duration_test) {
  emscripten::function("getTsDurationInputBuffer", &getTsDurationInputBuffer);
  emscripten::function("probeTsDuration", &probeTsDuration);
  emscripten::function("probeTlvDuration", &probeTlvDuration);
}

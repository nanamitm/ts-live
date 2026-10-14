#include "../../wasm/src/caption/ttml.hpp"
#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(ttml_test) {
  emscripten::function("parseTtml", &parseTtml);
}

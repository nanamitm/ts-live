#pragma once
#include <emscripten/val.h>

emscripten::val getTsDurationInputBuffer(size_t size);
double probeTsDuration(size_t headSize, double tailOffset, size_t tailSize,
                       double fileSize);

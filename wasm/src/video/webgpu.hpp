#pragma once

extern "C" {
#include <libavutil/frame.h>
}

void initWebGpu();
void resizeSwapChain(int width, int height);
void drawWebGpu(AVFrame *frame, bool deinterlaceFlag, bool bwdifFlag);

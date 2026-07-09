#pragma once
#include <emscripten/val.h>

extern std::chrono::system_clock::time_point startTime;

void initDecoder();
void decoderMainloop();

emscripten::val getNextInputBuffer(size_t nextSize);
void commitInputData(size_t nextSize);
void setCaptionCallback(emscripten::val callback);
void setStatsCallback(emscripten::val callback);
void reset();
void playFile(std::string url);
void setDualMonoMode(int mode);
void setTlvMode(bool isTlv);
void setWebCodecsMode(bool enabled);
void setVideoAuCallback(emscripten::val callback);
void setVideoStreamInfoCallback(emscripten::val callback);
double getAudioPlaybackTime();

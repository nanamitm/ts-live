#pragma once
#include <emscripten/val.h>

void initDecoder();
void decoderMainloop();

emscripten::val getNextInputBuffer(size_t nextSize);
void commitInputData(size_t nextSize);
void setInputEnded();
void setPaused(bool value);
double getDisplayedFrameCount();
void setCaptionCallback(emscripten::val callback);
void setStatsCallback(emscripten::val callback);
void reset();
bool isResetCompleted();
void playFile(std::string url);
void setDualMonoMode(int mode);
std::string setDeinterlace(std::string filter);
void setDetelecineMode(int mode);
void setPlaybackRate(double rate);
void setTlvMode(bool isTlv);
void setWebCodecsMode(bool enabled);
void setVideoAuCallback(emscripten::val callback);
void setVideoStreamInfoCallback(emscripten::val callback);
double getAudioPlaybackTime();
double getConsumedInputBytes();
bool isDemuxEnded();

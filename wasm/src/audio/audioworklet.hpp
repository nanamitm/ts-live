#pragma once

#include <atomic>

void feedAudioData(float *buffer0, float *buffer1, int samples);
void startAudioWorklet();
void setBufferedAudioSamples(int samples);
void setAudioGain(double val);

extern std::atomic<int> bufferedAudioSamples;

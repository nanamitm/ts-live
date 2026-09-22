#include <string>

#include <emscripten/emscripten.h>
#include <emscripten/val.h>

#include "../util/util.hpp"
#include "audioworklet.hpp"

std::atomic<int> bufferedAudioSamples{0};

void setBufferedAudioSamples(int samples) {
  // set buffereredAudioSamples
  bufferedAudioSamples.store(samples, std::memory_order_relaxed);
}

void feedAudioData(float *buffer0, float *buffer1, int samples) {
  // clang-format off
  int fed = EM_ASM_INT({
    if (Module && Module['myAudio'] && Module['myAudio']['ctx'] && Module['myAudio']['ctx'].state === 'suspended') {
      Module['myAudio']['ctx'].resume()
    }
    if (Module && Module['myAudio'] && Module['myAudio']['node']) {
      const buffer0 = HEAPF32.slice($0>>2, ($0>>2) + $2);
      const buffer1 = HEAPF32.slice($1>>2, ($1>>2) + $2);
      Module['myAudio']['node'].port.postMessage({
        type: 'feed',
        buffer0: buffer0,
        buffer1: buffer1
      }, [buffer0.buffer, buffer1.buffer]);
      return 1;
    }
    return 0;
  }, buffer0, buffer1, samples);
  // clang-format on

  // 残量を自分でも足しておく。worklet からの通知は約53msおきにしか来ないので、
  // 渡した直後は「まだ空」に見える。音声クロックはこの残量ぶん引いた値なので、
  // 溜まっているぶんを引かないとクロックが先へ飛び、映像がそれを追って早送りに
  // なる (主/副の切替や速度変更で残量を捨てた直後に必ず起きる)。
  // 次の通知で worklet 側の実測に上書きされる。
  if (fed) {
    bufferedAudioSamples.fetch_add(samples, std::memory_order_relaxed);
  }
}

void clearAudioSamples() {
  // worklet からの通知を待たずに残量を 0 にしておく。待つと、その間の音声
  // クロックが「まだ1秒ぶん積まれている」前提のままになり時刻がずれる。
  setBufferedAudioSamples(0);
  // clang-format off
  EM_ASM({
    if (Module && Module['myAudio'] && Module['myAudio']['node']) {
      Module['myAudio']['node'].port.postMessage({type: 'reset'});
    }
  });
  // clang-format on
}

void startAudioWorklet() {
  std::string scriptSource = slurp("/processor.js");

  // clang-format off
  EM_ASM({
    (async function(){
      const audioContext = new AudioContext({sampleRate: 48000});
      // データURIだとスクリプト全体がURLに載る。長さ制限やCSPの都合が悪いので
      // Blob URL で渡す。
      const moduleUrl = URL.createObjectURL(
          new Blob([UTF8ToString($0)], {type: 'text/javascript'}));
      try {
        await audioContext.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const audioNode = new AudioWorkletNode(
          audioContext, 'audio-feeder-processor',
          {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
      const gainNode = audioContext.createGain();
      audioNode.connect(gainNode);
      gainNode.connect(audioContext.destination);
      console.log('AudioSetup OK');
      // ここへ来るまでは非同期で、その間の setAudioGain() は鳴らす先が無い。
      // 指定された音量は Module.myAudio.gainValue に控えてあるので、
      // 作り直しで消さないよう引き継いでから反映する。
      const pendingGain =
          Module['myAudio'] && Module['myAudio']['gainValue'] !== undefined
              ? Module['myAudio']['gainValue']
              : 1.0;
      Module['myAudio'] = {
        ctx: audioContext,
        node: audioNode,
        gain: gainNode,
        gainValue: pendingGain
      };
      audioContext.resume();
      audioNode.port.onmessage = e => {Module.setBufferedAudioSamples(e.data)};
      console.log('latency', Module['myAudio']['ctx'].baseLatency);
      gainNode.gain.setValueAtTime(pendingGain, audioContext.currentTime);
    })();
  }, scriptSource.c_str());
  // clang-format on
}

void setAudioGain(double val) {
  // clang-format off
  EM_ASM(
      {
        // AudioWorklet の用意は非同期なので、ここへ来た時点ではまだ
        // gain が無いことがある (ページを開いた直後など)。指定された値を
        // 控えておき、用意ができた時点で startAudioWorklet() が反映する。
        // 控えないと、保存しておいた音量やミュートが初回だけ効かない。
        if (!Module['myAudio']) {
          Module['myAudio'] = {};
        }
        Module['myAudio']['gainValue'] = $0;
        if (Module['myAudio']['gain']) {
          Module['myAudio']['gain'].gain.setValueAtTime(
              $0, Module['myAudio']['ctx'].currentTime);
        }
      },
      val);
  // clang-format on
}

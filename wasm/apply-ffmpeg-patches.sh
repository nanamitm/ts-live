#!/bin/bash
# FFmpeg のソースツリー(カレントディレクトリ)に ts-live 独自のパッチを当てる。
# 例: bash apply-ffmpeg-patches.sh ffmpeg-mmttlv-drcs.patch ffmpeg-mmttlv-skip-tlv.patch
#
# 再実行や fork 側への取り込みで既に含まれているパッチはスキップする。
# それ以外で当たらなかった場合はビルドを止める(当たらないまま黙って
# 成功扱いにすると、DRCS 字幕などの修正が気付かないうちに抜け落ちる)。
set -euo pipefail

for patch_file in "$@"; do
  name=$(basename "$patch_file")
  if patch -p1 -R --dry-run -s -f < "$patch_file" > /dev/null 2>&1; then
    echo "$name: 適用済みのためスキップ"
  else
    patch -p1 -N < "$patch_file"
    echo "$name: 適用"
  fi
done

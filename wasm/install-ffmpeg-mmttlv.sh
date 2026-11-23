#!/bin/bash
# 上流 FFmpeg のソースツリー(カレントディレクトリ)に MMT/TLV デマルチプレクサを足す。
# 例: bash install-ffmpeg-mmttlv.sh /path/to/wasm/ffmpeg-mmttlv
#
# ソース(mmtp.c / mmtp.h / mmttlv.c)は SuperFashi/FFmpeg 由来で、ts-live 側の
# 修正(DRCS 字幕リソース、未対応 TLV のスキップ、字幕タイミングのメタデータ)を
# 取り込み済みのものを ts-live リポジトリで管理している。
#
# 何度実行しても同じ結果になる(ファイルは上書きし、登録行は無いときだけ足す)。
# 登録行の挿入位置の目印が見つからない場合はビルドを止める(上流の更新で
# Makefile/allformats.c の並びが変わったときに、気付かないまま mmttlv が
# 無効になるのを防ぐ)。
set -euo pipefail

src_dir=$1/libavformat

for f in mmtp.c mmtp.h mmttlv.c; do
  cp "$src_dir/$f" "libavformat/$f"
done

# insert_after <file> <目印の行の先頭(固定文字列)> <追加する行>
insert_after() {
  local file=$1 anchor=$2 line=$3
  if grep -qxF -- "$line" "$file"; then
    echo "$file: 登録済み"
    return
  fi
  if ! awk -v anchor="$anchor" -v line="$line" '
    { print }
    !done && index($0, anchor) == 1 { print line; done = 1 }
    END { exit !done }
  ' "$file" > "$file.tmp"; then
    rm -f "$file.tmp"
    echo "$file: 挿入位置の目印が見つかりません: $anchor" >&2
    exit 1
  fi
  mv "$file.tmp" "$file"
  echo "$file: 登録"
}

insert_after libavformat/Makefile \
  'OBJS-$(CONFIG_MMF_MUXER)' \
  'OBJS-$(CONFIG_MMTTLV_DEMUXER)            += mmtp.o mmttlv.o'
insert_after libavformat/allformats.c \
  'extern const FFOutputFormat ff_mmf_muxer;' \
  'extern const FFInputFormat  ff_mmttlv_demuxer;'

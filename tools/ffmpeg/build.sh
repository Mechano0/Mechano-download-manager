#!/usr/bin/env bash
# Builds Mechano DM's own small ffmpeg.exe for Windows (64-bit) on Linux with MinGW.
#
# Mechano DM only asks ffmpeg to:
#   - join a picture file and a sound file without re-encoding ("-c copy": mp4 / webm / mkv)
#   - turn joined HLS pieces (.ts) into an .mp4 (copy, aac_adtstoasc)
#   - make MP3 files (decode AAC / Opus / Vorbis..., encode with LAME)
#   - the same jobs for yt-dlp's own downloader (merge, fix-ups, --audio-format mp3)
# so everything else (video decoders/encoders, scaling, devices, network...) is left out:
# about 4 MB instead of ~140 MB, same results.
#
# Licence: FFmpeg + LAME under the LGPL (v3 because of --enable-version3); no GPL parts.
# Used by .github/workflows/ffmpeg.yml; output: out/ffmpeg.exe + licence files.
set -euo pipefail

FFMPEG_TAG="${FFMPEG_TAG:-n7.1.1}"
LAME_VERSION="3.100"
HOST=x86_64-w64-mingw32
WORK="$(pwd)/work"
PREFIX="$WORK/prefix"
OUT="$(pwd)/out"
mkdir -p "$WORK" "$PREFIX" "$OUT"

# ---- LAME (MP3 encoder), static
cd "$WORK"
curl -fsSL -o lame.tar.gz "https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
tar xzf lame.tar.gz
cd "lame-${LAME_VERSION}"
./configure --host=$HOST --prefix="$PREFIX" --enable-static --disable-shared \
  --disable-frontend --disable-decoder --disable-gtktest --enable-nasm=no >/dev/null
make -j"$(nproc)" >/dev/null
make install >/dev/null

# ---- FFmpeg
cd "$WORK"
git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git ffmpeg
cd ffmpeg
./configure \
  --prefix="$PREFIX" --target-os=mingw32 --arch=x86_64 --cross-prefix=$HOST- --enable-cross-compile \
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug \
  --disable-ffplay --disable-ffprobe --disable-swscale --disable-avdevice --disable-hwaccels \
  --disable-x86asm --disable-pthreads --enable-w32threads \
  --enable-static --disable-shared --enable-version3 \
  --enable-libmp3lame \
  --enable-protocol=file,pipe,subfile,concat \
  --enable-demuxer=mov,matroska,mpegts,aac,mp3,ogg,flac,wav,ac3,eac3,webvtt,srt,concat,flv,m4v,h264,hevc \
  --enable-muxer=mp4,ipod,mov,matroska,webm,mp3,mpegts,adts,ogg,opus,flac,wav,null \
  --enable-decoder=aac,aac_latm,opus,vorbis,mp3,mp3float,flac,ac3,eac3,pcm_s16le,pcm_s24le,pcm_f32le,alac \
  --enable-encoder=libmp3lame \
  --enable-parser=h264,hevc,av1,vp8,vp9,aac,aac_latm,opus,vorbis,mpegaudio,flac,ac3 \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,vp9_superframe,av1_frame_merge,av1_frame_split,dump_extradata,setts,null \
  --enable-filter=aresample,aformat,anull,null,format,abuffer,abuffersink,buffer,buffersink,atrim,trim,volume,copy,acopy \
  --enable-swresample \
  --extra-cflags="-I$PREFIX/include -O2" --extra-ldflags="-L$PREFIX/lib -static" --pkg-config-flags=--static \
  >"$WORK/configure.log" || { tail -40 "$WORK/configure.log"; exit 1; }
make -j"$(nproc)" >/dev/null
$HOST-strip ffmpeg.exe
cp ffmpeg.exe "$OUT/ffmpeg.exe"
cp COPYING.LGPLv3 "$OUT/ffmpeg-LICENSE.txt"
cp "$WORK/lame-${LAME_VERSION}/COPYING" "$OUT/lame-COPYING.txt"
echo "FFmpeg $FFMPEG_TAG (Mechano DM small build, LGPL) + LAME $LAME_VERSION" > "$OUT/ffmpeg-version.txt"
ls -l "$OUT"

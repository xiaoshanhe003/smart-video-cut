# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **剪口播** (video editing) Claude Code skill for processing video podcasts:
1. **Transcribe** audio using 火山引擎 (Volcengine) speech-to-text
2. **Analyze** oral errors (stumbles, pauses, repeated words, etc.)
3. **Review** via web interface for manual confirmation
4. **Generate** EDL file for DaVinci Resolve

## Scripts

| Script | Purpose |
|--------|---------|
| `volcengine_transcribe.sh` | Upload audio to Uguu.se, call Volcengine API for transcription |
| `generate_subtitles.js` | Convert Volcengine JSON to `subtitles_words.json` (word-level with timestamps) |
| `generate_review.js` | Generate review.html with audio player and delete segments UI |
| `review_server.js` | HTTP server serving review page, generates EDL on user confirmation |
| `smart_cut_video.py` | Smart video cutting with zero-crossing detection + fade in/out |
| `smart_edl.py` | EDL generation with zero-crossing optimization |

## Data Flow

```
Video → FFmpeg (extract audio) → Uguu.se (get public URL) → Volcengine API
    → subtitles_words.json → AI analysis → auto_selected.json
    → review.html → User review → delete_segments.json → EDL (DaVinci)
```

## Key Files

- `SKILL.md` - Complete skill documentation with step-by-step workflow
- `用户习惯/` - User preferences for error detection (9 rule files)

## Output Structure

```
output/YYYY-MM-DD_视频名/
├── 剪口播/
│   ├── 1_转录/     (audio.mp3, volcengine_result.json, subtitles_words.json)
│   ├── 2_分析/     (readable.txt, auto_selected.json, 口误分析.md)
│   └── 3_审核/     (review.html, delete_segments.json, 视频名_cut.edl)
└── 字幕/
```

## Configuration

Volcengine API key stored at: `~/.claude/skills/.env` with key `VOLCENGINE_API_KEY`

## Usage

```
用户: 帮我剪这个口播视频
用户: 处理一下这个视频
用户: 继续剪这个口播
用户: 继续审核上次那个视频
```

New run: follow SKILL.md steps 0-7.

Resume run: if the existing output already contains `1_转录/subtitles_words.json`, `1_转录/audio.mp3`, and `2_分析/auto_selected.json`, skip transcription and analysis, then start review with:

```bash
node /Users/xiaoshan/.claude/skills/剪口播/scripts/launch_review.js <video_path_or_review_dir> 8899
```

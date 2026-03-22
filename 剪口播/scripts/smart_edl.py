#!/usr/bin/env python3
"""
智能 EDL 生成器 - 过零点检测优化切分点

功能：
- 读取删除片段列表
- 提取音频并分析波形
- 对每个切分点进行过零点检测
- 生成优化后的 EDL 文件

用法: python smart_edl.py <video.mp4> <delete_segments.json> <output.edl> [search_ms]
"""

import argparse
import json
import subprocess
import tempfile
import os
import sys
import shutil
import re
import math
from typing import Optional

try:
    import numpy as np
    import soundfile as sf
except ImportError:
    print("请安装依赖: pip install soundfile numpy")
    sys.exit(1)


def get_video_duration(video_path: str) -> float:
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=duration:format=duration',
         '-of', 'json', f'file:{video_path}'],
        capture_output=True, text=True
    )
    payload = json.loads(result.stdout.strip() or '{}')
    stream_duration = float((payload.get('streams') or [{}])[0].get('duration') or 0)
    if stream_duration > 0:
        return stream_duration

    format_duration = float((payload.get('format') or {}).get('duration') or 0)
    if format_duration > 0:
        return format_duration

    raise ValueError(f"无法探测视频时长: {video_path}")


def get_video_fps(video_path: str) -> int:
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0',
         f'file:{video_path}'],
        capture_output=True, text=True
    )
    fps_str = result.stdout.strip()
    if '/' in fps_str:
        num, den = fps_str.split('/')
        return round(float(num) / float(den))
    return int(float(fps_str)) or 25


def extract_audio(video_path: str) -> str:
    audio_path = tempfile.mktemp(suffix='.wav')
    subprocess.run([
        'ffmpeg', '-y', '-i', f'file:{video_path}',
        '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1',
        f'file:{audio_path}'
    ], capture_output=True)
    return audio_path


def find_zero_crossing(samples: np.ndarray, target_pos: int, search_range: int = 2205) -> int:
    """
    在目标位置附近寻找最近的过零点

    Args:
        samples: 音频样本（单声道）
        target_pos: 目标位置（样本索引）
        search_range: 搜索范围（样本数），默认 2205 ≈ 50ms @ 44100Hz

    Returns:
        最近的过零点位置
    """
    start = max(0, target_pos - search_range)
    end = min(len(samples), target_pos + search_range)

    if start >= end:
        return target_pos

    segment = samples[start:end]
    signs = np.sign(segment)
    crossings = np.where(np.diff(signs))[0]

    if len(crossings) == 0:
        return target_pos

    distances = np.abs(crossings - (target_pos - start))
    best_idx = crossings[np.argmin(distances)]

    return start + best_idx


def seconds_to_timecode(seconds: float, fps: int) -> str:
    """秒数转 CMX 3600 时间码"""
    total_frames = round(seconds * fps)
    return frames_to_timecode(total_frames, fps)


def frames_to_timecode(total_frames: int, fps: int) -> str:
    total_frames = max(0, total_frames)
    frames = total_frames % fps
    total_seconds = total_frames // fps
    secs = total_seconds % 60
    mins = (total_seconds // 60) % 60
    hours = total_seconds // 3600
    return f"{hours:02d}:{mins:02d}:{secs:02d}:{frames:02d}"


def timecode_to_frames(timecode: Optional[str], fps: int) -> int:
    if not timecode or not re.match(r'^\d{2}:\d{2}:\d{2}:\d{2}$', timecode):
        return 0

    hours, mins, secs, frames = [int(part) for part in timecode.split(':')]
    return ((((hours * 60) + mins) * 60) + secs) * fps + frames


def get_source_timecode_start(video_path: str, fps: int) -> int:
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream_tags=timecode:format_tags=timecode',
         '-of', 'json', f'file:{video_path}'],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        return 0

    try:
        payload = json.loads(result.stdout.strip() or '{}')
    except json.JSONDecodeError:
        return 0

    stream_tag = ((payload.get('streams') or [{}])[0].get('tags') or {}).get('timecode')
    format_tag = (payload.get('format') or {}).get('tags', {}).get('timecode')
    return timecode_to_frames(stream_tag or format_tag, fps)


def seconds_to_frames(seconds: float, fps: int) -> int:
    return round(seconds * fps)


def normalize_keep_segments(keep_segments: list, duration: float, fps: int) -> list:
    duration_frames = max(0, math.floor(duration * fps + 1e-6))
    normalized = []

    for seg in keep_segments:
        start_frame = max(0, min(duration_frames, seconds_to_frames(seg['start'], fps)))
        end_frame = max(start_frame, min(duration_frames, seconds_to_frames(seg['end'], fps)))
        if end_frame > start_frame:
            normalized.append({
                'start_frame': start_frame,
                'end_frame': end_frame
            })

    return normalized


def smart_generate_edl(video_path: str, delete_segments: list, output_path: str,
                      search_ms: int = 50):
    """
    生成带过零点优化的 EDL

    Args:
        video_path: 视频文件路径
        delete_segments: 删除片段列表 [{"start": t1, "end": t2}, ...]
                         或保留片段列表 {"keepSegments": [...]}
        output_path: 输出 EDL 路径
        search_ms: 搜索范围（毫秒）
    """
    print(f"视频: {video_path}")

    # 检测是删除片段还是保留片段
    if isinstance(delete_segments, dict) and 'keepSegments' in delete_segments:
        # 收到的是保留片段，只优化边界
        keep_input = delete_segments['keepSegments']
        print(f"收到保留片段: {len(keep_input)} 个")
        use_keep_mode = True
    elif isinstance(delete_segments, dict) and 'deleteSegments' in delete_segments:
        # 收到的是删除片段，需要进行buffer+合并后优化
        delete_input = delete_segments['deleteSegments']
        optimize_keep = delete_segments.get('optimizeKeep', False)
        print(f"收到删除片段: {len(delete_input)} 个, optimizeKeep={optimize_keep}")
        use_keep_mode = False
        if optimize_keep:
            mode = "buffer+合并后优化"
            print(f"模式: {mode}")
        else:
            mode = "原有逻辑"
            print(f"模式: {mode}")
    else:
        # 兼容旧的直接数组格式
        use_keep_mode = False
        optimize_keep = False

    # 获取视频参数
    duration = get_video_duration(video_path)
    fps = get_video_fps(video_path)
    print(f"时长: {duration:.2f}s, 帧率: {fps}fps")

    # 提取音频
    audio_path = extract_audio(video_path)
    print("提取音频...")

    try:
        samples, sr = sf.read(audio_path)
        print(f"采样率: {sr}Hz, 样本数: {len(samples)}")

        # 转单声道
        if len(samples.shape) > 1:
            samples = np.mean(samples, axis=1)

        # 搜索范围
        search_samples = int(search_ms * sr / 1000)

        if use_keep_mode:
            # 模式1：直接使用保留片段，只优化边界到过零点
            keep_segments = []
            for seg in keep_input:
                start_sample = int(seg['start'] * sr)
                optimal_start = find_zero_crossing(samples, start_sample, search_samples)
                optimal_start_time = optimal_start / sr

                end_sample = int(seg['end'] * sr)
                optimal_end = find_zero_crossing(samples, end_sample, search_samples)
                optimal_end_time = optimal_end / sr

                keep_segments.append({
                    'start': optimal_start_time,
                    'end': optimal_end_time
                })
        elif optimize_keep:
            # 模式3：buffer+合并后优化（与一般EDL相同的删除处理，但优化保留片段边界）
            BUFFER_SEC = 0.05
            GAP_THRESHOLD = 0.3

            # 扩展buffer
            expanded = []
            for seg in delete_input:
                expanded.append({
                    'start': max(0, seg['start'] - BUFFER_SEC),
                    'end': min(duration, seg['end'] + BUFFER_SEC)
                })

            # 排序并合并
            expanded = sorted(expanded, key=lambda x: x['start'])
            merged = []
            for seg in expanded:
                if merged and seg['start'] <= merged[-1]['end'] + GAP_THRESHOLD:
                    merged[-1]['end'] = max(merged[-1]['end'], seg['end'])
                else:
                    merged.append(seg.copy())

            print(f"合并后删除片段: {len(merged)} 个")

            # 计算保留片段并优化边界到过零点
            keep_segments = []
            cursor = 0.0

            for seg in merged:
                if seg['start'] > cursor:
                    # 优化开始点（保留段起点）
                    start_sample = int(cursor * sr)
                    optimal_start = find_zero_crossing(samples, start_sample, search_samples)
                    optimal_start_time = optimal_start / sr

                    # 优化结束点（删除段起点，即保留段终点）
                    end_sample = int(seg['start'] * sr)
                    optimal_end = find_zero_crossing(samples, end_sample, search_samples)
                    optimal_end_time = optimal_end / sr

                    keep_segments.append({
                        'start': optimal_start_time,
                        'end': optimal_end_time
                    })

                cursor = seg['end']

            # 最后一段
            if cursor < duration:
                start_sample = int(cursor * sr)
                optimal_start = find_zero_crossing(samples, start_sample, search_samples)
                optimal_start_time = optimal_start / sr

                end_sample = int(duration * sr)
                optimal_end = find_zero_crossing(samples, end_sample, search_samples)
                optimal_end_time = optimal_end / sr

                keep_segments.append({
                    'start': optimal_start_time,
                    'end': optimal_end_time
                })
        else:
            # 模式2：重新计算保留片段（原有逻辑）
            # 排序并合并删除片段
            GAP_THRESHOLD = 0.3
            delete_segments = sorted(delete_segments, key=lambda x: x['start'])
            merged = []
            for seg in delete_segments:
                if merged and seg['start'] <= merged[-1]['end'] + GAP_THRESHOLD:
                    merged[-1]['end'] = max(merged[-1]['end'], seg['end'])
                else:
                    merged.append(seg.copy())

            print(f"删除片段: {len(merged)} 个")

            # 计算保留片段（优化切分点）
            keep_segments = []
            cursor = 0.0

            for seg in merged:
                if seg['start'] > cursor:
                    # 优化开始点（删除段的起点 = 保留段的终点）
                    start_sample = int(seg['start'] * sr)
                    optimal_start = find_zero_crossing(samples, start_sample, search_samples)
                    optimal_start_time = optimal_start / sr

                    # 优化结束点（删除段的终点 = 保留段的下个起点）
                    end_sample = int(seg['end'] * sr)
                    optimal_end = find_zero_crossing(samples, end_sample, search_samples)
                    optimal_end_time = optimal_end / sr

                    keep_segments.append({
                        'start': optimal_start_time,
                        'end': optimal_end_time
                    })

                cursor = seg['end']

            # 最后一段
            if cursor < duration:
                end_sample = int(duration * sr)
                optimal_end = find_zero_crossing(samples, end_sample, search_samples)
                optimal_end_time = optimal_end / sr
                keep_segments.append({
                    'start': cursor,
                    'end': optimal_end_time
                })

    finally:
        # 清理临时音频
        if os.path.exists(audio_path):
            os.remove(audio_path)

    print(f"保留片段: {len(keep_segments)} 个")

    # 生成 EDL
    title = os.path.splitext(os.path.basename(video_path))[0]
    reel_name = re.sub(r'[^A-Z0-9_]', '_', title[:8].upper())
    source_tc_start_frames = get_source_timecode_start(video_path, fps)
    normalized_keep_segments = normalize_keep_segments(keep_segments, duration, fps)

    edl = f"TITLE: {title}\nFCM: NON-DROP FRAME\n\n"

    record_frames = 0
    for i, seg in enumerate(normalized_keep_segments):
        event_num = f"{i+1:03d}"
        src_in = frames_to_timecode(source_tc_start_frames + seg['start_frame'], fps)
        src_out = frames_to_timecode(source_tc_start_frames + seg['end_frame'], fps)
        rec_in = frames_to_timecode(record_frames, fps)
        record_frames += seg['end_frame'] - seg['start_frame']
        rec_out = frames_to_timecode(record_frames, fps)

        edl += f"{event_num}  {reel_name:<8}  V     C        {src_in} {src_out} {rec_in} {rec_out}\n"

    # 写入文件
    with open(output_path, 'w') as f:
        f.write(edl)

    print(f"✅ EDL 已生成: {output_path}")
    print(f"   原始时长: {duration:.2f}s")
    print(f"   保留时长: {record_frames / fps:.2f}s")
    print(f"   删除时长: {duration - (record_frames / fps):.2f}s")


def main():
    parser = argparse.ArgumentParser(description='智能 EDL 生成器 - 过零点优化')
    parser.add_argument('video', help='视频文件')
    parser.add_argument('delete_json', help='删除片段 JSON 文件')
    parser.add_argument('output', help='输出 EDL 文件')
    parser.add_argument('--search-ms', type=int, default=50,
                        help='过零点搜索范围（毫秒，默认50）')

    args = parser.parse_args()

    with open(args.delete_json, 'r') as f:
        delete_segments = json.load(f)

    smart_generate_edl(args.video, delete_segments, args.output, args.search_ms)


if __name__ == '__main__':
    main()

"""Generate responsive photos with macOS sips and FFmpeg (libsvtav1).

Run: python3 scripts/optimize-images.py
Originals stay outside public/ so they are never copied into the deployment.
"""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'assets/originals'
OUTPUT = ROOT / 'public/images'


def run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for original in sorted(SOURCE.glob('*.jpg')):
        widths = (480, 960, 1600) if original.stem == 'cover' else (320, 640, 960, 1600)
        for width in widths:
            filename = OUTPUT / f'{original.stem}-{width}'
            run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '78',
                 '--resampleWidth', str(width), str(original), '--out', str(filename) + '.jpg'])
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(original),
                 '-vf', f'scale={width}:-2', '-frames:v', '1', '-map_metadata', '-1',
                 '-c:v', 'libsvtav1', '-crf', '28', '-preset', '6', '-pix_fmt', 'yuv420p',
                 '-svtav1-params', 'still-picture=1', '-y', str(filename) + '.avif'])
        print(f'{original.name}: generated {len(widths)} sizes in AVIF and JPEG')


if __name__ == '__main__':
    main()

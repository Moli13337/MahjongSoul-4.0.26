#!/usr/bin/env python3
"""
MahjongSoul Private Server - Bundle Hash Generator
====================================================
Generates bundle_hash.txt from the game client's AssetBundle files.

The client uses bundle_hash.txt to determine which bundles exist and
whether they need updating. This script scans the game's StreamingAssets
directory and generates the hash file so the resource server can serve it.

Usage:
    python generate_bundle_hash.py <game_directory>
    python generate_bundle_hash.py "D:\\Games\\Jantama_MahjongSoul"
    python generate_bundle_hash.py <game_directory> -o output.txt

The game directory should contain:
    Jantama_MahjongSoul_Data/StreamingAssets/StandaloneWindows/*.majset
"""

import hashlib
import sys
import argparse
from pathlib import Path

def generate_bundle_hash(game_dir, output_path=None):
    """Generate bundle_hash.txt from game's .majset files.

    Args:
        game_dir: Path to the game directory (containing Jantama_MahjongSoul_Data)
        output_path: Where to write bundle_hash.txt (default: server's public dir)
    """
    game_dir = Path(game_dir).resolve()
    streaming_dir = game_dir / "Jantama_MahjongSoul_Data" / "StreamingAssets" / "StandaloneWindows"

    if not streaming_dir.exists():
        # Try ABM-Fold variant
        streaming_dir = game_dir / "Jantama_MahjongSoul_Data" / "StreamingAssets" / "ABM-Fold" / "StandaloneWindows"

    if not streaming_dir.exists():
        print(f"[ERROR] StreamingAssets/StandaloneWindows not found in: {game_dir}")
        print(f"        Looked at: {game_dir / 'Jantama_MahjongSoul_Data' / 'StreamingAssets' / 'StandaloneWindows'}")
        return False

    print(f"[1/2] Scanning AssetBundle files in: {streaming_dir}")

    entries = []
    majset_files = sorted(streaming_dir.glob("*.majset"))

    if not majset_files:
        print(f"[ERROR] No .majset files found in: {streaming_dir}")
        return False

    for f in majset_files:
        name = f.stem  # filename without .majset extension
        size = f.stat().st_size

        # Extract original hash from filename (format: $prefix_hash.majset)
        parts = name.rsplit("_", 1)
        if len(parts) == 2:
            original_hash = parts[1]
        else:
            original_hash = ""

        # Format: bundle_name|hash|size
        entries.append(f"{name}|{original_hash}|{size}")

    print(f"  Found {len(entries)} files")

    # Determine output path
    if output_path is None:
        # Default: write to server's public directory
        script_dir = Path(__file__).parent
        output_path = script_dir.parent / "server" / "public" / "app" / "v3" / "release" / "ab" / "StandaloneWindows" / "bundle_hash.txt"

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    content = "\n".join(entries) + "\n"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"[2/2] Written {len(entries)} entries to: {output_path}")
    print(f"      File size: {len(content)} bytes")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="MahjongSoul Private Server - Bundle Hash Generator"
    )
    parser.add_argument("game_dir", type=str,
                        help="Game directory (containing Jantama_MahjongSoul_Data)")
    parser.add_argument("-o", "--output", type=str, default=None,
                        help="Output path for bundle_hash.txt (default: server/public/...)")

    args = parser.parse_args()

    success = generate_bundle_hash(args.game_dir, args.output)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())

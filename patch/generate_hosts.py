#!/usr/bin/env python3
"""
MahjongSoul Private Server - Hosts File Generator
===================================================
Generates a hosts file snippet that redirects game domains to 127.0.0.1.

Usage:
    python generate_hosts.py                  # Print to stdout
    python generate_hosts.py -o hosts.txt     # Write to file
    python generate_hosts.py --install        # Install to system hosts (needs admin)
    python generate_hosts.py --uninstall      # Remove from system hosts (needs admin)

The generated hosts entries redirect all MahjongSoul game domains to the
local private server, so the game client connects to 127.0.0.1 instead of
the official servers.
"""

import os
import sys
import platform
import argparse
from pathlib import Path

# ============================================================================
# Domains to redirect to 127.0.0.1
# ============================================================================

REDIRECT_DOMAINS = [
    # Official game servers
    "mjusgs.mahjongsoul.com",
    "game.mahjongsoul.com",
    # maj-soul.com routes
    "game.maj-soul.com",
    "route-2.maj-soul.com",
    "route-3.maj-soul.com",
    "route-4.maj-soul.com",
    "route-5.maj-soul.com",
    "route-6.maj-soul.com",
    "www.maj-soul.com",
    # CDN and common resources
    "common-202411.maj-soul.com",
    "record-old.maj-soul.com",
    "contest-gate-202411.maj-soul.com",
    # Update servers
    "app-update-1.catmajsoul.com",
    "app-update-1.catmjstudio.com",
    "app-update-2.catmjstudio.com",
]

PRIVATE_SERVER_IP = "127.0.0.1"

# Marker comments for easy identification/removal
MARKER_START = "# >>> MahjongSoul Private Server - DO NOT EDIT >>>"
MARKER_END = "# <<< MahjongSoul Private Server <<<"

# ============================================================================
# Generation
# ============================================================================

def generate_hosts_entries():
    """Generate the hosts file entries as a string."""
    lines = [MARKER_START]
    for domain in REDIRECT_DOMAINS:
        lines.append(f"{PRIVATE_SERVER_IP}  {domain}")
    lines.append(MARKER_END)
    return "\n".join(lines)


def generate_hosts_file_content():
    """Generate a complete hosts file snippet (with surrounding context)."""
    return f"""
{generate_hosts_entries()}
"""

# ============================================================================
# Install / Uninstall
# ============================================================================

def get_hosts_path():
    """Get the system hosts file path."""
    if platform.system() == "Windows":
        return Path(r"C:\Windows\System32\drivers\etc\hosts")
    else:
        return Path("/etc/hosts")


def check_admin():
    """Check if we have admin/root privileges."""
    if platform.system() == "Windows":
        try:
            import ctypes
            return ctypes.windll.shell32.IsUserAnAdmin() != 0
        except:
            return False
    else:
        return os.geteuid() == 0


def install_to_hosts():
    """Install the hosts entries to the system hosts file."""
    hosts_path = get_hosts_path()

    if not check_admin():
        print("[ERROR] Administrator/root privileges required to modify hosts file!")
        if platform.system() == "Windows":
            print("        Right-click your terminal and 'Run as Administrator'")
        else:
            print("        Run with: sudo python generate_hosts.py --install")
        return False

    # Read current hosts
    try:
        with open(hosts_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"[ERROR] Cannot read hosts file: {e}")
        return False

    # Check if already installed
    if MARKER_START in content:
        print("[INFO] Hosts entries already installed. Removing old entries first...")
        content = uninstall_from_content(content)

    # Append new entries
    new_content = content.rstrip() + "\n" + generate_hosts_file_content() + "\n"

    # Backup
    backup_path = hosts_path.parent / "hosts.bak.mahjongsoul"
    if not backup_path.exists():
        import shutil
        shutil.copy2(hosts_path, backup_path)
        print(f"[OK] Backup created: {backup_path}")

    # Write
    try:
        with open(hosts_path, "w", encoding="utf-8") as f:
            f.write(new_content)
    except PermissionError:
        print("[ERROR] Permission denied. Run as Administrator/root.")
        return False

    print(f"[OK] {len(REDIRECT_DOMAINS)} domain redirects installed to {hosts_path}")
    return True


def uninstall_from_content(content):
    """Remove MahjongSoul entries from hosts content string."""
    lines = content.split("\n")
    result = []
    in_block = False
    for line in lines:
        if line.strip() == MARKER_START:
            in_block = True
            continue
        if line.strip() == MARKER_END:
            in_block = False
            continue
        if not in_block:
            result.append(line)
    return "\n".join(result)


def uninstall_from_hosts():
    """Remove MahjongSoul entries from the system hosts file."""
    hosts_path = get_hosts_path()

    if not check_admin():
        print("[ERROR] Administrator/root privileges required!")
        return False

    try:
        with open(hosts_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"[ERROR] Cannot read hosts file: {e}")
        return False

    if MARKER_START not in content:
        print("[INFO] No MahjongSoul entries found in hosts file.")
        return True

    new_content = uninstall_from_content(content)

    try:
        with open(hosts_path, "w", encoding="utf-8") as f:
            f.write(new_content)
    except PermissionError:
        print("[ERROR] Permission denied. Run as Administrator/root.")
        return False

    print(f"[OK] MahjongSoul entries removed from {hosts_path}")
    return True

# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="MahjongSoul Private Server - Hosts File Generator"
    )
    parser.add_argument("-o", "--output", type=str,
                        help="Output file path (default: stdout)")
    parser.add_argument("--install", action="store_true",
                        help="Install entries to system hosts file (needs admin)")
    parser.add_argument("--uninstall", action="store_true",
                        help="Remove entries from system hosts file (needs admin)")
    parser.add_argument("--list", action="store_true",
                        help="List all redirect domains")

    args = parser.parse_args()

    if args.list:
        print(f"Domains redirected to {PRIVATE_SERVER_IP}:")
        for i, domain in enumerate(REDIRECT_DOMAINS, 1):
            print(f"  {i:2d}. {domain}")
        return 0

    if args.uninstall:
        return 0 if uninstall_from_hosts() else 1

    if args.install:
        return 0 if install_to_hosts() else 1

    # Default: generate and output
    content = generate_hosts_file_content()

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"[OK] Hosts entries written to: {args.output}")
        print(f"     {len(REDIRECT_DOMAINS)} domains redirected to {PRIVATE_SERVER_IP}")
    else:
        print(content)

    return 0


if __name__ == "__main__":
    sys.exit(main())

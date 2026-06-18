#!/usr/bin/env python3
r"""
MahjongSoul Private Server - One-Click Client Patcher
=====================================================
Usage:
    python patch_all.py <game_directory>

Example:
    python patch_all.py "D:\Games\Jantama_MahjongSoul"

This script applies ALL necessary patches to make the game client
connect to a local private server instead of the official servers.

Patches applied:
  1. GameAssembly.dll  - 8 binary patches (Steam API bypass)
  2. steam_api.dll     - Replace with stub DLL (no-op Steam API)
  3. RuntimeInitializeOnLoads.json - Remove SteamManager auto-init
  4. ScriptingAssemblies.json - Remove Steamworks.NET reference
  5. config.json in .majset - Redirect gateway URLs to localhost
  6. Windows hosts file - Redirect game domains to 127.0.0.1
"""

import os
import sys
import json
import shutil
import struct
import platform
from pathlib import Path

# ============================================================================
# Configuration
# ============================================================================

PRIVATE_SERVER_HOST = "127.0.0.1"
LOBBY_PORT = 8441
GAME_PORT = 8443
GATEWAY_PROXY_PORT = 8080
RESOURCE_PORT = 8440

# Domains to redirect in hosts file
REDIRECT_DOMAINS = [
    "mjusgs.mahjongsoul.com",
    "game.mahjongsoul.com",
    "game.maj-soul.com",
    "route-2.maj-soul.com",
    "route-3.maj-soul.com",
    "route-4.maj-soul.com",
    "route-5.maj-soul.com",
    "route-6.maj-soul.com",
    "www.maj-soul.com",
    "common-202411.maj-soul.com",
    "record-old.maj-soul.com",
    "contest-gate-202411.maj-soul.com",
    "app-update-1.catmajsoul.com",
    "app-update-1.catmjstudio.com",
    "app-update-2.catmjstudio.com",
]

# ============================================================================
# Color output helpers
# ============================================================================

class Colors:
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    END = "\033[0m"

def info(msg):
    print(f"{Colors.CYAN}[INFO]{Colors.END} {msg}")

def ok(msg):
    print(f"{Colors.GREEN}[OK]{Colors.END} {msg}")

def warn(msg):
    print(f"{Colors.YELLOW}[WARN]{Colors.END} {msg}")

def error(msg):
    print(f"{Colors.RED}[ERROR]{Colors.END} {msg}")

def header(msg):
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*60}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.CYAN} {msg}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.CYAN}{'='*60}{Colors.END}\n")

# ============================================================================
# Patch 1: GameAssembly.dll binary patches (8 patches)
# ============================================================================

# Each patch: (name, RVA, replacement_bytes, description)
DLL_PATCHES = [
    ("DllCheck.Test()",              0x5BBCB0, b"\xB0\x01\xC3",
     "Return true - bypass DLL integrity check"),
    ("Packsize.Test()",              0xC8E5F0, b"\xB0\x01\xC3",
     "Return true - bypass pack size validation"),
    ("SteamAPI.Init()",              0xC8F520, b"\xB0\x01\xC3",
     "Return true - Steam init always succeeds"),
    ("SteamAPI.RestartAppIfNecessary()", 0xC8B530, b"\x30\xC0\xC3",
     "Return false - prevent game restart via Steam"),
    ("InteropHelp.TestIfAvailableClient()", 0xC6DB40, b"\xC3",
     "Immediate return - skip Steamworks init check"),
    ("InteropHelp.TestIfAvailableGameServer()", 0xC6DBD0, b"\xC3",
     "Immediate return - skip Steamworks init check (server)"),
    ("GamePlatformInfo.IsSteam()",   0x5BBF00, b"\x30\xC0\xC3",
     "Return false - prevent SteamUtils.GetIPCountry() crash"),
    ("SteamManager.Initialized.get", 0x39F930, b"\x30\xC0\xC3",
     "Return false - Lua Tools.IsSteam() returns false"),
]

def patch_game_assembly(game_dir):
    """Apply 8 binary patches to GameAssembly.dll"""
    header("Patch 1/6: GameAssembly.dll Binary Patches")

    dll_path = game_dir / "GameAssembly.dll"
    backup_path = game_dir / "GameAssembly.dll.original"

    if not dll_path.exists():
        error(f"GameAssembly.dll not found at: {dll_path}")
        return False

    # Create backup if not exists
    if not backup_path.exists():
        info(f"Creating backup: GameAssembly.dll -> GameAssembly.dll.original")
        shutil.copy2(dll_path, backup_path)
    else:
        info(f"Restoring from backup before patching...")
        shutil.copy2(backup_path, dll_path)

    try:
        import pefile
    except ImportError:
        error("pefile module not found. Install: pip install pefile")
        return False

    pe = pefile.PE(str(dll_path))
    image_base = pe.OPTIONAL_HEADER.ImageBase

    with open(dll_path, "r+b") as f:
        for i, (name, rva, patch_bytes, desc) in enumerate(DLL_PATCHES, 1):
            file_offset = pe.get_offset_from_rva(rva)
            f.seek(file_offset)
            original = f.read(len(patch_bytes))
            f.seek(file_offset)
            f.write(patch_bytes)
            ok(f"  [{i}/8] {name}")
            info(f"        RVA: 0x{rva:X}, Offset: 0x{file_offset:X}")
            info(f"        Original: {original.hex(' ')}")
            info(f"        Patched:  {patch_bytes.hex(' ')}")
            info(f"        {desc}")

    pe.close()
    ok("GameAssembly.dll patched successfully!\n")
    return True

# ============================================================================
# Patch 2: Build and replace steam_api.dll with stub
# ============================================================================

def patch_steam_api_dll(game_dir):
    """Build stub steam_api.dll and replace original"""
    header("Patch 2/6: steam_api.dll Stub Replacement")

    plugins_dir = game_dir / "Jantama_MahjongSoul_Data" / "Plugins" / "x86"
    dll_path = plugins_dir / "steam_api.dll"
    backup_path = plugins_dir / "steam_api.dll.original"

    if not dll_path.exists():
        error(f"steam_api.dll not found at: {dll_path}")
        return False

    # Create backup if not exists
    if not backup_path.exists():
        info(f"Creating backup: steam_api.dll -> steam_api.dll.original")
        shutil.copy2(dll_path, backup_path)
    else:
        info(f"Backup already exists: steam_api.dll.original")

    # Build stub DLL
    script_dir = Path(__file__).parent
    stub_builder = script_dir / "build_steam_stub_v5.py"

    if stub_builder.exists():
        info(f"Building stub DLL using build_steam_stub_v5.py...")

        # Modify the script to use the correct paths
        # We'll call it as a subprocess with modified paths
        import subprocess
        result = subprocess.run([
            sys.executable, str(stub_builder),
            "--input", str(backup_path),
            "--output", str(dll_path)
        ], capture_output=True, text=True)

        if result.returncode == 0:
            ok("Stub steam_api.dll built and installed!")
            return True
        else:
            warn(f"Stub builder failed, trying inline build...")
            warn(result.stderr)
    else:
        warn(f"build_steam_stub_v5.py not found, building inline...")

    # Inline stub builder (fallback)
    return build_stub_dll_inline(backup_path, dll_path)

def build_stub_dll_inline(original_path, output_path):
    """Build a minimal stub steam_api.dll in pure Python"""
    try:
        import pefile
    except ImportError:
        error("pefile module not found. Install: pip install pefile")
        return False

    info("Reading export names from original DLL...")
    pe = pefile.PE(str(original_path))

    if not hasattr(pe, 'DIRECTORY_ENTRY_EXPORT'):
        error("Original DLL has no exports!")
        pe.close()
        return False

    # Collect all export names
    export_names = sorted([exp.name.decode('ascii') for exp in pe.DIRECTORY_ENTRY_EXPORT.symbols if exp.name])
    pe.close()

    info(f"Found {len(export_names)} exports in original DLL")

    # Functions that should return TRUE (1)
    RETURN_TRUE = {
        "SteamAPI_Init", "SteamAPI_InitSafe", "SteamAPI_IsSteamRunning",
    }

    # Functions that should return FALSE (0)
    RETURN_FALSE = {
        "SteamAPI_RestartAppIfNecessary",
    }

    # Generate code for each function
    BOOL_CODE = b"\xB8\x01\x00\x00\x00\xC3"  # mov eax, 1; ret
    ZERO_CODE = b"\x31\xC0\xC3"               # xor eax, eax; ret

    code_blocks = []
    name_to_offset = {}

    for name in export_names:
        if name in RETURN_TRUE or name.startswith("BIs") or name.startswith("BHas") or name.startswith("BLogged"):
            code = BOOL_CODE
        elif name in RETURN_FALSE:
            code = ZERO_CODE
        else:
            code = ZERO_CODE

        name_to_offset[name] = sum(len(c) for _, c in code_blocks)
        code_blocks.append((name, code))

    # Build code section
    code_section = b"".join(c for _, c in code_blocks)

    # Build name strings
    name_strings = b""
    name_str_offsets = {}
    for name in export_names:
        name_str_offsets[name] = len(name_strings)
        name_strings += name.encode('ascii') + b'\x00'

    # Build export directory
    num_exports = len(export_names)

    # PE structure constants
    IMAGE_BASE = 0x10000000
    SECTION_ALIGNMENT = 0x1000
    FILE_ALIGNMENT = 0x200

    # Calculate sizes
    code_size = len(code_section)
    names_size = len(name_strings)

    # Export directory structure (40 bytes)
    # + name pointer table (4 * num_exports)
    # + ordinal table (2 * num_exports)
    # + export address table (4 * num_exports)
    # + DLL name string

    dll_name = b"steam_api.dll\x00"
    export_dir_size = 40
    name_ptr_size = 4 * num_exports
    ordinal_size = 2 * num_exports
    eat_size = 4 * num_exports
    dll_name_size = len(dll_name)

    total_export_data = export_dir_size + name_ptr_size + ordinal_size + eat_size + dll_name_size

    # Layout in .text section:
    # [code] [export_dir] [name_ptrs] [ordinals] [eat] [dll_name] [name_strings]
    total_section_data = code_size + total_export_data + names_size

    # Align section size
    section_raw_size = ((total_section_data + FILE_ALIGNMENT - 1) // FILE_ALIGNMENT) * FILE_ALIGNMENT
    section_virtual_size = ((total_section_data + SECTION_ALIGNMENT - 1) // SECTION_ALIGNMENT) * SECTION_ALIGNMENT

    # Offsets within section
    export_dir_offset = code_size
    name_ptr_offset = export_dir_offset + export_dir_size
    ordinal_offset = name_ptr_offset + name_ptr_size
    eat_offset = ordinal_offset + ordinal_size
    dll_name_offset = eat_offset + eat_size
    name_strings_offset = dll_name_offset + dll_name_size

    # RVA of export directory
    export_dir_rva = SECTION_ALIGNMENT  # .text starts at RVA 0x1000

    # Build name pointer table and ordinal table
    name_ptr_data = b""
    ordinal_data = b""
    eat_data = b""

    for i, name in enumerate(export_names):
        # Name pointer (RVA of name string)
        name_rva = SECTION_ALIGNMENT + name_strings_offset + name_str_offsets[name]
        name_ptr_data += struct.pack("<I", name_rva)
        # Ordinal (sequential)
        ordinal_data += struct.pack("<H", i)
        # Export address table (RVA of function code)
        func_rva = SECTION_ALIGNMENT + name_to_offset[name]
        eat_data += struct.pack("<I", func_rva)

    # Build export directory
    export_dir = struct.pack("<IIHHIIIIIII",
        0,                          # Characteristics
        0,                          # TimeDateStamp
        0, 0,                       # Major/Minor version
        SECTION_ALIGNMENT + dll_name_offset,  # Name RVA
        1,                          # Ordinal base
        num_exports,                # NumberOfFunctions
        num_exports,                # NumberOfNames
        SECTION_ALIGNMENT + eat_offset,       # AddressOfFunctions
        SECTION_ALIGNMENT + name_ptr_offset,  # AddressOfNames
        SECTION_ALIGNMENT + ordinal_offset,   # AddressOfNameOrdinals
    )

    # Assemble section data
    section_data = (
        code_section +
        export_dir +
        name_ptr_data +
        ordinal_data +
        eat_data +
        dll_name +
        name_strings
    )

    # Pad to raw size
    section_data += b'\x00' * (section_raw_size - len(section_data))

    # Build import directory (minimal - just ExitProcess from kernel32.dll)
    # kernel32.dll string
    kernel32_name = b"kernel32.dll\x00"
    exitprocess_name = b"ExitProcess\x00"
    iat_thunk = struct.pack("<I", 0)  # Will be filled with hint/name RVA

    # Import directory entry (20 bytes) + null terminator (20 bytes)
    # ILT (Import Lookup Table) - 4 bytes + null (4 bytes)
    # IAT (Import Address Table) - 4 bytes + null (4 bytes)
    # Hint/Name - 2 bytes hint + "ExitProcess\0" (13 bytes) = 15 bytes

    # We'll put imports in a separate .rdata section for simplicity
    # Actually, let's just skip imports - the stub doesn't call any imports

    # Build PE headers
    # DOS Header (64 bytes)
    dos_header = bytearray(64)
    dos_header[0:2] = b'MZ'
    struct.pack_into("<I", dos_header, 60, 64)  # e_lfanew

    # PE Signature
    pe_sig = b'PE\x00\x00'

    # COFF Header (20 bytes)
    coff_header = struct.pack("<HHIHHH",
        0x14C,              # Machine (i386)
        1,                  # NumberOfSections
        0,                  # TimeDateStamp
        0,                  # PointerToSymbolTable
        0,                  # NumberOfSymbols
        0xE0,               # SizeOfOptionalHeader
        0x2102,             # Characteristics (DLL | EXECUTABLE_IMAGE | 32BIT)
    )

    # Optional Header (224 bytes for PE32)
    size_of_headers = ((64 + 4 + 20 + 224 + 40 + 0) // FILE_ALIGNMENT + 1) * FILE_ALIGNMENT

    optional_header = struct.pack("<HBBIIIIIIIIIIIIIIIIIIIIIIIIIIII",
        0x10B,              # Magic (PE32)
        14,                 # MajorLinkerVersion
        0,                  # MinorLinkerVersion
        section_raw_size,   # SizeOfCode
        0,                  # SizeOfInitializedData
        0,                  # SizeOfUninitializedData
        SECTION_ALIGNMENT,  # AddressOfEntryPoint
        SECTION_ALIGNMENT,  # BaseOfCode
        0,                  # BaseOfData
        IMAGE_BASE,         # ImageBase
        SECTION_ALIGNMENT,  # SectionAlignment
        FILE_ALIGNMENT,     # FileAlignment
        6,                  # MajorOperatingSystemVersion
        0,                  # MinorOperatingSystemVersion
        0,                  # MajorImageVersion
        0,                  # MinorImageVersion
        6,                  # MajorSubsystemVersion
        0,                  # MinorSubsystemVersion
        0,                  # Win32VersionValue
        SECTION_ALIGNMENT + section_virtual_size,  # SizeOfImage
        size_of_headers,    # SizeOfHeaders
        0,                  # CheckSum
        3,                  # Subsystem (WINDOWS_CUI)
        0x8160,             # DllCharacteristics
        0x100000,           # SizeOfStackReserve
        0x1000,             # SizeOfStackCommit
        0x100000,           # SizeOfHeapReserve
        0x1000,             # SizeOfHeapCommit
        0,                  # LoaderFlags
        16,                 # NumberOfRvaAndSizes
    )

    # Data directories (16 entries, 8 bytes each)
    data_dirs = b'\x00' * (16 * 8)
    # Set export directory
    data_dirs = struct.pack("<II", export_dir_rva, export_dir_size) + data_dirs[8:]
    # Import directory (entry 1) - set to 0 (no imports)

    optional_header += data_dirs

    # Section header (40 bytes)
    section_header = struct.pack("<8sIIIIIIHHI",
        b'.text\x00\x00\x00',   # Name
        section_virtual_size,    # VirtualSize
        SECTION_ALIGNMENT,       # VirtualAddress
        section_raw_size,        # SizeOfRawData
        size_of_headers,         # PointerToRawData
        0,                       # PointerToRelocations
        0,                       # PointerToLinenumbers
        0,                       # NumberOfRelocations
        0,                       # NumberOfLinenumbers
        0x60000020,              # Characteristics (CODE | EXECUTE | READ)
    )

    # Assemble PE file
    headers = bytes(dos_header) + pe_sig + coff_header + optional_header + section_header
    headers += b'\x00' * (size_of_headers - len(headers))

    pe_data = headers + section_data

    with open(output_path, "wb") as f:
        f.write(pe_data)

    # Verify
    pe_verify = pefile.PE(str(output_path))
    verify_exports = len(pe_verify.DIRECTORY_ENTRY_EXPORT.symbols) if hasattr(pe_verify, 'DIRECTORY_ENTRY_EXPORT') else 0
    pe_verify.close()

    if verify_exports == num_exports:
        ok(f"Stub steam_api.dll built with {num_exports} exports!")
        return True
    else:
        error(f"Verification failed: expected {num_exports} exports, got {verify_exports}")
        return False

# ============================================================================
# Patch 3: RuntimeInitializeOnLoads.json - Remove SteamManager
# ============================================================================

def patch_runtime_init(game_data_dir):
    """Remove SteamManager from RuntimeInitializeOnLoads.json"""
    header("Patch 3/6: RuntimeInitializeOnLoads.json")

    json_path = game_data_dir / "RuntimeInitializeOnLoads.json"
    backup_path = game_data_dir / "RuntimeInitializeOnLoads.json.bak"

    if not json_path.exists():
        warn(f"RuntimeInitializeOnLoads.json not found, skipping")
        return True

    # Backup
    if not backup_path.exists():
        shutil.copy2(json_path, backup_path)
        info(f"Backup created: RuntimeInitializeOnLoads.json.bak")

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    original_count = len(data)
    data = [item for item in data
            if not (item.get("className") == "SteamManager"
                    and item.get("methodName") == "InitOnPlayMode")]

    removed = original_count - len(data)
    if removed > 0:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
        ok(f"Removed {removed} SteamManager entry/entries")
    else:
        info("No SteamManager entries found (already patched)")

    return True

# ============================================================================
# Patch 4: ScriptingAssemblies.json - Remove Steamworks.NET
# ============================================================================

def patch_scripting_assemblies(game_data_dir):
    """Remove Steamworks.NET from ScriptingAssemblies.json"""
    header("Patch 4/6: ScriptingAssemblies.json")

    json_path = game_data_dir / "ScriptingAssemblies.json"
    backup_path = game_data_dir / "ScriptingAssemblies.json.bak"

    if not json_path.exists():
        warn(f"ScriptingAssemblies.json not found, skipping")
        return True

    # Backup
    if not backup_path.exists():
        shutil.copy2(json_path, backup_path)
        info(f"Backup created: ScriptingAssemblies.json.bak")

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    target_dll = "com.rlabrecque.steamworks.net.dll"
    removed = False

    if "names" in data:
        original = len(data["names"])
        # Find index to remove
        indices_to_remove = []
        for i, name in enumerate(data["names"]):
            if name.lower() == target_dll.lower():
                indices_to_remove.append(i)

        if indices_to_remove:
            # Remove from names
            data["names"] = [n for i, n in enumerate(data["names"]) if i not in indices_to_remove]
            # Remove from types if exists
            if "types" in data and isinstance(data["types"], list):
                data["types"] = [t for i, t in enumerate(data["types"]) if i not in indices_to_remove]
            removed = True

    if removed:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
        ok(f"Removed Steamworks.NET DLL reference")
    else:
        info("Steamworks.NET not found (already patched)")

    return True

# ============================================================================
# Patch 5: config.json in .majset files - Redirect URLs
# ============================================================================

def patch_majset_config(game_data_dir):
    """Patch config.json inside .majset AssetBundle files"""
    header("Patch 5/6: config.json in .majset Files")

    try:
        import UnityPy
    except ImportError:
        error("UnityPy module not found. Install: pip install UnityPy")
        return False

    streaming_assets = game_data_dir / "StreamingAssets" / "StandaloneWindows"
    abm_fold = game_data_dir / "StreamingAssets" / "ABM-Fold" / "StandaloneWindows"

    search_dirs = []
    if streaming_assets.exists():
        search_dirs.append(streaming_assets)
    if abm_fold.exists():
        search_dirs.append(abm_fold)

    if not search_dirs:
        error("No StreamingAssets/StandaloneWindows directory found")
        return False

    target_url = f"http://{PRIVATE_SERVER_HOST}:{GATEWAY_PROXY_PORT}"
    patched_count = 0

    for search_dir in search_dirs:
        info(f"Scanning: {search_dir}")

        for majset_file in search_dir.glob("*.majset"):
            try:
                # Quick check if file contains gateway config
                with open(majset_file, "rb") as f:
                    raw = f.read(65536)  # Read first 64KB for quick check

                if b"gateways" not in raw:
                    continue
                if b"maj-soul.com" not in raw and b"127.0.0.1" not in raw:
                    continue

                info(f"  Found config in: {majset_file.name}")

                # Backup
                backup_path = majset_file.with_suffix(".majset.original_config")
                if not backup_path.exists():
                    shutil.copy2(majset_file, backup_path)
                    info(f"  Backup created: {backup_path.name}")

                # Load with UnityPy
                env = UnityPy.load(str(majset_file))
                modified = False

                for obj in env.objects:
                    if obj.type.name == "TextAsset":
                        data = obj.read()
                        text = data.text if isinstance(data.text, str) else data.text.decode("utf-8", errors="ignore")

                        if "gateways" not in text:
                            continue

                        try:
                            config = json.loads(text)
                        except json.JSONDecodeError:
                            continue

                        # Replace URLs
                        for ip_entry in config.get("ip", []):
                            for gw in ip_entry.get("gateways", []):
                                old_url = gw.get("url", "")
                                gw["url"] = target_url
                                modified = True

                            for key in ["contest_chat_url", "contest_gm_url", "prefix_url", "override_email_url"]:
                                if key in ip_entry:
                                    ip_entry[key] = target_url
                                    modified = True

                        if "system_email_url" in config:
                            config["system_email_url"] = target_url
                            modified = True

                        if "link_url" in config:
                            config["link_url"] = target_url
                            modified = True

                        if modified:
                            new_text = json.dumps(config, ensure_ascii=False)
                            data.text = new_text
                            data.save()
                            ok(f"  URLs redirected to {target_url}")

                if modified:
                    # Save the modified bundle
                    with open(majset_file, "wb") as f:
                        f.write(env.file.save())
                    patched_count += 1

            except Exception as e:
                warn(f"  Failed to patch {majset_file.name}: {e}")
                continue

    if patched_count > 0:
        ok(f"Patched {patched_count} .majset file(s)!")
    else:
        warn("No .majset files needed patching (may already be patched)")

    return True

# ============================================================================
# Patch 6: Windows hosts file - Redirect domains
# ============================================================================

def patch_hosts_file():
    """Add domain redirects to Windows hosts file"""
    header("Patch 6/6: Windows Hosts File")

    if platform.system() != "Windows":
        warn("Not on Windows, skipping hosts file patch")
        return True

    hosts_path = Path(r"C:\Windows\System32\drivers\etc\hosts")
    backup_path = hosts_path.parent / "hosts.bak.mahjongsoul"

    # Check admin privileges
    try:
        test_path = hosts_path.parent / ".write_test"
        with open(test_path, "w") as f:
            f.write("test")
        test_path.unlink()
    except PermissionError:
        error("Administrator privileges required to modify hosts file!")
        error("Please run this script as Administrator.")
        return False

    # Backup
    if not backup_path.exists():
        shutil.copy2(hosts_path, backup_path)
        info(f"Backup created: hosts.bak.mahjongsoul")

    # Read current hosts
    with open(hosts_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # Find existing entries
    existing_domains = set()
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#"):
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "127.0.0.1":
                existing_domains.add(parts[1])

    # Add missing entries (use markers for easy removal)
    new_entries = []
    new_entries.append("\n# >>> MahjongSoul Private Server - DO NOT EDIT >>>\n")
    for domain in REDIRECT_DOMAINS:
        if domain not in existing_domains:
            new_entries.append(f"127.0.0.1  {domain}\n")
    new_entries.append("# <<< MahjongSoul Private Server <<<\n")

    if len(new_entries) > 2:
        with open(hosts_path, "a", encoding="utf-8") as f:
            f.writelines(new_entries)
        ok(f"Added {len(new_entries) - 2} domain redirects to hosts file")
        info(f"Use: python generate_hosts.py --uninstall  to remove entries")
    else:
        info("All domain redirects already present in hosts file")

    return True

def restore_hosts_file():
    """Remove MahjongSoul entries from hosts file"""
    if platform.system() != "Windows":
        return True

    hosts_path = Path(r"C:\Windows\System32\drivers\etc\hosts")
    if not hosts_path.exists():
        return True

    with open(hosts_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # Remove lines between markers
    result = []
    in_block = False
    for line in lines:
        stripped = line.strip()
        if stripped == "# >>> MahjongSoul Private Server - DO NOT EDIT >>>":
            in_block = True
            continue
        if stripped == "# <<< MahjongSoul Private Server <<<":
            in_block = False
            continue
        if not in_block:
            result.append(line)

    with open(hosts_path, "w", encoding="utf-8") as f:
        f.writelines(result)

    ok("Hosts entries removed")
    return True

# ============================================================================
# Restore
# ============================================================================

def restore_all(game_dir):
    """Restore all patched files from backups"""
    header("Restoring Original Files")

    game_data_dir = game_dir / "Jantama_MahjongSoul_Data"
    results = []

    # 1. GameAssembly.dll
    dll_backup = game_dir / "GameAssembly.dll.original"
    dll_path = game_dir / "GameAssembly.dll"
    if dll_backup.exists():
        shutil.copy2(dll_backup, dll_path)
        ok("GameAssembly.dll restored")
        results.append(("GameAssembly.dll", True))
    else:
        info("GameAssembly.dll: no backup found")
        results.append(("GameAssembly.dll", True))

    # 2. steam_api.dll
    plugins_dir = game_data_dir / "Plugins" / "x86"
    stub_backup = plugins_dir / "steam_api.dll.original"
    stub_path = plugins_dir / "steam_api.dll"
    if stub_backup.exists():
        shutil.copy2(stub_backup, stub_path)
        ok("steam_api.dll restored")
        results.append(("steam_api.dll", True))
    else:
        info("steam_api.dll: no backup found")
        results.append(("steam_api.dll", True))

    # 3. RuntimeInitializeOnLoads.json
    for bak_name in ["RuntimeInitializeOnLoads.json.bak", "RuntimeInitializeOnLoads.json.original"]:
        bak = game_data_dir / bak_name
        if bak.exists():
            shutil.copy2(bak, game_data_dir / "RuntimeInitializeOnLoads.json")
            ok("RuntimeInitializeOnLoads.json restored")
            break

    # 4. ScriptingAssemblies.json
    for bak_name in ["ScriptingAssemblies.json.bak", "ScriptingAssemblies.json.original"]:
        bak = game_data_dir / bak_name
        if bak.exists():
            shutil.copy2(bak, game_data_dir / "ScriptingAssemblies.json")
            ok("ScriptingAssemblies.json restored")
            break

    # 5. .majset configs
    streaming_assets = game_data_dir / "StreamingAssets" / "StandaloneWindows"
    abm_fold = game_data_dir / "StreamingAssets" / "ABM-Fold" / "StandaloneWindows"
    for search_dir in [streaming_assets, abm_fold]:
        if search_dir.exists():
            for bak in search_dir.glob("*.majset.original_config"):
                original = bak.with_suffix("")  # Remove .original_config
                shutil.copy2(bak, original)
                ok(f"{original.name} restored")

    # 6. hosts file
    restore_hosts_file()

    header("Restore Complete")
    return 0

# ============================================================================
# Main
# ============================================================================

def print_summary(game_dir):
    """Print patch summary"""
    header("Patch Summary")

    print(f"  Game Directory:     {game_dir}")
    print(f"  Private Server:     {PRIVATE_SERVER_HOST}")
    print(f"  Lobby Port:         {LOBBY_PORT}")
    print(f"  Game Port:          {GAME_PORT}")
    print(f"  Gateway Proxy:      {GATEWAY_PROXY_PORT}")
    print(f"  Resource Server:    {RESOURCE_PORT}")
    print()
    print("  Patches Applied:")
    print("    [1] GameAssembly.dll - 8 binary patches (Steam bypass)")
    print("    [2] steam_api.dll - Replaced with stub DLL")
    print("    [3] RuntimeInitializeOnLoads.json - SteamManager removed")
    print("    [4] ScriptingAssemblies.json - Steamworks.NET removed")
    print("    [5] config.json in .majset - URLs redirected to localhost")
    print("    [6] hosts file - 15 domains redirected to 127.0.0.1")
    print()
    print("  Next Steps:")
    print("    1. Start the private server:  cd server && npm install && npm run build && npm start")
    print("    2. Start the local proxy:     python local_proxy.py")
    print("    3. Launch the game:           Jantama_MahjongSoul.exe")
    print()
    print("  Or use start.bat to do all three at once.")
    print()

def main():
    print(f"\n{Colors.BOLD}MahjongSoul Private Server - One-Click Client Patcher{Colors.END}")
    print(f"{Colors.BOLD}Version 1.1.0{Colors.END}\n")

    # Parse args
    if len(sys.argv) >= 2 and sys.argv[1] == "--restore":
        if len(sys.argv) < 3:
            print("Usage: python patch_all.py --restore <game_directory>")
            sys.exit(1)
        game_dir = Path(sys.argv[2]).resolve()
        return restore_all(game_dir)

    if len(sys.argv) < 2:
        print("Usage: python patch_all.py <game_directory>")
        print("       python patch_all.py --restore <game_directory>")
        print()
        print("Example:")
        print('  python patch_all.py "D:\\Games\\Jantama_MahjongSoul"')
        print('  python patch_all.py --restore "D:\\Games\\Jantama_MahjongSoul"')
        print()
        print("The game directory should contain:")
        print("  - GameAssembly.dll")
        print("  - Jantama_MahjongSoul_Data/")
        print("  - Jantama_MahjongSoul.exe")
        sys.exit(1)

    game_dir = Path(sys.argv[1]).resolve()

    # Validate game directory
    if not game_dir.exists():
        error(f"Directory not found: {game_dir}")
        sys.exit(1)

    dll_path = game_dir / "GameAssembly.dll"
    if not dll_path.exists():
        error(f"GameAssembly.dll not found in: {game_dir}")
        error("Please specify the directory containing the game executable.")
        sys.exit(1)

    game_data_dir = game_dir / "Jantama_MahjongSoul_Data"
    if not game_data_dir.exists():
        error(f"Jantama_MahjongSoul_Data not found in: {game_dir}")
        sys.exit(1)

    info(f"Game directory: {game_dir}")
    info(f"Game data:      {game_data_dir}")
    print()

    # Apply all patches
    results = []

    # Patch 1: GameAssembly.dll
    results.append(("GameAssembly.dll", patch_game_assembly(game_dir)))

    # Patch 2: steam_api.dll
    results.append(("steam_api.dll", patch_steam_api_dll(game_dir)))

    # Patch 3: RuntimeInitializeOnLoads.json
    results.append(("RuntimeInitializeOnLoads.json", patch_runtime_init(game_data_dir)))

    # Patch 4: ScriptingAssemblies.json
    results.append(("ScriptingAssemblies.json", patch_scripting_assemblies(game_data_dir)))

    # Patch 5: .majset config
    results.append((".majset config", patch_majset_config(game_data_dir)))

    # Patch 6: hosts file
    results.append(("hosts file", patch_hosts_file()))

    # Summary
    print_summary(game_dir)

    # Results
    header("Results")
    all_ok = True
    for name, success in results:
        status = f"{Colors.GREEN}OK{Colors.END}" if success else f"{Colors.RED}FAILED{Colors.END}"
        print(f"  {name:40s} [{status}]")
        if not success:
            all_ok = False

    print()
    if all_ok:
        ok("All patches applied successfully!")
    else:
        warn("Some patches failed. Check the output above for details.")

    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())

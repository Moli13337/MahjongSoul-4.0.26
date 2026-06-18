#!/usr/bin/env python3
"""
用纯 Python 构建完整的 steam_api.dll stub (v5)。
基于 v3 的能正常加载的 PE 结构，仅修复两个关键 bug:
  1. Name Pointer Table 按字母排序 (Windows 用二分查找)
  2. SteamAPI_RestartAppIfNecessary 返回 FALSE (不是 TRUE)
"""

import pefile
import struct
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
ORIGINAL_DLL = SCRIPT_DIR / "game_raw_files/Jantama_MahjongSoul_Data/Plugins/x86/steam_api.dll.original"
OUTPUT_DLL = SCRIPT_DIR / "game_raw_files/Jantama_MahjongSoul_Data/Plugins/x86/steam_api.dll"


def build_stub_pe(export_names):
    """用纯 Python 构建 32 位 PE DLL，导出指定函数"""

    # 每个 stub 函数的机器码:
    # bool返回TRUE: mov eax, 1; ret
    BOOL_CODE = bytes([0xB8, 0x01, 0x00, 0x00, 0x00, 0xC3])  # mov eax,1; ret
    # int返回0 / ptr返回NULL / void: xor eax, eax; ret
    ZERO_CODE = bytes([0x31, 0xC0, 0xC3])  # xor eax,eax; ret

    # 返回 TRUE 的函数 (初始化成功/是/已登录)
    RETURN_TRUE = {
        "SteamAPI_Init", "SteamAPI_IsSteamRunning", "SteamAPI_InitSafe",
        "ISteamApps_BIsSubscribed", "ISteamApps_BIsLowViolence",
        "ISteamApps_BIsCybercafe", "ISteamApps_BIsVACBanned",
        "ISteamApps_BIsDlcInstalled", "ISteamApps_BIsSubscribedApp",
        "ISteamApps_BIsSubscribedFromFamilySharing",
        "ISteamApps_BIsSubscribedFromFreeWeekend",
        "ISteamApps_BIsTimedTrial",
        "ISteamUser_BLoggedOn", "ISteamUser_BIsBehindNAT",
        "ISteamUserStats_RequestCurrentStats", "ISteamUserStats_GetStatInt",
        "ISteamUserStats_SetStatInt", "ISteamUserStats_StoreStats",
        "ISteamUserStats_GetAchievement", "ISteamUserStats_SetAchievement",
        "ISteamUserStats_StoreAchievement",
    }

    # 必须返回 FALSE 的函数 (返回 TRUE 会导致游戏退出!)
    RETURN_FALSE = {
        "SteamAPI_RestartAppIfNecessary",  # TRUE = "需要通过Steam重启" -> Application.Quit()
    }

    # 构建代码段 - 所有函数的机器码
    code_section = bytearray()
    func_offsets = {}  # name -> offset in code section

    for name in export_names:
        offset = len(code_section)
        func_offsets[name] = offset

        if name in RETURN_FALSE:
            code_section += ZERO_CODE
        elif name in RETURN_TRUE:
            code_section += BOOL_CODE
        elif "BIs" in name or "BHas" in name or name.startswith("B"):
            code_section += BOOL_CODE
        else:
            code_section += ZERO_CODE

    # 对齐到 4 字节
    while len(code_section) % 4 != 0:
        code_section += b'\x00'

    # 构建名称字符串池
    name_strings = bytearray()
    name_offsets = {}
    for name in export_names:
        name_offsets[name] = len(name_strings)
        name_strings += name.encode('ascii') + b'\x00'

    # 对齐
    while len(name_strings) % 4 != 0:
        name_strings += b'\x00'

    # --- PE 结构 (与 v3 完全一致) ---
    # DOS Header
    dos_header = bytearray(64)
    dos_header[0:2] = b'MZ'
    struct.pack_into('<I', dos_header, 0x3C, 64)

    # PE Signature
    pe_sig = b'PE\0\0'

    # COFF Header (20 bytes)
    coff_header = bytearray(20)
    struct.pack_into('<H', coff_header, 0, 0x14C)   # Machine: i386
    struct.pack_into('<H', coff_header, 2, 1)        # NumberOfSections
    struct.pack_into('<I', coff_header, 4, 0)        # TimeDateStamp
    struct.pack_into('<I', coff_header, 8, 0)        # PointerToSymbolTable
    struct.pack_into('<I', coff_header, 12, 0)       # NumberOfSymbols
    struct.pack_into('<H', coff_header, 16, 0xE0)    # SizeOfOptionalHeader
    struct.pack_into('<H', coff_header, 18, 0x2102)  # Characteristics

    # Optional Header (0xE0 = 224 bytes for PE32)
    opt_header = bytearray(0xE0)
    struct.pack_into('<H', opt_header, 0, 0x10B)     # Magic: PE32
    opt_header[2] = 14
    opt_header[3] = 0
    struct.pack_into('<I', opt_header, 4, 0x1000)     # SizeOfCode
    struct.pack_into('<I', opt_header, 8, 0x1000)     # SizeOfInitializedData
    struct.pack_into('<I', opt_header, 12, 0)         # SizeOfUninitializedData
    struct.pack_into('<I', opt_header, 16, 0x1000)    # AddressOfEntryPoint
    struct.pack_into('<I', opt_header, 20, 0x1000)    # BaseOfCode
    struct.pack_into('<I', opt_header, 24, 0x2000)    # BaseOfData
    struct.pack_into('<I', opt_header, 28, 0x10000000) # ImageBase
    struct.pack_into('<I', opt_header, 32, 0x1000)    # SectionAlignment
    struct.pack_into('<I', opt_header, 36, 0x200)     # FileAlignment
    struct.pack_into('<H', opt_header, 40, 6)         # MajorOperatingSystemVersion
    struct.pack_into('<H', opt_header, 42, 0)
    struct.pack_into('<H', opt_header, 44, 0)
    struct.pack_into('<H', opt_header, 46, 0)
    struct.pack_into('<H', opt_header, 48, 6)
    struct.pack_into('<H', opt_header, 50, 0)
    struct.pack_into('<I', opt_header, 52, 0)
    struct.pack_into('<I', opt_header, 56, 0x4000)    # SizeOfImage
    struct.pack_into('<I', opt_header, 60, 0x200)     # SizeOfHeaders
    struct.pack_into('<I', opt_header, 64, 0)         # CheckSum
    struct.pack_into('<H', opt_header, 68, 3)         # Subsystem: WINDOWS_CUI
    struct.pack_into('<H', opt_header, 70, 0x8160)    # DllCharacteristics
    struct.pack_into('<I', opt_header, 72, 0x100000)  # SizeOfStackReserve
    struct.pack_into('<I', opt_header, 76, 0x1000)
    struct.pack_into('<I', opt_header, 80, 0x100000)
    struct.pack_into('<I', opt_header, 84, 0x1000)
    struct.pack_into('<I', opt_header, 88, 0)
    struct.pack_into('<I', opt_header, 92, 16)        # NumberOfRvaAndSizes

    # 计算各段 RVA
    code_rva = 0x1000
    code_file_offset = 0x200
    code_size = len(code_section)

    # 导出目录放在代码段后面
    export_rva = code_rva + code_size

    # 导出目录结构
    num_funcs = len(export_names)
    num_names = len(export_names)

    # 序号映射: name -> ordinal index (在 export_names 中的位置)
    name_to_ordinal = {name: i for i, name in enumerate(export_names)}

    # Export Directory Table (40 bytes)
    export_dir = bytearray(40)
    struct.pack_into('<I', export_dir, 0, 0)
    struct.pack_into('<I', export_dir, 4, 0)
    struct.pack_into('<H', export_dir, 8, 0)
    struct.pack_into('<H', export_dir, 10, 0)
    struct.pack_into('<I', export_dir, 12, export_rva + 40)  # Name RVA
    struct.pack_into('<I', export_dir, 16, 1)          # OrdinalBase
    struct.pack_into('<I', export_dir, 20, num_funcs)  # NumberOfFunctions
    struct.pack_into('<I', export_dir, 24, num_names)  # NumberOfNames

    addr_table_rva = export_rva + 40 + len(b'steam_api.dll\0')
    struct.pack_into('<I', export_dir, 28, addr_table_rva)

    name_table_rva = addr_table_rva + num_funcs * 4
    struct.pack_into('<I', export_dir, 32, name_table_rva)

    ordinal_table_rva = name_table_rva + num_names * 4
    struct.pack_into('<I', export_dir, 36, ordinal_table_rva)

    # DLL name
    dll_name = b'steam_api.dll\0'

    # Address Table (按序号顺序)
    addr_table = bytearray()
    for name in export_names:
        func_rva = code_rva + func_offsets[name]
        addr_table += struct.pack('<I', func_rva)

    # *** 修复1: Name Pointer Table 按字母排序 ***
    sorted_names = sorted(export_names)

    name_table = bytearray()
    names_rva_start = ordinal_table_rva + num_names * 2
    for name in sorted_names:
        name_rva = names_rva_start + name_offsets[name]
        name_table += struct.pack('<I', name_rva)

    # *** 修复2: Ordinal Table 与排序后的 Name Table 平行 ***
    ordinal_table = bytearray()
    for name in sorted_names:
        ordinal_table += struct.pack('<H', name_to_ordinal[name])

    # 组合所有导出数据
    export_data = bytearray()
    export_data += export_dir
    export_data += dll_name
    export_data += addr_table
    export_data += name_table
    export_data += ordinal_table
    export_data += name_strings

    # 对齐
    while len(export_data) % 4 != 0:
        export_data += b'\x00'

    export_size = len(export_data)

    # 设置 Export data directory
    struct.pack_into('<I', opt_header, 96, export_rva)
    struct.pack_into('<I', opt_header, 100, export_size)

    # Import Table (与 v3 完全一致)
    import_rva = export_rva + export_size

    import_dir = bytearray(20 * 3)
    ilt_rva = import_rva + 60
    name_rva = import_rva + 64
    iat_rva = import_rva + 80

    struct.pack_into('<I', import_dir, 0, ilt_rva)
    struct.pack_into('<I', import_dir, 4, 0)
    struct.pack_into('<I', import_dir, 8, 0)
    struct.pack_into('<I', import_dir, 12, name_rva)
    struct.pack_into('<I', import_dir, 16, iat_rva)

    hint_name_rva = import_rva + 96
    ilt_data = struct.pack('<I', hint_name_rva) + struct.pack('<I', 0)

    kernel32_name = b'kernel32.dll\0'

    hint_name = struct.pack('<H', 0) + b'ExitProcess\0'

    import_data = bytearray()
    import_data += import_dir
    import_data += ilt_data
    import_data += kernel32_name
    import_data += b'\0' * (80 - len(kernel32_name) - len(ilt_data) - len(import_dir))
    import_data = bytearray()
    import_data += import_dir
    import_data += ilt_data
    import_data += kernel32_name
    while len(import_data) < 96:
        import_data += b'\0'
    import_data += hint_name
    while len(import_data) < 120:
        import_data += b'\0'

    import_size = len(import_data)

    struct.pack_into('<I', opt_header, 104, import_rva)
    struct.pack_into('<I', opt_header, 108, import_size)

    # 合并所有数据到一个 section
    all_data = code_section + export_data + import_data
    all_size = len(all_data)

    raw_size = ((all_size + 0x1FF) // 0x200) * 0x200
    virtual_size = ((all_size + 0xFFF) // 0x1000) * 0x1000

    # Section Header (.text) - 与 v3 一致
    section_header = bytearray(40)
    section_header[0:6] = b'.text\0'
    struct.pack_into('<I', section_header, 8, virtual_size)
    struct.pack_into('<I', section_header, 12, code_rva)
    struct.pack_into('<I', section_header, 16, raw_size)
    struct.pack_into('<I', section_header, 20, code_file_offset)
    struct.pack_into('<I', section_header, 36, 0x60000020)  # CODE|EXECUTE|READ (与v3一致)

    # 更新 SizeOfImage
    total_image_size = code_rva + virtual_size
    struct.pack_into('<I', opt_header, 56, total_image_size)

    # 组装完整 PE
    pe_data = bytearray()
    pe_data += dos_header
    pe_data += pe_sig
    pe_data += coff_header
    pe_data += opt_header
    pe_data += section_header

    while len(pe_data) < code_file_offset:
        pe_data += b'\0'

    pe_data += all_data

    while len(pe_data) < code_file_offset + raw_size:
        pe_data += b'\0'

    return bytes(pe_data)


def main():
    print("=" * 60)
    print("  steam_api.dll Stub Builder v5")
    print("  基于 v3 (可加载) + 修复: Name排序 + RestartApp返回FALSE")
    print("=" * 60)

    if not ORIGINAL_DLL.exists():
        print(f"错误: 找不到原始 DLL: {ORIGINAL_DLL}")
        sys.exit(1)

    pe = pefile.PE(str(ORIGINAL_DLL))
    exports = []
    if hasattr(pe, 'DIRECTORY_ENTRY_EXPORT'):
        for exp in pe.DIRECTORY_ENTRY_EXPORT.symbols:
            if exp.name:
                exports.append(exp.name.decode())

    print(f"  原始 DLL 导出函数: {len(exports)} 个")

    # 构建 stub PE
    print("  构建 stub DLL...")
    pe_data = build_stub_pe(exports)

    with open(OUTPUT_DLL, 'wb') as f:
        f.write(pe_data)

    dll_size = OUTPUT_DLL.stat().st_size
    print(f"  已生成: {OUTPUT_DLL} ({dll_size:,} bytes)")

    # 验证
    print("\n  验证 PE 格式...")
    try:
        pe2 = pefile.PE(str(OUTPUT_DLL))
        stub_exports = {}
        if hasattr(pe2, 'DIRECTORY_ENTRY_EXPORT'):
            for exp in pe2.DIRECTORY_ENTRY_EXPORT.symbols:
                if exp.name:
                    stub_exports[exp.name.decode()] = exp

        missing = set(exports) - set(stub_exports.keys())
        if missing:
            print(f"  [错误] 缺少 {len(missing)} 个导出函数!")
            for name in sorted(missing)[:10]:
                print(f"    - {name}")
        else:
            print(f"  [OK] 所有 {len(exports)} 个导出函数都存在")

        # 检查 Name Pointer Table 排序
        name_list = [exp.name.decode() for exp in pe2.DIRECTORY_ENTRY_EXPORT.symbols if exp.name]
        sorted_ok = all(name_list[i] <= name_list[i+1] for i in range(len(name_list)-1))
        print(f"  [{'OK' if sorted_ok else '错误'}] Name Pointer Table {'已排序' if sorted_ok else '未排序!'}")

        # 检查关键函数返回值
        print("\n  关键函数返回值:")
        for func_name in ["SteamAPI_RestartAppIfNecessary", "SteamAPI_Init", "SteamAPI_IsSteamRunning"]:
            if func_name in stub_exports:
                exp = stub_exports[func_name]
                offset = pe2.get_offset_from_rva(exp.address)
                code = pe2.get_data(offset, 6)
                if code[:6] == b'\xB8\x01\x00\x00\x00\xC3':
                    print(f"    {func_name}: TRUE (1)")
                elif code[:3] == b'\x31\xC0\xC3':
                    print(f"    {func_name}: FALSE (0)")
                else:
                    print(f"    {func_name}: 未知 ({code[:6].hex()})")

        pe2.close()
    except Exception as e:
        print(f"  [错误] PE 验证失败: {e}")

    print("\n" + "=" * 60)
    print("  完成! 请重启游戏测试。")
    print("=" * 60)


if __name__ == "__main__":
    main()

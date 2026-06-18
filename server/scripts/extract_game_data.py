#!/usr/bin/env python3
"""
Extract game data from Mahjong Soul client Lua files and convert to JSON.

The Lua data files use a specific format with field maps, Dmap references,
and position shifting logic. This script parses these files and outputs
clean JSON data for use by the private server.
"""

import json
import os
import re
import glob
import sys
from typing import Any

# Paths
# Paths - use decrypted Lua source which has correct field maps
LUA_DATA_DIR = os.path.normpath(
    r"d:\GamePS\MahjongSoul\extracted_lua\decrypted\other"
)
OUTPUT_DIR = os.path.normpath(
    r"d:\GamePS\MahjongSoul\private-server\data\game_data"
)

# Key fields to extract for each table
TABLE_CONFIG = {
    "characters": {
        "base_file": "character.lua",
        "batch_pattern": "character_b*.lua",
        "key_fields": [
            "id", "sort", "init_skin", "full_fetter_skin", "sound_folder",
            "can_marry", "sex", "star_5_material", "star_5_cost",
            "exchange_item_id", "collaboration", "limited", "emo",
            "desc_stature_chs", "desc_birth_chs", "desc_age_chs",
            "desc_bloodtype_chs", "desc_cv_chs", "desc_hobby_chs",
        ],
    },
    "skins": {
        "base_file": "skin.lua",
        "batch_pattern": "skin_b*.lua",
        "key_fields": [
            "id", "type", "name_chs", "character_id", "path",
            "exchange_item_id", "direction", "spine_type", "idle",
            "greeting", "celebrate", "click", "smallhead_x",
            "smallhead_y", "smallhead_width", "full_x", "full_y",
            "full_width", "full_height",
        ],
    },
    "items": {
        "base_file": "item.lua",
        "batch_pattern": "item_b*.lua",
        "key_fields": [
            "id", "sort", "name_chs", "category", "type", "is_unique",
            "max_stack", "func", "iargs", "sargs", "can_sell", "icon",
        ],
    },
    "titles": {
        "base_file": "title.lua",
        "batch_pattern": "title_b*.lua",
        "key_fields": [
            "id", "name_chs", "desc_chs", "icon", "priority", "unlock_type",
        ],
    },
    "currencies": {
        "base_file": "currency.lua",
        "batch_pattern": None,
        "key_fields": [
            "id", "name_chs", "desc_chs", "icon",
        ],
    },
    "levels": {
        "base_file": "level_definition.lua",
        "batch_pattern": None,
        "key_fields": [
            "id", "type", "primary_level", "secondary_level",
            "init_point", "end_point", "name_chs",
        ],
    },
    "vip_levels": {
        "base_file": "vip.lua",
        "batch_pattern": None,
        "key_fields": [
            "id", "name_chs", "charge", "gift_limit", "friend_added",
            "shop_free_refresh", "title_id",
        ],
    },
    "fans": {
        "base_file": "fan.lua",
        "batch_pattern": None,
        "key_fields": [
            "id", "name_chs", "yiman", "fan_menqing", "fan_fulu", "rarity",
        ],
    },
}


def parse_dmap_key(key: int) -> tuple:
    """Parse a Dmap key into (si, ei, o) parameters.

    The Dmap key format is k*1000+k+m where:
    - si = k (start index)
    - ei = k + m (end index)
    - o = m (offset)
    """
    k = key // 1000
    m = key - k * 1001
    if m < 1:
        k -= 1
        m = key - k * 1001
    si = k
    ei = k + m
    o = m
    return si, ei, o


def resolve_value(data: list, defaults: list, position: int,
                  dmap_ref: tuple | None) -> Any:
    """Resolve a value from the data array using position and Dmap shifting.

    Implements the same logic as the Lua `o` function in exceltool.lua:
    - If Dmap ref exists at position 1:
      - position > ei: look at data[position - o]
      - position >= si: look at defaults[position]
      - position < si: look at data[position + 1]
    - Otherwise: look at data[position]
    Falls back to defaults then None.
    """
    if dmap_ref is not None:
        si, ei, o = dmap_ref
        if position > ei:
            idx = position - o
            if idx <= len(data) and idx >= 1:
                val = data[idx - 1]
                if val is not None:
                    return val
            if position <= len(defaults) and defaults[position - 1] is not None:
                return defaults[position - 1]
            return None
        elif position >= si:
            if position <= len(defaults) and defaults[position - 1] is not None:
                return defaults[position - 1]
            return None
        else:
            idx = position + 1
            if idx <= len(data) and idx >= 1:
                val = data[idx - 1]
                if val is not None:
                    return val
            if position <= len(defaults) and defaults[position - 1] is not None:
                return defaults[position - 1]
            return None
    else:
        if position >= 1 and position <= len(data):
            val = data[position - 1]
            if val is not None:
                return val
        if position >= 1 and position <= len(defaults):
            return defaults[position - 1]
        return None


def parse_field_map(field_map_str: str) -> dict:
    """Parse a Lua field map string like {["field1"]=1,["field2"]=-2}
    into a Python dict.
    """
    result = {}
    # Match ["fieldname"]=VALUE patterns
    pattern = r'\["([^"]+)"\]=(-?\d+)'
    for match in re.finditer(pattern, field_map_str):
        field_name = match.group(1)
        position = int(match.group(2))
        result[field_name] = position
    return result


def parse_defaults_array(defaults_str: str) -> list:
    """Parse a Lua defaults array like {nil,nil,1,"text",false}
    into a Python list.
    """
    result = []
    # Remove outer braces
    inner = defaults_str.strip()
    if inner.startswith('{'):
        inner = inner[1:]
    if inner.endswith('}'):
        inner = inner[:-1]

    if not inner.strip():
        return result

    # Split by comma, but handle nested structures
    elements = split_lua_array(inner)
    for elem in elements:
        elem = elem.strip()
        if elem == 'nil' or elem == '':
            result.append(None)
        elif elem == 'false':
            result.append(None)  # false = null
        elif elem == 'true':
            result.append(True)
        elif elem.startswith('"') and elem.endswith('"'):
            result.append(elem[1:-1])
        elif elem.startswith("'") and elem.endswith("'"):
            result.append(elem[1:-1])
        else:
            try:
                if '.' in elem:
                    result.append(float(elem))
                else:
                    result.append(int(elem))
            except ValueError:
                result.append(elem)
    return result


def split_lua_array(s: str) -> list:
    """Split a Lua array string by commas, respecting nested braces and
    quotes.
    """
    result = []
    depth = 0
    in_string = False
    string_char = None
    current = []

    i = 0
    while i < len(s):
        c = s[i]
        if in_string:
            current.append(c)
            if c == string_char and (i == 0 or s[i-1] != '\\'):
                in_string = False
        elif c == '"' or c == "'":
            in_string = True
            string_char = c
            current.append(c)
        elif c == '{':
            depth += 1
            current.append(c)
        elif c == '}':
            depth -= 1
            current.append(c)
        elif c == ',' and depth == 0:
            result.append(''.join(current))
            current = []
        else:
            current.append(c)
        i += 1

    if current:
        result.append(''.join(current))
    return result


def parse_values_array(values_str: str) -> list:
    """Parse a Lua values array from b({...},h) or similar.

    Handles:
    - Numbers: 123, -5, 1.5
    - Strings: "text", 'text'
    - Booleans: true, false
    - nil
    - Dmap references: e[NNNN] -> stored as special marker
    - Sub calls: c({...}) -> stored as list
    - Nested arrays
    """
    result = []
    inner = values_str.strip()
    if inner.startswith('{'):
        inner = inner[1:]
    if inner.endswith('}'):
        inner = inner[:-1]

    if not inner.strip():
        return result

    elements = split_lua_array(inner)
    for elem in elements:
        elem = elem.strip()
        if elem == 'nil' or elem == '':
            result.append(None)
        elif elem == 'false':
            result.append(None)  # false = null in our representation
        elif elem == 'true':
            result.append(True)
        elif re.match(r'^e\[(\d+)\]$', elem):
            # Dmap reference - store as special marker
            dmap_key = int(re.match(r'^e\[(\d+)\]$', elem).group(1))
            result.append(('dmap', dmap_key))
        elif elem.startswith('c('):
            # Sub call - extract inner content
            sub_inner = elem[2:]
            if sub_inner.endswith(')'):
                sub_inner = sub_inner[:-1]
            sub_values = parse_values_array(sub_inner)
            result.append(sub_values if sub_values else [])
        elif elem.startswith('"') and elem.endswith('"'):
            # Handle multi-line strings
            result.append(elem[1:-1].replace('\\n', '\n'))
        elif elem.startswith("'") and elem.endswith("'"):
            result.append(elem[1:-1].replace('\\n', '\n'))
        else:
            try:
                if '.' in elem:
                    result.append(float(elem))
                else:
                    result.append(int(elem))
            except ValueError:
                result.append(elem)
    return result


def parse_lua_file(filepath: str) -> dict:
    """Parse a Lua data file and extract field map, defaults, and data entries.

    Returns a dict with:
    - field_map: dict of field name -> position
    - defaults: list of default values
    - entries: dict of id -> raw values list
    - b2i: list of boundary IDs
    - table_name: the table name from the LangGet function
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    result = {
        'field_map': {},
        'defaults': [],
        'entries': {},
        'b2i': [],
        'table_name': None,
    }

    # Parse field map: local f={["field1"]=1,["field2"]=-2,...}
    # The field map variable is typically the 6th local (f)
    fm_match = re.search(r'local \w+=\{(\["[^"]+"\]=-?\d+(?:,\["[^"]+"\]=-?\d+)*)\}', content)
    if fm_match:
        result['field_map'] = parse_field_map(fm_match.group(0))

    # Parse defaults: local g={nil,nil,1,"text",false,...}
    # Look for the defaults array after the field map
    defaults_matches = re.findall(r'local \w+=\{([^}]*)\}', content)
    if len(defaults_matches) >= 2:
        # The second match is typically the defaults array
        result['defaults'] = parse_defaults_array('{' + defaults_matches[1] + '}')

    # Parse table name from LangGet function
    tn_match = re.search(r'return d\(i,j,f,g,"([^"]+)"\)', content)
    if not tn_match:
        tn_match = re.search(r'return c\(g,h,d,e,"([^"]+)"\)', content)
    if tn_match:
        result['table_name'] = tn_match.group(1)

    # Parse data entries: k[ID]=b({values},h) or g[ID]=b({values},h)
    # Also handle k[ID]={b({values},h),b({values},h),...} for block entries
    entry_pattern = r'[kg]\[(\d+)\]=b\(\{(.+?)\},h\)'

    # For entries that use k[0]={...} format (block entries with multiple values)
    block_pattern = r'[kg]\[0\]=\{(.+?)\}(?=[kg]\[|\s*return)'

    # First try simple entries
    for match in re.finditer(entry_pattern, content):
        entry_id = int(match.group(1))
        values_str = match.group(2)
        values = parse_values_array(values_str)
        result['entries'][entry_id] = values

    # Parse b2i array
    b2i_match = re.search(r'local \w+=\{(\d[\d,]*)\}', content)
    if b2i_match:
        b2i_str = b2i_match.group(1)
        result['b2i'] = [int(x) for x in b2i_str.split(',') if x.strip()]

    return result


def parse_batch_file(filepath: str) -> dict:
    """Parse a batch Lua file that extends a base table.

    Batch files use require() to get the base table and add entries to it.
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    entries = {}

    # Parse data entries: g[ID]=b({values},h)
    entry_pattern = r'g\[(\d+)\]=b\(\{(.+?)\},h\)'
    for match in re.finditer(entry_pattern, content):
        entry_id = int(match.group(1))
        values_str = match.group(2)
        values = parse_values_array(values_str)
        entries[entry_id] = values

    return {'entries': entries}


def extract_entry_fields(entry_id: int, values: list, field_map: dict,
                         defaults: list, key_fields: list) -> dict:
    """Extract specified fields from a data entry using the field map.

    Implements Dmap position shifting logic to correctly resolve values.
    """
    result = {'id': entry_id}

    # Check if there's a Dmap reference at position 1
    dmap_ref = None
    if values and isinstance(values[0], tuple) and values[0][0] == 'dmap':
        dmap_key = values[0][1]
        dmap_ref = parse_dmap_key(dmap_key)

    # Create a clean data list (replace Dmap markers with None)
    clean_data = []
    for v in values:
        if isinstance(v, tuple) and v[0] == 'dmap':
            clean_data.append(None)
        else:
            clean_data.append(v)

    for field_name in key_fields:
        if field_name == 'id':
            continue  # Already set from entry key

        if field_name not in field_map:
            result[field_name] = None
            continue

        position = field_map[field_name]

        # Determine the actual position in the data array
        if position > 0:
            # Direct position or Dmap position (10XX)
            actual_pos = position if position < 1000 else position - 1000
            value = resolve_value(clean_data, defaults, actual_pos, dmap_ref)
        elif position < 0:
            # Language field - use absolute value as position
            actual_pos = abs(position)
            value = resolve_value(clean_data, defaults, actual_pos, dmap_ref)
            # Language fields return a key that would be resolved by LangGet
            # We keep the raw key value (could be a number or string)
        else:
            value = None

        # Convert lists (from c({})) to JSON-compatible format
        if isinstance(value, list):
            value = value
        elif isinstance(value, tuple):
            value = None

        result[field_name] = value

    return result


def extract_table(table_name: str, config: dict) -> list:
    """Extract a data table from Lua files and return as a list of dicts."""
    base_path = os.path.join(LUA_DATA_DIR, config["base_file"])

    # Determine the field map source
    field_map_file = config.get("field_map_file", config["base_file"])
    field_map_path = os.path.join(LUA_DATA_DIR, field_map_file)

    # Parse the base/field map file
    if os.path.exists(field_map_path):
        base_data = parse_lua_file(field_map_path)
        field_map = base_data['field_map']
        defaults = base_data['defaults']
    else:
        print(f"  警告: 字段映射文件 {field_map_path} 不存在")
        field_map = {}
        defaults = []

    # Parse the actual base data file if different from field map file
    use_batch_only = config.get("use_batch_only", False)
    entries = {}

    if not use_batch_only and os.path.exists(base_path):
        base_entries = parse_lua_file(base_path)
        entries.update(base_entries['entries'])
        # Use defaults from the actual data file if available
        if base_entries['defaults']:
            defaults = base_entries['defaults']

    # Parse batch files
    batch_pattern = config.get("batch_pattern")
    if batch_pattern:
        batch_files = sorted(glob.glob(os.path.join(LUA_DATA_DIR, batch_pattern)))
        for batch_file in batch_files:
            batch_data = parse_batch_file(batch_file)
            entries.update(batch_data['entries'])

    # If using batch only for characters, also parse character batch files
    if use_batch_only:
        batch_pattern = config.get("batch_pattern")
        if batch_pattern:
            batch_files = sorted(glob.glob(os.path.join(LUA_DATA_DIR, batch_pattern)))
            for batch_file in batch_files:
                batch_data = parse_batch_file(batch_file)
                entries.update(batch_data['entries'])

    # Extract key fields from each entry
    key_fields = config["key_fields"]
    result = []
    for entry_id in sorted(entries.keys()):
        values = entries[entry_id]
        entry_dict = extract_entry_fields(
            entry_id, values, field_map, defaults, key_fields
        )
        result.append(entry_dict)

    return result


def process_value_for_json(obj: Any) -> Any:
    """Recursively process a value to make it JSON-serializable."""
    if obj is None:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, (int, float)):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, list):
        return [process_value_for_json(item) for item in obj]
    if isinstance(obj, dict):
        return {k: process_value_for_json(v) for k, v in obj.items()}
    if isinstance(obj, tuple):
        # Dmap reference or other tuple - convert to None
        return None
    return str(obj)


def main():
    """Main entry point."""
    # Create output directory
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("=" * 60)
    print("雀魂麻将游戏数据提取工具")
    print("=" * 60)
    print(f"Lua数据目录: {LUA_DATA_DIR}")
    print(f"输出目录: {OUTPUT_DIR}")
    print()

    for table_name, config in TABLE_CONFIG.items():
        print(f"正在提取: {table_name}...")

        output_file = os.path.join(OUTPUT_DIR, f"{table_name}.json")

        # Check if base file exists
        base_path = os.path.join(LUA_DATA_DIR, config["base_file"])
        field_map_file = config.get("field_map_file", config["base_file"])
        field_map_path = os.path.join(LUA_DATA_DIR, field_map_file)

        if not os.path.exists(base_path) and not os.path.exists(field_map_path):
            print(f"  跳过: 基础文件 {config['base_file']} 不存在")
            print()
            continue

        # Extract data
        entries = extract_table(table_name, config)

        # Make JSON-serializable
        entries = process_value_for_json(entries)

        # Write output
        output_data = {"entries": entries}
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, ensure_ascii=False, indent=2)

        # Print statistics
        print(f"  提取了 {len(entries)} 条记录")
        if entries:
            # Show field map info
            base_data = parse_lua_file(field_map_path)
            print(f"  字段映射: {len(base_data['field_map'])} 个字段")
            print(f"  默认值: {len(base_data['defaults'])} 个")

            # Show sample entry
            sample = entries[0] if entries else {}
            sample_id = sample.get('id', 'N/A')
            print(f"  示例ID: {sample_id}")

        print(f"  已保存到: {output_file}")
        print()

    print("=" * 60)
    print("提取完成!")
    print("=" * 60)


if __name__ == '__main__':
    main()

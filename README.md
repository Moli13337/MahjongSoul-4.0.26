# MahjongSoul Private Server

A private server implementation for Mahjong Soul (雀魂) Steam client. This project allows you to run a local private server with all content unlocked.

## Features

- **Full Steam bypass** - 8 binary patches to GameAssembly.dll + stub steam_api.dll
- **Complete private server** - Lobby, Game, and Resource servers in Node.js/TypeScript
- **SQLite database** - Persistent account storage with auto-unlock all content
- **Game data from client** - Character/skin/item data extracted from client Lua files
- **Local proxy** - Intercepts all gateway and CDN requests
- **One-click patch** - Single script patches the entire client
- **Resource files included** - AssetBundleConfig.json and bundle_hash.txt bundled

## Quick Start

### Prerequisites

1. **Python 3.8+** with packages:
   ```
   pip install pefile UnityPy cryptography
   ```

2. **Node.js 18+**

3. **Mahjong Soul Steam client** installed

### One-Click Setup

1. Download and extract this release zip
2. Open a terminal **as Administrator** (needed for hosts file)
3. Run the patcher:
   ```
   cd patch
   python patch_all.py "C:\Path\To\Jantama_MahjongSoul"
   ```
4. Start everything:
   ```
   start.bat
   ```

### Manual Setup

#### Step 1: Patch the Client

```bash
cd patch
python patch_all.py "D:\Games\Jantama_MahjongSoul"
```

This applies 6 patches:
1. **GameAssembly.dll** - 8 binary patches (Steam API bypass)
2. **steam_api.dll** - Replaced with stub DLL
3. **RuntimeInitializeOnLoads.json** - SteamManager auto-init removed
4. **ScriptingAssemblies.json** - Steamworks.NET reference removed
5. **config.json in .majset** - Gateway URLs redirected to localhost
6. **hosts file** - 15 game domains redirected to 127.0.0.1

#### Step 2: Configure the Server

Edit `server/config/default.json` and set `game_data_dir` to your game's data directory:

```json
{
  "server": {
    "game_data_dir": "D:/Games/Jantama_MahjongSoul/Jantama_MahjongSoul_Data"
  }
}
```

Or set the `GAME_DATA_DIR` environment variable:
```bash
set GAME_DATA_DIR=D:\Games\Jantama_MahjongSoul\Jantama_MahjongSoul_Data
```

If not set, the server defaults to `../game/Jantama_MahjongSoul_Data` relative to the server directory.

#### Step 3: Build the Server

```bash
cd server
npm install
npm run build
```

#### Step 4: Start Services

```bash
# Terminal 1: Start proxy
cd patch
python local_proxy.py

# Terminal 2: Start server
cd server
node dist/index.js

# Terminal 3: Launch game
"D:\Games\Jantama_MahjongSoul\Jantama_MahjongSoul.exe"
```

Or simply run `start.bat` to do all three.

## Project Structure

```
mahjongsoul-private-server/
├── patch/                              # Client patching tools
│   ├── patch_all.py                    # One-click patcher (main entry)
│   ├── generate_hosts.py               # Standalone hosts file generator
│   ├── generate_bundle_hash.py         # Bundle hash file generator
│   ├── build_steam_stub_v5.py          # Builds stub steam_api.dll (Python PE builder)
│   ├── steam_api_stub.c                # Stub steam_api.dll C source (alternative)
│   ├── steam_api_stub.def              # Stub DLL exports definition
│   ├── local_proxy.py                  # Local HTTP/HTTPS proxy
│   ├── patch_config.json               # Proxy configuration (edit game_dir)
│   └── requirements.txt                # Python dependencies
├── server/                             # Private server (Node.js)
│   ├── src/
│   │   ├── lobby/server.ts             # Lobby WebSocket server
│   │   ├── game/server.ts              # Game WebSocket server
│   │   ├── resource/server.ts          # Resource HTTP server
│   │   ├── proto/                      # Protocol buffer definitions
│   │   ├── shared/                     # Database, config, game data
│   │   └── index.ts                    # Server entry point
│   ├── config/default.json             # Server configuration (edit game_data_dir)
│   ├── data/game_data/                 # Extracted game data (JSON)
│   ├── public/                         # Served static files
│   │   └── app/v3/release/ab/
│   │       └── StandaloneWindows/
│   │           ├── AssetBundleConfig.json  # Asset bundle config (3.8MB)
│   │           └── bundle_hash.txt         # Bundle hash list (750KB)
│   └── package.json
├── start.bat                           # One-click launcher
└── README.md
```

## Server Ports

| Port  | Protocol | Purpose                |
|-------|----------|------------------------|
| 8440  | HTTP     | Resource/Config server |
| 8441  | WebSocket| Lobby server           |
| 8443  | WebSocket| Game server            |
| 8080  | HTTP     | Gateway proxy          |
| 80    | HTTP     | CDN HTTP proxy         |
| 443   | HTTPS    | CDN HTTPS proxy        |

## Client Patches Detail

### 1. GameAssembly.dll (8 binary patches)

All patches use RVA (Relative Virtual Address) to locate the function in the DLL.

| # | Function | RVA | Patch Bytes | Purpose |
|---|----------|-----|-------------|---------|
| 1 | `DllCheck.Test()` | `0x5BBCB0` | `B0 01 C3` | Return true - bypass DLL integrity check |
| 2 | `Packsize.Test()` | `0xC8E5F0` | `B0 01 C3` | Return true - bypass pack size validation |
| 3 | `SteamAPI.Init()` | `0xC8F520` | `B0 01 C3` | Return true - Steam init always succeeds |
| 4 | `SteamAPI.RestartAppIfNecessary()` | `0xC8B530` | `30 C0 C3` | Return false - prevent game restart |
| 5 | `InteropHelp.TestIfAvailableClient()` | `0xC6DB40` | `C3` | Immediate return - skip Steamworks check |
| 6 | `InteropHelp.TestIfAvailableGameServer()` | `0xC6DBD0` | `C3` | Immediate return - skip Steamworks check |
| 7 | `GamePlatformInfo.IsSteam()` | `0x5BBF00` | `30 C0 C3` | Return false - prevent SteamUtils crash |
| 8 | `SteamManager.Initialized.get` | `0x39F930` | `30 C0 C3` | Return false - Lua IsSteam() returns false |

**Patch byte meanings:**
- `B0 01 C3` = `mov al, 1; ret` (return TRUE)
- `30 C0 C3` = `xor al, al; ret` (return FALSE)
- `C3` = `ret` (immediate return, preserve register state)

**Why these patches are needed:**
- Patches 1-2: Steamworks.NET calls `DllCheck.Test()` and `Packsize.Test()` before loading steam_api.dll. Our stub DLL is smaller than the original, so these checks fail. Patching them to return true allows the stub to load.
- Patch 3: `SteamAPI.Init()` is the main Steam initialization function. Patching it to return true makes the game think Steam is running.
- Patch 4: `SteamAPI.RestartAppIfNecessary()` would restart the game through Steam. Returning false skips this.
- Patches 5-6: `InteropHelp.TestIfAvailableClient/GameServer()` check if the Steamworks native library is loaded. Immediate return skips the check.
- Patch 7: `GamePlatformInfo.IsSteam()` returns whether the game is running on Steam. Returning false prevents `SteamUtils.GetIPCountry()` from being called (which would crash with the stub).
- Patch 8: `SteamManager.Initialized` property getter. Returning false makes the Lua `Tools.IsSteam()` function return false, so the game uses non-Steam code paths.

### 2. steam_api.dll (Stub Replacement)

The original `steam_api.dll` (263KB) is replaced with a stub DLL that:
- Exports all 1000+ original function names (same ordinals)
- `SteamAPI_Init()` → returns TRUE (1)
- `SteamAPI_RestartAppIfNecessary()` → returns FALSE (0)
- `SteamAPI_IsSteamRunning()` → returns TRUE (1)
- All `BIs*`, `BHas*`, `BLogged*` functions → return TRUE (1)
- All other functions → return 0/NULL

**Two build methods are provided:**

1. **Python PE builder** (`build_steam_stub_v5.py`):
   - Pure Python, no compiler needed
   - Reads export names from original DLL
   - Generates minimal PE32 DLL with x86 stub code
   - Used automatically by `patch_all.py`

2. **C source** (`steam_api_stub.c` + `steam_api_stub.def`):
   - Alternative for those who prefer C compilation
   - Compile with: `gcc -shared -o steam_api.dll steam_api_stub.c -Wl,--def=steam_api_stub.def`
   - Or with MSVC: `cl /LD steam_api_stub.c /link /DEF:steam_api_stub.def`

### 3. RuntimeInitializeOnLoads.json

**File location:** `Jantama_MahjongSoul_Data/RuntimeInitializeOnLoads.json`

**What's removed:** The `SteamManager` auto-initialization entry:
```json
{
  "className": "SteamManager",
  "methodName": "InitOnPlayMode"
}
```

This prevents Unity from automatically initializing SteamManager when the game starts.

### 4. ScriptingAssemblies.json

**File location:** `Jantama_MahjongSoul_Data/ScriptingAssemblies.json`

**What's removed:** The `com.rlabrecque.steamworks.net.dll` entry from the `names` array (and corresponding entry in `types` array if present).

This prevents the Steamworks.NET assembly from being loaded by Unity's scripting runtime.

### 5. config.json in .majset Files

**File location:** `Jantama_MahjongSoul_Data/StreamingAssets/StandaloneWindows/*.majset`

The `.majset` files are Unity AssetBundles containing `TextAsset` objects with JSON configuration. The patcher uses UnityPy to:

1. Load each `.majset` file that contains `"gateways"` in its config
2. Find the `TextAsset` with the gateway configuration JSON
3. Replace all gateway URLs with `http://127.0.0.1:8080`:
   - `ip[].gateways[].url`
   - `ip[].contest_chat_url`
   - `ip[].contest_gm_url`
   - `ip[].prefix_url`
   - `ip[].override_email_url`
   - `system_email_url`
   - `link_url`
4. Save the modified AssetBundle

### 6. Windows Hosts File

**File location:** `C:\Windows\System32\drivers\etc\hosts`

**15 domains redirected to 127.0.0.1:**

| Domain | Purpose |
|--------|---------|
| `mjusgs.mahjongsoul.com` | Main game server |
| `game.mahjongsoul.com` | Game server |
| `game.maj-soul.com` | Game server |
| `route-2~6.maj-soul.com` | Route servers (5 domains) |
| `www.maj-soul.com` | Web server |
| `common-202411.maj-soul.com` | Common resources |
| `record-old.maj-soul.com` | Game records |
| `contest-gate-202411.maj-soul.com` | Contest gateway |
| `app-update-1.catmajsoul.com` | Update server |
| `app-update-1.catmjstudio.com` | Update server |
| `app-update-2.catmjstudio.com` | Update server |

Entries are wrapped with markers for easy removal:
```
# >>> MahjongSoul Private Server - DO NOT EDIT >>>
127.0.0.1  mjusgs.mahjongsoul.com
...
# <<< MahjongSoul Private Server <<<
```

## Resource Files

The release includes pre-generated resource files in `server/public/app/v3/release/ab/StandaloneWindows/`:

- **AssetBundleConfig.json** (3.8MB) - Asset bundle configuration mapping
- **bundle_hash.txt** (750KB) - List of all bundle names with hashes and sizes

If you need to regenerate `bundle_hash.txt` for a different game version:
```bash
cd patch
python generate_bundle_hash.py "D:\Games\Jantama_MahjongSoul"
```

## Restore Original Files

All patches create backups. To restore:

```bash
cd patch
python patch_all.py --restore "D:\Games\Jantama_MahjongSoul"
```

This restores:
- `GameAssembly.dll` from `.original` backup
- `steam_api.dll` from `.original` backup
- `RuntimeInitializeOnLoads.json` from `.bak` backup
- `ScriptingAssemblies.json` from `.bak` backup
- All `.majset` files from `.original_config` backups
- Removes hosts file entries (between markers)

To only remove hosts entries:
```bash
python generate_hosts.py --uninstall
```

## Configuration

### Server Config (`server/config/default.json`)

```json
{
  "server": {
    "resource_port": 8440,
    "lobby_port": 8441,
    "game_port": 8443,
    "proxy_port": 23410,
    "host": "127.0.0.1",
    "game_data_dir": null
  },
  "game": {
    "init_gold": 999999,
    "init_diamond": 99999,
    "init_vip": 10,
    "unlock_all_characters": true,
    "unlock_all_skins": true,
    "unlock_all_items": true,
    "unlock_all_titles": true
  },
  "database": {
    "path": "data/mahjong_soul.db"
  },
  "game_data": {
    "path": "data/game_data"
  }
}
```

Set `game_data_dir` to your game's `Jantama_MahjongSoul_Data` directory, or set the `GAME_DATA_DIR` environment variable. The resource server uses this to serve `.majset` asset bundle files.

### Proxy Config (`patch/patch_config.json`)

```json
{
  "game_dir": "C:/Path/To/Jantama_MahjongSoul",
  "private_server_host": "127.0.0.1",
  "private_server_lobby_port": 8441,
  "private_server_game_port": 8443,
  "gateway_proxy_port": 8080,
  "resource_server_port": 8440
}
```

Edit `game_dir` to point to your game installation.

## Disclaimer

This project is for educational purposes only. It does not distribute any copyrighted game files. Users must own a legitimate copy of the game.

## License

MIT

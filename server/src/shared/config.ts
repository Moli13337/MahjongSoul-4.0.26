/**
 * 服务器配置模块
 * 从 config/default.json 加载配置，支持环境变量覆盖
 */
import * as path from 'path';
import * as fs from 'fs';

export interface ServerConfig {
  server: {
    resource_port: number;
    lobby_port: number;
    game_port: number;
    proxy_port: number;
    host: string;
    game_data_dir?: string;
  };
  game: {
    init_gold: number;
    init_diamond: number;
    init_skin_ticket: number;
    init_vip: number;
    init_character_level: number;
    unlock_all_characters: boolean;
    unlock_all_skins: boolean;
    unlock_all_items: boolean;
    unlock_all_titles: boolean;
    unlock_all_emojis: boolean;
  };
  database: {
    path: string;
  };
  game_data: {
    path: string;
  };
}

const DEFAULT_CONFIG: ServerConfig = {
  server: {
    resource_port: 8440,
    lobby_port: 8441,
    game_port: 8443,
    proxy_port: 23410,
    host: '127.0.0.1',
    game_data_dir: undefined,
  },
  game: {
    init_gold: 999999,
    init_diamond: 99999,
    init_skin_ticket: 9999,
    init_vip: 10,
    init_character_level: 5,
    unlock_all_characters: true,
    unlock_all_skins: true,
    unlock_all_items: true,
    unlock_all_titles: true,
    unlock_all_emojis: true,
  },
  database: {
    path: 'data/mahjong_soul.db',
  },
  game_data: {
    path: 'data/game_data',
  },
};

let _config: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  if (_config) return _config;

  const configPath = path.resolve(process.cwd(), 'config', 'default.json');
  let userConfig: Partial<ServerConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log(`[config] Loaded from ${configPath}`);
    } catch (e) {
      console.warn(`[config] Failed to parse ${configPath}:`, e);
    }
  } else {
    console.log(`[config] No config file found at ${configPath}, using defaults`);
  }

  _config = deepMerge(DEFAULT_CONFIG, userConfig);
  return _config;
}

export function getConfig(): ServerConfig {
  if (!_config) return loadConfig();
  return _config;
}

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = deepMerge(base[key], val as any) as any;
    } else if (val !== undefined) {
      result[key] = val as any;
    }
  }
  return result;
}

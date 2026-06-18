/**
 * 游戏数据加载模块
 * 从 data/game_data/*.json 加载游戏配置数据到内存
 */
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config';

export interface CharacterDef {
  id: number;
  sort?: number;
  init_skin?: number;
  full_fetter_skin?: number;
  sound_folder?: string;
  can_marry?: number;
  sex?: number;
  star_5_material?: string;
  star_5_cost?: number;
  exchange_item_id?: number;
  collaboration?: number;
  limited?: number;
  emo?: string;
}

export interface SkinDef {
  id: number;
  type?: number;
  name_chs?: number;
  character_id?: number;
  path?: string;
  exchange_item_id?: number;
  direction?: number;
  spine_type?: number;
  idle?: number;
  greeting?: number;
  celebrate?: number;
  click?: number;
}

export interface ItemDef {
  id: number;
  sort?: number;
  name_chs?: number;
  category?: number;
  type?: number;
  is_unique?: number;
  max_stack?: number;
  func?: number;
  iargs?: string;
  sargs?: string;
  can_sell?: number;
  icon?: string;
}

export interface TitleDef {
  id: number;
  name_chs?: number;
  desc_chs?: number;
  icon?: string;
  priority?: number;
  unlock_type?: number;
}

export interface CurrencyDef {
  id: number;
  name_chs?: number;
  desc_chs?: number;
  icon?: string;
}

export interface LevelDef {
  id: number;
  type?: number;
  primary_level?: number;
  secondary_level?: number;
  init_point?: number;
  end_point?: number;
}

export interface VipLevelDef {
  id: number;
  name_chs?: number;
  charge?: number;
  gift_limit?: number;
  friend_added?: number;
  shop_free_refresh?: number;
  title_id?: number;
}

export interface FanDef {
  id: number;
  name_chs?: number;
  yiman?: number;
  fan_menqing?: number;
  fan_fulu?: number;
  rarity?: number;
}

export interface GameData {
  characters: CharacterDef[];
  skins: SkinDef[];
  items: ItemDef[];
  titles: TitleDef[];
  currencies: CurrencyDef[];
  levels: LevelDef[];
  vip_levels: VipLevelDef[];
  fans: FanDef[];
  // Lookup maps (id -> entry)
  characterMap: Map<number, CharacterDef>;
  skinMap: Map<number, SkinDef>;
  itemMap: Map<number, ItemDef>;
  titleMap: Map<number, TitleDef>;
  currencyMap: Map<number, CurrencyDef>;
  levelMap: Map<number, LevelDef>;
  vipLevelMap: Map<number, VipLevelDef>;
  fanMap: Map<number, FanDef>;
  // Character -> skins mapping
  characterSkinsMap: Map<number, SkinDef[]>;
}

let _gameData: GameData | null = null;

function loadJsonArray<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`[game-data] File not found: ${filePath}`);
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return raw.entries || [];
}

function buildMap<T extends { id: number }>(entries: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const entry of entries) {
    map.set(entry.id, entry);
  }
  return map;
}

export function loadGameData(): GameData {
  const config = getConfig();
  const dataDir = path.resolve(process.cwd(), config.game_data.path);

  console.log(`[game-data] Loading from ${dataDir}...`);

  const characters = loadJsonArray<CharacterDef>(path.join(dataDir, 'characters.json'));
  const skins = loadJsonArray<SkinDef>(path.join(dataDir, 'skins.json'));
  const items = loadJsonArray<ItemDef>(path.join(dataDir, 'items.json'));
  const titles = loadJsonArray<TitleDef>(path.join(dataDir, 'titles.json'));
  const currencies = loadJsonArray<CurrencyDef>(path.join(dataDir, 'currencies.json'));
  const levels = loadJsonArray<LevelDef>(path.join(dataDir, 'levels.json'));
  const vip_levels = loadJsonArray<VipLevelDef>(path.join(dataDir, 'vip_levels.json'));
  const fans = loadJsonArray<FanDef>(path.join(dataDir, 'fans.json'));

  // Build character -> skins mapping
  const characterSkinsMap = new Map<number, SkinDef[]>();
  for (const skin of skins) {
    const charId = skin.character_id || 0;
    if (!characterSkinsMap.has(charId)) {
      characterSkinsMap.set(charId, []);
    }
    characterSkinsMap.get(charId)!.push(skin);
  }

  _gameData = {
    characters,
    skins,
    items,
    titles,
    currencies,
    levels,
    vip_levels,
    fans,
    characterMap: buildMap(characters),
    skinMap: buildMap(skins),
    itemMap: buildMap(items),
    titleMap: buildMap(titles),
    currencyMap: buildMap(currencies),
    levelMap: buildMap(levels),
    vipLevelMap: buildMap(vip_levels),
    fanMap: buildMap(fans),
    characterSkinsMap,
  };

  console.log(`[game-data] Loaded: ${characters.length} characters, ${skins.length} skins, ${items.length} items, ${titles.length} titles, ${levels.length} levels, ${vip_levels.length} VIP levels, ${fans.length} fans`);

  return _gameData;
}

export function getGameData(): GameData {
  if (!_gameData) return loadGameData();
  return _gameData;
}

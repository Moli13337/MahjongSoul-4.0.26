/**
 * Mahjong game engine - handles the core game logic for a single game.
 *
 * Supports 4-player (136 tiles) and 3-player (108 tiles, no 2-8m) riichi mahjong.
 * Implements: shuffling, dealing, draw/discard flow, chi/pon/kan, riichi, win detection.
 */

import { ALL_TILES, sortTiles, isRedFive, toNormalTile } from './tiles';

export enum OperationType {
  NONE = 0,        // No operation
  DISCARD = 1,     // Discard tile
  CHI = 2,         // Chi (chow)
  PON = 3,         // Pon (pung)
  ANKAN = 4,       // Ankan (closed kan)
  DAIMINKAN = 5,   // Daiminkan (open kan)
  KAKAN = 6,       // Kakan (added kan)
  REACH = 7,       // Reach (riichi)
  ZIMO = 8,        // Zimo (self-draw win)
  RON = 9,         // Ron (win on discard)
  RYUKYOKU = 10,   // Ryukyoku (abortive draw / nine gates)
  NUKIDORA = 11,   // Nukidora (three-player north tile)
}

export interface OptionalOp {
  type: OperationType;
  combination: string[];
}

export type GamePhase = 'waiting' | 'dealing' | 'selecting_gap' | 'playing' | 'finished';

export interface PlayerState {
  seat: number;
  hand: string[];        // tiles in hand (sorted)
  melds: Meld[];         // open melds
  discards: string[];    // discard pile
  isRiichi: boolean;
  score: number;
  furiten: boolean;           // 舍牌振听/立直振听
  temporaryFuriten: boolean;  // 同巡振听
  riichiTurn: number;         // 立直时的step（-1表示未立直）
  menzen: boolean;            // 是否门清（暗杠不影响）
  hasWon: boolean;            // 本局是否已胡牌（血战到底/川麻用）
  gapTiles: string[];         // 换三张选出的牌
}

export interface Meld {
  type: 'chi' | 'pon' | 'daiminkan' | 'ankan' | 'kakan' | 'nukidora';
  tiles: string[];
  from: number;          // seat of the player who provided the tile
}

export interface GameConfig {
  numPlayers: 3 | 4;
  initScore: number;
  aka: boolean;
  // Rule configuration (from detail_rule)
  timeFixed?: number;
  timeAdd?: number;
  doraCount?: number;
  shiduan?: boolean;
  haveJiuzhongjiupai?: boolean;
  haveSifenglianda?: boolean;
  haveSigangsanle?: boolean;
  haveSijializhi?: boolean;
  haveYifa?: boolean;
  // P4: Special modes
  xuezhandaodi?: boolean;       // 血战到底
  chuanma?: boolean;            // 川麻模式
  huansanzhang?: boolean;       // 换三张
  guyiMode?: boolean;           // 古役模式
  dora3Mode?: boolean;          // 宝牌狂热
  beginOpenMode?: boolean;      // 起手配牌公开
  jiuchaoMode?: boolean;        // 九朝模式
  muyuMode?: boolean;           // 木鱼模式
  openHand?: boolean;           // 明牌
  revealDiscard?: boolean;      // 舍牌公开
  fieldSpellMode?: boolean;     // 场地魔法
  zhanxingMode?: boolean;       // 占星
  tianmingMode?: boolean;       // 天命
  yongchangMode?: boolean;      // 咏唱
  hunzhiyijiMode?: boolean;     // 魂之一击
  wanxiangxiuluoMode?: boolean; // 万象修罗
  beishuizhizhanMode?: boolean; // 背水之战
}

const DEFAULT_CONFIG: GameConfig = {
  numPlayers: 4,
  initScore: 25000,
  aka: true,
};

export class MahjongEngine {
  players: PlayerState[];
  wall: string[] = [];           // remaining wall tiles
  doraIndicators: string[] = []; // dora indicator tiles
  uraDoraIndicators: string[] = [];
  phase: GamePhase = 'waiting';
  currentTurn: number = 0;       // seat of current player
  dealer: number = 0;
  round: number = 0;             // chang (0=E, 1=S, 2=W)
  ju: number = 0;                // dealer index within round
  honba: number = 0;
  riichiSticks: number = 0;
  step: number = 0;
  lastDiscard: { seat: number; tile: string } | null = null;
  gapSelected: boolean[] = [];  // which players have selected gap tiles
  config: GameConfig;

  constructor(config: Partial<GameConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.players = [];
    for (let i = 0; i < this.config.numPlayers; i++) {
      this.players.push({
        seat: i,
        hand: [],
        melds: [],
        discards: [],
        isRiichi: false,
        score: this.config.initScore,
        furiten: false,
        temporaryFuriten: false,
        riichiTurn: -1,
        menzen: true,
        hasWon: false,
        gapTiles: [],
      });
    }
  }

  /** Initialize and start a new round */
  startRound(chang: number = 0, ju: number = 0, ben: number = 0, liqibang: number = 0): NewRoundData {
    this.round = chang;
    this.ju = ju;
    this.dealer = ju;
    this.honba = ben;
    this.riichiSticks = liqibang;
    this.step = 0;
    this.phase = 'playing';
    this.lastDiscard = null;

    // Build and shuffle the wall
    this.wall = this.buildWall();
    this.shuffleWall();

    // Set dora indicators (first 5 from the dead wall portion)
    // Dead wall = last 14 tiles. Dora indicators at positions 4,6,8,10,12 from end.
    const deadWallStart = this.wall.length - 14;
    // Set dora indicators
    const initialDoraCount = this.config.dora3Mode ? 3 : 1;
    this.doraIndicators = [];
    for (let d = 0; d < initialDoraCount; d++) {
      this.doraIndicators.push(this.wall[deadWallStart + 4 + d * 2]);
    }
    this.uraDoraIndicators = [
      this.wall[deadWallStart + 5],
      this.wall[deadWallStart + 7],
      this.wall[deadWallStart + 9],
      this.wall[deadWallStart + 11],
      this.wall[deadWallStart + 13],
    ];

    // Deal tiles to each player
    const dealStart = 0;
    const handSize = 13;
    for (let i = 0; i < this.config.numPlayers; i++) {
      this.players[i].hand = this.wall.slice(
        dealStart + i * handSize,
        dealStart + (i + 1) * handSize
      );
      sortTiles(this.players[i].hand);
      this.players[i].melds = [];
      this.players[i].discards = [];
      this.players[i].isRiichi = false;
      this.players[i].furiten = false;
      this.players[i].temporaryFuriten = false;
      this.players[i].riichiTurn = -1;
      this.players[i].menzen = true;
      this.players[i].hasWon = false;
      this.players[i].gapTiles = [];
    }

    // Remove dealt tiles from wall
    const totalDealt = handSize * this.config.numPlayers;
    this.wall = this.wall.slice(totalDealt);

    // Dealer draws their first tile (14th)
    const dealerDraw = this.wall.shift()!;
    this.players[this.dealer].hand.push(dealerDraw);
    this.currentTurn = this.dealer;

    // If huansanzhang mode, enter selecting_gap phase
    if (this.config.huansanzhang) {
      this.phase = 'selecting_gap';
      this.gapSelected = new Array(this.config.numPlayers).fill(false);
    }

    return {
      chang,
      ju,
      ben,
      liqibang,
      doraIndicators: [...this.doraIndicators],
      scores: this.players.map(p => p.score),
      hands: this.players.map(p => [...p.hand]),
      leftTileCount: this.wall.length - 14,
      dealer: this.dealer,
    };
  }

  /** Build the tile wall based on player count */
  private buildWall(): string[] {
    const tiles: string[] = [];

    if (this.config.numPlayers === 3) {
      // 3-player: no 2m-8m, only 1m,9m and all p/s/z
      const manTiles = ['1m', '9m'];

      for (const tile of manTiles) {
        tiles.push(tile, tile, tile, tile);
      }
      // Pin and Sou: full set
      for (const base of ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p']) {
        tiles.push(base, base, base, base);
      }
      if (this.config.aka) {
        // Replace one 5p with 0p
        const idx = tiles.indexOf('5p');
        if (idx >= 0) tiles[idx] = '0p';
      }
      for (const base of ['1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s']) {
        tiles.push(base, base, base, base);
      }
      if (this.config.aka) {
        const idx = tiles.indexOf('5s');
        if (idx >= 0) tiles[idx] = '0s';
      }
      // Honors
      for (const base of ['1z', '2z', '3z', '4z', '5z', '6z', '7z']) {
        tiles.push(base, base, base, base);
      }
    } else {
      // 4-player: full 136 tiles
      for (const tile of ALL_TILES) {
        if (isRedFive(tile)) continue; // red fives replace normal 5s
        tiles.push(tile, tile, tile, tile);
      }
      if (this.config.aka) {
        // Add red fives (replace one of each normal 5)
        tiles.push('0m', '0p', '0s');
        // Remove one normal 5 of each suit
        for (const t of ['5m', '5p', '5s']) {
          const idx = tiles.indexOf(t);
          if (idx >= 0) tiles.splice(idx, 1);
        }
      }
    }

    return tiles;
  }

  /** Fisher-Yates shuffle */
  private shuffleWall(): void {
    for (let i = this.wall.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.wall[i], this.wall[j]] = [this.wall[j], this.wall[i]];
    }
  }

  /** Draw a tile for the current player */
  drawTile(seat: number): DrawResult | null {
    if (this.wall.length <= 14) return null;

    const tile = this.wall.shift()!;
    this.players[seat].hand.push(tile);
    this.step++;

    return {
      seat,
      tile,
      leftTileCount: this.wall.length - 14,
      doraIndicators: [...this.doraIndicators],
    };
  }

  /** Draw a rinshan tile (after kan) from the dead wall */
  drawRinshan(seat: number): DrawResult | null {
    if (this.wall.length <= 14) return null;
    // Draw from the end of the dead wall (position wall.length - 14)
    const tile = this.wall.splice(this.wall.length - 14, 1)[0];
    this.players[seat].hand.push(tile);
    this.step++;
    return { seat, tile, leftTileCount: this.wall.length - 14, doraIndicators: [...this.doraIndicators] };
  }

  /** Discard a tile from a player's hand */
  discardTile(seat: number, tile: string, moqie: boolean = false): DiscardResult {
    const hand = this.players[seat].hand;
    const idx = hand.findIndex(t => toNormalTile(t) === toNormalTile(tile));
    if (idx === -1) {
      throw new Error(`Player ${seat} does not have tile ${tile} in hand`);
    }
    const actualTile = hand.splice(idx, 1)[0];
    this.players[seat].discards.push(actualTile);
    this.lastDiscard = { seat, tile: actualTile };
    this.step++;

    // Clear temporary furiten for this player (they made a discard)
    this.players[seat].temporaryFuriten = false;

    // Update furiten for all players (discard may change waits)
    for (let i = 0; i < this.config.numPlayers; i++) {
      this.updateFuriten(i);
    }

    return {
      seat,
      tile: actualTile,
      moqie,
      step: this.step,
    };
  }

  /** Check if any player can call the last discard */
  checkCalls(): CallOption[] {
    if (!this.lastDiscard) return [];

    const options: CallOption[] = [];
    const { seat: fromSeat, tile } = this.lastDiscard;

    for (let i = 0; i < this.config.numPlayers; i++) {
      if (i === fromSeat) continue;

      const hand = this.players[i].hand;

      // Check pon
      const count = hand.filter(t => toNormalTile(t) === toNormalTile(tile)).length;
      if (count >= 2) {
        options.push({ seat: i, type: 'pon', tile, from: fromSeat });
      }

      // Check kan (daiminkan)
      if (count >= 3) {
        options.push({ seat: i, type: 'daiminkan', tile, from: fromSeat });
      }

      // Check chi (only from kamicha)
      if (i === (fromSeat + 1) % this.config.numPlayers) {
        const chiOptions = this.findChiOptions(hand, tile);
        for (const chi of chiOptions) {
          options.push({ seat: i, type: 'chi', tile, from: fromSeat, consumed: chi });
        }
      }

      // Check ron (skip if furiten)
      if (!this.players[i].furiten && !this.players[i].temporaryFuriten && this.canWin(i, tile)) {
        options.push({ seat: i, type: 'ron', tile, from: fromSeat });
      }
    }

    return options;
  }

  /** Find possible chi combinations for a tile */
  private findChiOptions(hand: string[], tile: string): string[][] {
    const results: string[][] = [];
    const normal = toNormalTile(tile);
    const suit = normal[1]; // 'm', 'p', 's'
    const num = parseInt(normal[0]);

    if (isNaN(num) || suit === 'z') return results; // honors can't form chi

    // Three possible chi patterns containing this tile
    const patterns = [
      [num - 2, num - 1],  // tile is the high end
      [num - 1, num + 1],  // tile is the middle
      [num + 1, num + 2],  // tile is the low end
    ];

    for (const [a, b] of patterns) {
      if (a < 1 || b < 1 || a > 9 || b > 9) continue;
      const tileA = `${a}${suit}`;
      const tileB = `${b}${suit}`;
      // Check if hand has both tiles (accounting for red fives)
      const hasA = hand.some(t => toNormalTile(t) === tileA);
      const hasB = hand.some(t => toNormalTile(t) === tileB);
      if (hasA && hasB) {
        // Find actual tile strings (prefer non-red)
        const actualA = hand.find(t => toNormalTile(t) === tileA) || tileA;
        const actualB = hand.find(t => toNormalTile(t) === tileB) || tileB;
        results.push([actualA, actualB]);
      }
    }

    return results;
  }

  /** Win check - supports standard form, chiitoi (seven pairs), and kokushi (thirteen orphans) */
  canWin(seat: number, extraTile?: string): boolean {
    // Already won player cannot win again (blood battle mode)
    if (this.players[seat].hasWon) return false;

    const hand = [...this.players[seat].hand];
    if (extraTile) hand.push(extraTile);

    if (hand.length % 3 !== 2) return false;

    // Standard form: 4 melds + 1 pair
    if (this.checkTenpai(hand)) return true;
    // Chiitoi: 7 pairs (closed hand only)
    if (this.checkChiitoi(hand)) return true;
    // Kokushi: 13 terminals/honors + 1
    if (this.checkKokushi(hand)) return true;

    return false;
  }

  /** Basic tenpai check using recursive meld decomposition */
  private checkTenpai(tiles: string[]): boolean {
    if (tiles.length === 0) return true;
    if (tiles.length % 3 !== 2) return false;

    // Try each pair as the head
    const sorted = sortTiles([...tiles]);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (toNormalTile(sorted[i]) === toNormalTile(sorted[i + 1])) {
        const remaining = [...sorted];
        remaining.splice(i, 2);
        if (this.canDecompose(remaining)) return true;
      }
    }

    return false;
  }

  /** Check if tiles can be decomposed into complete melds (triplets/sequences) */
  private canDecompose(tiles: string[]): boolean {
    if (tiles.length === 0) return true;
    if (tiles.length % 3 !== 0) return false;

    const sorted = sortTiles([...tiles]);
    const first = sorted[0];
    const normal = toNormalTile(first);

    // Try triplet
    const tripletCount = sorted.filter(t => toNormalTile(t) === normal).length;
    if (tripletCount >= 3) {
      const remaining = [...sorted];
      for (let i = 0; i < 3; i++) {
        const idx = remaining.findIndex(t => toNormalTile(t) === normal);
        remaining.splice(idx, 1);
      }
      if (this.canDecompose(remaining)) return true;
    }

    // Try sequence (only for numbered suits)
    const suit = normal[1];
    const num = parseInt(normal[0]);
    if (!isNaN(num) && suit !== 'z' && num <= 7) {
      const hasA = sorted.some(t => toNormalTile(t) === `${num}${suit}`);
      const hasB = sorted.some(t => toNormalTile(t) === `${num + 1}${suit}`);
      const hasC = sorted.some(t => toNormalTile(t) === `${num + 2}${suit}`);

      if (hasA && hasB && hasC) {
        const remaining = [...sorted];
        for (const target of [`${num}${suit}`, `${num + 1}${suit}`, `${num + 2}${suit}`]) {
          const idx = remaining.findIndex(t => toNormalTile(t) === target);
          if (idx >= 0) remaining.splice(idx, 1);
        }
        if (this.canDecompose(remaining)) return true;
      }
    }

    return false;
  }

  /** Check if player is tenpai (waiting for one tile to win) */
  isTenpai(seat: number): boolean {
    const hand = this.players[seat].hand;
    if (hand.length % 3 !== 1) return false;

    const allTileNames = ['1m','2m','3m','4m','5m','6m','7m','8m','9m',
                          '1p','2p','3p','4p','5p','6p','7p','8p','9p',
                          '1s','2s','3s','4s','5s','6s','7s','8s','9s',
                          '1z','2z','3z','4z','5z','6z','7z'];

    for (const waitTile of allTileNames) {
      if (this.countTileAvailability(waitTile) <= 0) continue;
      const testHand = [...hand, waitTile];
      if (this.canWinWithTiles(testHand)) return true;
    }
    return false;
  }

  /** Count how many of a tile are still available (4 - all visible) */
  private countTileAvailability(tileName: string): number {
    let used = 0;
    for (const p of this.players) {
      used += p.hand.filter(t => toNormalTile(t) === tileName).length;
      used += p.discards.filter(t => toNormalTile(t) === tileName).length;
      for (const m of p.melds) {
        used += m.tiles.filter(t => toNormalTile(t) === tileName).length;
      }
    }
    used += this.doraIndicators.filter(t => toNormalTile(t) === tileName).length;
    used += this.uraDoraIndicators.filter(t => toNormalTile(t) === tileName).length;
    return 4 - used;
  }

  /** Check if a set of 14 tiles can form a complete winning hand */
  private canWinWithTiles(tiles: string[]): boolean {
    if (tiles.length % 3 !== 2) return false;
    // Standard form
    const sorted = sortTiles([...tiles]);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (toNormalTile(sorted[i]) === toNormalTile(sorted[i + 1])) {
        const remaining = [...sorted];
        remaining.splice(i, 2);
        if (this.canDecompose(remaining)) return true;
      }
    }
    // Chiitoi
    if (this.checkChiitoi(tiles)) return true;
    // Kokushi
    if (this.checkKokushi(tiles)) return true;
    return false;
  }

  /** Check for chiitoi (seven pairs): exactly 7 distinct tiles, each appearing exactly 2 times */
  private checkChiitoi(tiles: string[]): boolean {
    if (tiles.length !== 14) return false;
    if (this.players.length > 0) {
      // Chiitoi requires closed hand (no melds)
      // Find the player whose hand we're checking (by matching hand length)
      // For standalone tile array check, just verify the pattern
    }
    const counts = new Map<string, number>();
    for (const t of tiles) {
      const n = toNormalTile(t);
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    if (counts.size !== 7) return false;
    for (const c of counts.values()) {
      if (c !== 2) return false;
    }
    return true;
  }

  /** Check for kokushi (thirteen orphans): one of each terminal/honor + one duplicate */
  private checkKokushi(tiles: string[]): boolean {
    if (tiles.length !== 14) return false;
    const terminals = ['1m','9m','1p','9p','1s','9s','1z','2z','3z','4z','5z','6z','7z'];
    const counts = new Map<string, number>();
    for (const t of tiles) {
      const n = toNormalTile(t);
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    let hasPair = false;
    for (const t of terminals) {
      const c = counts.get(t) || 0;
      if (c === 0) return false;
      if (c >= 2) hasPair = true;
    }
    return hasPair;
  }

  /** Get the list of tiles a player is waiting for (tenpai) */
  getWaitTiles(seat: number): string[] {
    const hand = this.players[seat].hand;
    if (hand.length % 3 !== 1) return [];

    const waits: string[] = [];
    const allTileNames = ['1m','2m','3m','4m','5m','6m','7m','8m','9m',
                          '1p','2p','3p','4p','5p','6p','7p','8p','9p',
                          '1s','2s','3s','4s','5s','6s','7s','8s','9s',
                          '1z','2z','3z','4z','5z','6z','7z'];

    for (const waitTile of allTileNames) {
      if (this.countTileAvailability(waitTile) <= 0) continue;
      const testHand = [...hand, waitTile];
      if (this.canWinWithTiles(testHand)) waits.push(waitTile);
    }
    return waits;
  }

  /** Update furiten state for a player (call after discard or meld change) */
  updateFuriten(seat: number): void {
    const player = this.players[seat];
    // Riichi furiten is permanent
    if (player.furiten && player.isRiichi) return;

    const waits = this.getWaitTiles(seat);
    if (waits.length === 0) {
      player.furiten = false;
      return;
    }

    // Discard furiten: check if any wait tile is in the player's discards
    player.furiten = waits.some(w =>
      player.discards.some(d => toNormalTile(d) === w)
    );
  }

  /** Check if player can declare ryukyoku (nine different terminals/honors in opening hand) */
  canDeclareRyukyoku(seat: number): boolean {
    const hand = this.players[seat].hand;
    if (hand.length !== 14) return false;
    // Only on the first turn (step < numPlayers means no one has discarded yet)
    if (this.step > this.config.numPlayers) return false;
    const terminalHonor = hand.filter(t => {
      const n = toNormalTile(t);
      const num = parseInt(n[0]);
      const suit = n[1];
      return suit === 'z' || num === 1 || num === 9;
    });
    const unique = new Set(terminalHonor.map(toNormalTile));
    return unique.size >= 9;
  }

  /** Apply a pon call */
  applyPon(seat: number, fromSeat: number, tile: string): void {
    const hand = this.players[seat].hand;
    const consumed: string[] = [];

    // Remove 2 matching tiles from hand
    for (let i = 0; i < 2; i++) {
      const idx = hand.findIndex(t => toNormalTile(t) === toNormalTile(tile));
      if (idx >= 0) {
        consumed.push(hand.splice(idx, 1)[0]);
      }
    }

    this.players[seat].melds.push({
      type: 'pon',
      tiles: [tile, ...consumed],
      from: fromSeat,
    });

    this.players[seat].menzen = false;
    this.currentTurn = seat;
    this.lastDiscard = null;
    this.step++;
  }

  /** Apply a chi call */
  applyChi(seat: number, fromSeat: number, tile: string, consumed: string[]): void {
    const hand = this.players[seat].hand;

    // Remove consumed tiles from hand
    for (const c of consumed) {
      const idx = hand.findIndex(t => toNormalTile(t) === toNormalTile(c));
      if (idx >= 0) hand.splice(idx, 1);
    }

    this.players[seat].melds.push({
      type: 'chi',
      tiles: [tile, ...consumed],
      from: fromSeat,
    });

    this.players[seat].menzen = false;
    this.currentTurn = seat;
    this.lastDiscard = null;
    this.step++;
  }

  /** Apply a daiminkan (open kan from discard) */
  applyDaiminkan(seat: number, fromSeat: number, tile: string): void {
    const hand = this.players[seat].hand;
    const consumed: string[] = [];

    // Remove 3 matching tiles from hand
    for (let i = 0; i < 3; i++) {
      const idx = hand.findIndex(t => toNormalTile(t) === toNormalTile(tile));
      if (idx >= 0) {
        consumed.push(hand.splice(idx, 1)[0]);
      }
    }

    this.players[seat].melds.push({
      type: 'daiminkan',
      tiles: [tile, ...consumed],
      from: fromSeat,
    });

    this.players[seat].menzen = false;
    // Add new dora indicator
    this.addDoraIndicator();

    this.currentTurn = seat;
    this.lastDiscard = null;
    this.step++;
  }

  /** Apply an ankan (closed kan from hand) */
  applyAnkan(seat: number, tile: string): void {
    const hand = this.players[seat].hand;
    const consumed: string[] = [];

    // Remove 4 matching tiles from hand
    for (let i = 0; i < 4; i++) {
      const idx = hand.findIndex(t => toNormalTile(t) === toNormalTile(tile));
      if (idx >= 0) {
        consumed.push(hand.splice(idx, 1)[0]);
      }
    }

    this.players[seat].melds.push({
      type: 'ankan',
      tiles: consumed,
      from: seat,
    });

    // Add new dora indicator
    this.addDoraIndicator();

    this.currentTurn = seat;
    this.step++;
  }

  /** Apply a kakan (added kan on existing pon) */
  applyKakan(seat: number, tile: string): void {
    const hand = this.players[seat].hand;

    // Remove the tile from hand
    const idx = hand.findIndex(t => toNormalTile(t) === toNormalTile(tile));
    if (idx >= 0) hand.splice(idx, 1);

    // Find the existing pon and upgrade it
    const ponMeld = this.players[seat].melds.find(
      m => m.type === 'pon' && toNormalTile(m.tiles[0]) === toNormalTile(tile)
    );
    if (ponMeld) {
      ponMeld.type = 'kakan';
      ponMeld.tiles.push(tile);
    }

    // Add new dora indicator
    this.addDoraIndicator();

    this.currentTurn = seat;
    this.step++;
  }

  /** Apply nukidora (remove north wind from hand as a special meld, 3-player only) */
  applyNukidora(seat: number, tile: string): void {
    const hand = this.players[seat].hand;
    const idx = hand.findIndex(t => toNormalTile(t) === toNormalTile(tile));
    if (idx === -1) {
      throw new Error(`Player ${seat} does not have tile ${tile} for nukidora`);
    }
    const actualTile = hand.splice(idx, 1)[0];
    this.players[seat].melds.push({
      type: 'nukidora',
      tiles: [actualTile],
      from: seat,
    });
    // Nukidora does NOT break menzen
    // Add new dora indicator(s)
    const deadWallStart = this.wall.length - 14;
    const doraToAdd = this.config.dora3Mode ? 2 : 1;
    for (let d = 0; d < doraToAdd; d++) {
      const nextIdx = this.doraIndicators.length;
      if (nextIdx < 5) {
        this.doraIndicators.push(this.wall[deadWallStart + 4 + nextIdx * 2]);
      }
    }
    this.step++;
  }

  /** Add a new dora indicator (after kan) */
  private addDoraIndicator(): void {
    const deadWallStart = this.wall.length - 14;
    // Add new dora indicator(s)
    const doraToAdd = this.config.dora3Mode ? 2 : 1;
    for (let d = 0; d < doraToAdd; d++) {
      const nextIdx = this.doraIndicators.length;
      if (nextIdx < 5) {
        this.doraIndicators.push(this.wall[deadWallStart + 4 + nextIdx * 2]);
      }
    }
  }

  /** Get available self-draw operations (after drawing: zimo/ankan/kakan/riichi) */
  getSelfOperations(seat: number): OptionalOp[] {
    // Already won player has no operations
    if (this.players[seat].hasWon) return [];

    const ops: OptionalOp[] = [];

    // Check zimo (self-draw win) — 14 tiles already form winning hand
    if (this.canWin(seat)) {
      ops.push({ type: OperationType.ZIMO, combination: [] });
    }

    // Check ankan
    const ankanOptions = this.findAnkanOptions(seat);
    for (const tile of ankanOptions) {
      ops.push({ type: OperationType.ANKAN, combination: [tile] });
    }

    // Check kakan
    const kakanOptions = this.findKakanOptions(seat);
    for (const tile of kakanOptions) {
      ops.push({ type: OperationType.KAKAN, combination: [tile] });
    }

    // Check nukidora (3-player only: remove north wind 4z)
    if (this.config.numPlayers === 3) {
      const nukiOptions = this.findNukidoraOptions(seat);
      for (const tile of nukiOptions) {
        ops.push({ type: OperationType.NUKIDORA, combination: [tile] });
      }
    }

    // Check reach (riichi) — tenpai state (13 tiles waiting for one)
    if (!this.players[seat].isRiichi && this.players[seat].menzen && this.isTenpai(seat)) {
      ops.push({ type: OperationType.REACH, combination: [] });
    }

    // Check ryukyoku (nine terminals/honors)
    if (this.canDeclareRyukyoku(seat)) {
      ops.push({ type: OperationType.RYUKYOKU, combination: [] });
    }

    return ops;
  }

  /** Get available call operations (after someone discards: chi/pon/kan/ron) */
  getCallOperations(seat: number): OptionalOp[] {
    if (!this.lastDiscard) return [];
    // Already won player cannot call
    if (this.players[seat].hasWon) return [];

    const ops: OptionalOp[] = [];
    const { seat: fromSeat, tile } = this.lastDiscard;
    if (seat === fromSeat) return ops;

    const hand = this.players[seat].hand;
    const player = this.players[seat];

    // Check ron (skip if furiten)
    if (!player.furiten && !player.temporaryFuriten && this.canWin(seat, tile)) {
      ops.push({ type: OperationType.RON, combination: [] });
    }

    // Check daiminkan (open kan from discard)
    const count = hand.filter(t => toNormalTile(t) === toNormalTile(tile)).length;
    if (count >= 3) {
      ops.push({ type: OperationType.DAIMINKAN, combination: [tile] });
    }

    // Check pon
    if (count >= 2) {
      ops.push({ type: OperationType.PON, combination: [tile] });
    }

    // Check chi (only from kamicha)
    if (seat === (fromSeat + 1) % this.config.numPlayers) {
      const chiOptions = this.findChiOptions(hand, tile);
      for (const chi of chiOptions) {
        ops.push({ type: OperationType.CHI, combination: chi });
      }
    }

    return ops;
  }

  /** Find tiles that can be used for ankan (4 of same tile in hand) */
  private findAnkanOptions(seat: number): string[] {
    const hand = this.players[seat].hand;
    const counts = new Map<string, number>();
    for (const tile of hand) {
      const normal = toNormalTile(tile);
      counts.set(normal, (counts.get(normal) || 0) + 1);
    }
    const results: string[] = [];
    for (const [tile, count] of counts) {
      if (count >= 4) {
        results.push(tile);
      }
    }
    return results;
  }

  /** Find tiles that can be used for kakan (have pon + 4th tile in hand) */
  private findKakanOptions(seat: number): string[] {
    const hand = this.players[seat].hand;
    const results: string[] = [];
    for (const meld of this.players[seat].melds) {
      if (meld.type === 'pon') {
        const ponTile = toNormalTile(meld.tiles[0]);
        // Check if hand has the 4th tile
        if (hand.some(t => toNormalTile(t) === ponTile)) {
          results.push(ponTile);
        }
      }
    }
    return results;
  }

  /** Find tiles that can be used for nukidora (north wind in 3-player) */
  private findNukidoraOptions(seat: number): string[] {
    const hand = this.players[seat].hand;
    const options: string[] = [];
    for (const t of hand) {
      if (toNormalTile(t) === '4z') {
        options.push(t);
        break; // Only need one option
      }
    }
    return options;
  }

  /** Check if player can declare riichi */
  canRiichi(seat: number): boolean {
    if (this.players[seat].isRiichi) return false;
    if (!this.players[seat].menzen) return false; // must be closed hand (ankan doesn't break menzen)
    return this.isTenpai(seat);
  }

  /** Check if the round ends in exhaustive draw (no tiles left) */
  isExhaustiveDraw(): boolean {
    return this.wall.length <= 14 && this.phase === 'playing';
  }

  /** Get the next player's seat */
  nextSeat(seat: number): number {
    return (seat + 1) % this.config.numPlayers;
  }

  /** Get player's hand tiles (for the human player) */
  getPlayerHand(seat: number): string[] {
    return [...this.players[seat].hand];
  }

  /** Get current game state summary */
  getGameState(): GameState {
    return {
      phase: this.phase,
      currentTurn: this.currentTurn,
      dealer: this.dealer,
      round: this.round,
      ju: this.ju,
      honba: this.honba,
      riichiSticks: this.riichiSticks,
      step: this.step,
      leftTileCount: this.wall.length - 14,
      doraIndicators: [...this.doraIndicators],
      players: this.players.map(p => ({
        seat: p.seat,
        handSize: p.hand.length,
        meldCount: p.melds.length,
        discardCount: p.discards.length,
        isRiichi: p.isRiichi,
        score: p.score,
      })),
    };
  }

  /** Check if the current round is over */
  isRoundOver(): boolean {
    if (this.config.xuezhandaodi || this.config.chuanma) {
      // Blood battle: round ends when only 0 or 1 player hasn't won
      const activePlayers = this.players.filter(p => !p.hasWon);
      return activePlayers.length <= 1;
    }
    // Normal: round ends when anyone wins (handled by caller)
    return false;
  }

  /** Select gap tiles for huansanzhang mode */
  selectGapTiles(seat: number, tiles: string[]): void {
    if (this.phase !== 'selecting_gap') throw new Error('Not in selecting_gap phase');
    if (tiles.length !== 3) throw new Error('Must select exactly 3 tiles');

    // Validate all tiles are same suit
    const suits = new Set(tiles.map(t => toNormalTile(t)[1]));
    if (suits.size !== 1) throw new Error('Gap tiles must be same suit');

    // Validate tiles exist in hand
    const hand = [...this.players[seat].hand];
    for (const t of tiles) {
      const idx = hand.findIndex(h => toNormalTile(h) === toNormalTile(t));
      if (idx === -1) throw new Error(`Tile ${t} not in hand`);
      hand.splice(idx, 1);
    }

    this.players[seat].gapTiles = tiles;
    this.gapSelected[seat] = true;
  }

  /** Check if all players have selected gap tiles */
  isAllGapSelected(): boolean {
    return this.gapSelected.every(s => s);
  }

  /** Execute gap tile exchange (pass to next player) */
  exchangeGapTiles(): { seat: number; received: string[] }[] {
    if (!this.isAllGapSelected()) throw new Error('Not all players selected gap tiles');

    const results: { seat: number; received: string[] }[] = [];
    const n = this.config.numPlayers;

    // Collect gap tiles from each player
    const gapTilesBySeat: string[][] = [];
    for (let i = 0; i < n; i++) {
      gapTilesBySeat.push([...this.players[i].gapTiles]);
    }

    // Exchange: pass to next player (seat + 1)
    for (let i = 0; i < n; i++) {
      const fromSeat = i;
      const toSeat = (i + 1) % n;

      // Remove gap tiles from source hand
      for (const t of this.players[fromSeat].gapTiles) {
        const idx = this.players[fromSeat].hand.findIndex(h => toNormalTile(h) === toNormalTile(t));
        if (idx >= 0) this.players[fromSeat].hand.splice(idx, 1);
      }

      // Add received tiles to target hand
      this.players[toSeat].hand.push(...gapTilesBySeat[fromSeat]);
      sortTiles(this.players[toSeat].hand);

      results.push({ seat: toSeat, received: gapTilesBySeat[fromSeat] });
      this.players[toSeat].gapTiles = [];
    }

    // Reset gap state
    this.gapSelected = new Array(n).fill(false);
    this.phase = 'playing';

    return results;
  }

  /** Mark a player as having won (for blood battle mode) */
  markPlayerWon(seat: number): void {
    this.players[seat].hasWon = true;
  }

  /** Get initial dora count based on mode */
  getInitialDoraCount(): number {
    return this.config.dora3Mode ? 3 : 1;
  }
}

export interface NewRoundData {
  chang: number;
  ju: number;
  ben: number;
  liqibang: number;
  doraIndicators: string[];
  scores: number[];
  hands: string[][];
  leftTileCount: number;
  dealer: number;
}

export interface DrawResult {
  seat: number;
  tile: string;
  leftTileCount: number;
  doraIndicators: string[];
}

export interface DiscardResult {
  seat: number;
  tile: string;
  moqie: boolean;
  step: number;
}

export interface CallOption {
  seat: number;
  type: 'chi' | 'pon' | 'daiminkan' | 'ron';
  tile: string;
  from: number;
  consumed?: string[];
}

export interface GameState {
  phase: GamePhase;
  currentTurn: number;
  dealer: number;
  round: number;
  ju: number;
  honba: number;
  riichiSticks: number;
  step: number;
  leftTileCount: number;
  doraIndicators: string[];
  players: {
    seat: number;
    handSize: number;
    meldCount: number;
    discardCount: number;
    isRiichi: boolean;
    score: number;
  }[];
}

/**
 * Improved AI player with shanten number calculation.
 *
 * Strategy: minimize shanten (distance to tenpai), only call when beneficial,
 * always riichi when tenpai with closed hand.
 */

import { MahjongEngine, CallOption, OperationType, Meld } from './mahjong-engine';
import { toNormalTile } from './tiles';

export class AIPlayer {
  private engine: MahjongEngine;
  public readonly seat: number;

  constructor(engine: MahjongEngine, seat: number) {
    this.engine = engine;
    this.seat = seat;
  }

  /** Choose which tile to discard */
  chooseDiscard(): string {
    const hand = this.engine.getPlayerHand(this.seat);
    if (hand.length === 0) throw new Error('No tiles to discard');

    // Riichi player must discard the last drawn tile (tsumogiri)
    if (this.engine.players[this.seat].isRiichi) {
      return hand[hand.length - 1];
    }

    const melds = this.engine.players[this.seat].melds;
    const currentShanten = this.calculateShanten(hand, melds);

    let bestTile = hand[0];
    let bestShanten = Infinity;
    let bestScore = -Infinity;

    for (const tile of hand) {
      const remaining = hand.filter((t, i) => {
        const idx = hand.indexOf(tile);
        return i !== idx || hand.indexOf(tile) !== i;
      });
      // Remove one instance of this tile
      const testHand = [...hand];
      const removeIdx = testHand.indexOf(tile);
      if (removeIdx === -1) continue;
      testHand.splice(removeIdx, 1);

      const shanten = this.calculateShanten(testHand, melds);
      const usefulness = this.evaluateTileUsefulness(tile, hand);

      // Prefer lower shanten, then less useful tiles
      if (shanten < bestShanten || (shanten === bestShanten && usefulness < bestScore)) {
        bestShanten = shanten;
        bestScore = usefulness;
        bestTile = tile;
      }
    }

    return bestTile;
  }

  /** Choose whether to call on a discard */
  chooseCall(options: CallOption[]): CallOption | null {
    if (options.length === 0) return null;

    const player = this.engine.players[this.seat];
    const hand = [...player.hand];
    const melds = [...player.melds];
    const currentShanten = this.calculateShanten(hand, melds);

    // Priority: ron > daiminkan > pon > chi
    // Skip ron if furiten
    const ron = options.find(o => o.type === 'ron');
    if (ron && !player.furiten && !player.temporaryFuriten) return ron;

    // For other calls, check if they reduce shanten
    const kan = options.find(o => o.type === 'daiminkan');
    if (kan) return kan; // Kan is usually good

    const pon = options.find(o => o.type === 'pon');
    if (pon) {
      // Check shanten after pon
      const ponTile = toNormalTile(pon.tile);
      const newHand = [...hand];
      // Remove 2 tiles matching pon tile
      let removed = 0;
      for (let i = newHand.length - 1; i >= 0 && removed < 2; i--) {
        if (toNormalTile(newHand[i]) === ponTile) {
          newHand.splice(i, 1);
          removed++;
        }
      }
      const newMelds = [...melds, { type: 'pon' as const, tiles: [pon.tile, pon.tile, pon.tile], from: pon.from }];
      const newShanten = this.calculateShanten(newHand, newMelds);
      if (newShanten < currentShanten) return pon;
      // Also accept if shanten stays same and we're close to tenpai
      if (newShanten <= currentShanten && currentShanten <= 1) return pon;
      return null;
    }

    const chi = options.find(o => o.type === 'chi');
    if (chi) {
      // Check shanten after chi
      const chiTiles = chi.consumed || [];
      const newHand = [...hand];
      for (const ct of chiTiles) {
        const idx = newHand.findIndex(t => toNormalTile(t) === toNormalTile(ct));
        if (idx >= 0) newHand.splice(idx, 1);
      }
      const newMelds = [...melds, { type: 'chi' as const, tiles: [chi.tile, ...chiTiles], from: chi.from }];
      const newShanten = this.calculateShanten(newHand, newMelds);
      if (newShanten < currentShanten) return chi;
      if (newShanten <= currentShanten && currentShanten <= 1) return chi;
      return null;
    }

    return null;
  }

  /** Choose gap tiles for huansanzhang mode - select 3 least useful tiles */
  chooseGapTiles(): string[] {
    const hand = this.engine.getPlayerHand(this.seat);
    if (hand.length < 3) return hand.slice();

    // Score each tile by usefulness, pick the 3 least useful
    const scored = hand.map(tile => ({
      tile,
      score: this.evaluateTileUsefulness(tile, hand),
    }));
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 3).map(s => s.tile);
  }

  /** Choose lack suit for chuanma mode - pick the suit with fewest/least useful tiles */
  chooseLackSuit(): string {
    const hand = this.engine.getPlayerHand(this.seat);
    const suitScores: Map<string, number> = new Map([['m', 0], ['p', 0], ['s', 0]]);

    for (const tile of hand) {
      const normal = toNormalTile(tile);
      const suit = normal[1];
      if (suitScores.has(suit)) {
        suitScores.set(suit, suitScores.get(suit)! + this.evaluateTileUsefulness(tile, hand));
      }
    }

    // Pick the suit with the lowest total usefulness
    let worstSuit = 'm';
    let worstScore = Infinity;
    for (const [suit, score] of suitScores) {
      if (score < worstScore) {
        worstScore = score;
        worstSuit = suit;
      }
    }
    return worstSuit;
  }

  /** Choose self-operation (after drawing) */
  chooseSelfOperation(): OperationType | null {
    const ops = this.engine.getSelfOperations(this.seat);
    if (ops.length === 0) return null;

    const player = this.engine.players[this.seat];

    // Zimo (self-draw win) - always take if not furiten
    const zimo = ops.find(o => o.type === OperationType.ZIMO);
    if (zimo && !player.furiten) return OperationType.ZIMO;

    // Ryukyoku (nine terminals) - take if available (rare opportunity)
    const ryukyoku = ops.find(o => o.type === OperationType.RYUKYOKU);
    if (ryukyoku) return OperationType.RYUKYOKU;

    // Ankan - usually good
    const ankan = ops.find(o => o.type === OperationType.ANKAN);
    if (ankan) return OperationType.ANKAN;

    // Kakan - check if it doesn't hurt
    const kakan = ops.find(o => o.type === OperationType.KAKAN);
    if (kakan) return OperationType.KAKAN;

    // Riichi - always take when tenpai with closed hand
    const riichi = ops.find(o => o.type === OperationType.REACH);
    if (riichi && player.menzen) return OperationType.REACH;

    return null;
  }

  // ─── Shanten Calculation ──────────────────────────────────────────

  /** Calculate shanten number for a hand */
  calculateShanten(hand: string[], melds: Meld[]): number {
    const normalShanten = this.calculateNormalShanten(hand, melds);
    const chiitoiShanten = this.calculateChiitoiShanten(hand);
    const kokushiShanten = this.calculateKokushiShanten(hand);
    return Math.min(normalShanten, chiitoiShanten, kokushiShanten);
  }

  /** Normal form shanten: 8 - 2*mentsu - taatsu (with constraints) */
  private calculateNormalShanten(hand: string[], melds: Meld[]): number {
    const mentsuCount = melds.length; // each meld is a complete mentsu
    const needMentsu = 4 - mentsuCount; // need 4 total mentsu

    // Count tile occurrences (normalized)
    const counts = new Map<string, number>();
    for (const t of hand) {
      const n = toNormalTile(t);
      counts.set(n, (counts.get(n) || 0) + 1);
    }

    // Count pairs, triplets, and partial sequences
    let pairs = 0;
    let triplets = 0;
    let partials = 0; // two-sided waits, edge waits, closed waits
    const usedTiles = new Set<string>();

    // Count triplets first (they're most valuable)
    for (const [tile, cnt] of counts) {
      if (cnt >= 3 && !usedTiles.has(tile)) {
        triplets++;
        usedTiles.add(tile);
      }
    }

    // Count pairs (not from triplets)
    for (const [tile, cnt] of counts) {
      if (cnt >= 2 && !usedTiles.has(tile)) {
        pairs++;
        // Don't mark as used - pairs can share tiles with partials
      }
    }

    // Count partial sequences (numbered suits only)
    for (const suit of ['m', 'p', 's']) {
      for (let num = 1; num <= 9; num++) {
        const tile = `${num}${suit}`;
        const cnt = counts.get(tile) || 0;

        // Adjacent (e.g., 3-4 waiting for 2 or 5)
        if (num < 9) {
          const nextTile = `${num + 1}${suit}`;
          const nextCnt = counts.get(nextTile) || 0;
          if (cnt > 0 && nextCnt > 0) {
            partials++;
          }
        }

        // Skip-one (e.g., 3-5 waiting for 4)
        if (num < 8) {
          const skipTile = `${num + 2}${suit}`;
          const skipCnt = counts.get(skipTile) || 0;
          if (cnt > 0 && skipCnt > 0) {
            partials++;
          }
        }
      }
    }

    // Shanten = 8 - 2*(mentsu + triplets) - max(taatsu, needMentsu - triplets)
    // where taatsu = min(pairs + partials, needMentsu - triplets + 1) (can have at most one more taatsu than needed mentsu)
    const totalMentsu = mentsuCount + triplets;
    const maxTaatsu = needMentsu - triplets + 1; // can have one extra for the pair
    const taatsu = Math.min(pairs + partials, maxTaatsu);

    const shanten = 8 - 2 * totalMentsu - taatsu;

    // Ensure non-negative
    return Math.max(0, shanten);
  }

  /** Chiitoi (seven pairs) shanten: 6 - pairs_count */
  private calculateChiitoiShanten(hand: string[]): number {
    if (hand.length < 13 || hand.length > 14) return Infinity;
    // Only valid with closed hand (no melds) - caller should check
    const counts = new Map<string, number>();
    for (const t of hand) {
      const n = toNormalTile(t);
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    let pairs = 0;
    for (const cnt of counts.values()) {
      if (cnt >= 2) pairs++;
    }
    return 6 - pairs;
  }

  /** Kokushi (thirteen orphans) shanten: 13 - unique_terminals - has_pair */
  private calculateKokushiShanten(hand: string[]): number {
    if (hand.length < 13 || hand.length > 14) return Infinity;
    const terminals = ['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z'];
    const counts = new Map<string, number>();
    for (const t of hand) {
      counts.set(toNormalTile(t), (counts.get(toNormalTile(t)) || 0) + 1);
    }
    let uniqueTerminals = 0;
    let hasPair = false;
    for (const t of terminals) {
      const c = counts.get(t) || 0;
      if (c >= 1) uniqueTerminals++;
      if (c >= 2) hasPair = true;
    }
    return 13 - uniqueTerminals - (hasPair ? 1 : 0);
  }

  /** Evaluate how "useful" a tile is (lower = more disposable) */
  private evaluateTileUsefulness(tile: string, hand: string[]): number {
    const normal = toNormalTile(tile);
    let score = 0;

    // Count pairs/triplets
    const sameCount = hand.filter(t => toNormalTile(t) === normal).length;
    if (sameCount >= 3) score += 100;
    if (sameCount >= 2) score += 50;

    // Check for sequence potential (numbered suits only)
    const suit = normal[1];
    const num = parseInt(normal[0]);
    if (!isNaN(num) && suit !== 'z') {
      const hasPrev = num > 1 && hand.some(t => toNormalTile(t) === `${num - 1}${suit}`);
      const hasNext = num < 9 && hand.some(t => toNormalTile(t) === `${num + 1}${suit}`);
      const hasPrev2 = num > 2 && hand.some(t => toNormalTile(t) === `${num - 2}${suit}`);
      const hasNext2 = num < 8 && hand.some(t => toNormalTile(t) === `${num + 2}${suit}`);

      if (hasPrev && hasNext) score += 80;
      if (hasPrev || hasNext) score += 30;
      if (hasPrev2 || hasNext2) score += 10;

      if (num >= 4 && num <= 6) score += 15;
    }

    // Honor tiles
    if (suit === 'z') {
      if (sameCount >= 2) score += 40;
      else score -= 5;
    }

    return score;
  }
}

/**
 * Game WebSocket server - handles FastTest service for actual mahjong gameplay.
 *
 * Manages game sessions with 1 human player + 3 AI bots.
 * Implements: draw/discard flow, chi/pon/kan, riichi, win (hule), exhaustive draw.
 */

import WebSocket, { WebSocketServer } from 'ws';
import {
  initProto, LiqiSession, buildResponse, buildNotify, buildActionNotify,
  MessageType, LiqiMessage,
} from '../proto/proto-loader';
import { MahjongEngine, OperationType, OptionalOp, Meld } from './mahjong-engine';
import { AIPlayer } from './ai-player';
import { sortTiles, toNormalTile } from './tiles';
import { saveRecord } from '../shared/game-records';
import { validateObserveToken } from '../shared/observe-tokens';

const GAME_PORT = 8443;

/** Pending operation state for human player */
interface PendingOp {
  type: 'self' | 'call';  // self = after draw, call = after discard
  operations: OptionalOp[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface GameClient {
  ws: WebSocket;
  accountId: number | null;
  seat: number;
  engine: MahjongEngine | null;
  aiPlayers: AIPlayer[];
  gameActive: boolean;
  session: LiqiSession;
  pendingOp: PendingOp | null;
  /** Track last winner seat for renchan logic */
  lastWinnerSeat: number | null;
  /** Track if last round was ryukyoku (exhaustive draw) */
  lastWasRyukyoku: boolean;
  /** Track if dealer was tenpai in ryukyoku */
  dealerTenpai: boolean;
  /** Whether last draw was rinshan */
  isRinshan: boolean;
  /** Game start timestamp for record keeping */
  gameStartTime: number;
  /** Game UUID for record keeping */
  gameUuid: string;
}

const gameClients: Map<WebSocket, GameClient> = new Map();

/** Observe (spectator) client - read-only, receives action notifications */
interface ObserveClient {
  ws: WebSocket;
  token: string;
  targetClient: GameClient | null;  // the game client being observed
}

const observeClients: Map<WebSocket, ObserveClient> = new Map();

export async function startGameServer(): Promise<void> {
  try {
    await initProto();
  } catch {
    // Already initialized, ignore
  }

  const wss = new WebSocketServer({
    port: GAME_PORT,
    handleProtocols: (protocols, request) => {
      console.log(`[game] Client offered protocols: ${[...protocols].join(', ') || '(none)'}`);
      return false;
    },
  });
  console.log(`[game] Game server started on port ${GAME_PORT}`);

  wss.on('connection', (ws) => {
    const client: GameClient = {
      ws,
      accountId: null,
      seat: 0,
      engine: null,
      aiPlayers: [],
      gameActive: false,
      session: new LiqiSession(),
      pendingOp: null,
      lastWinnerSeat: null,
      lastWasRyukyoku: false,
      dealerTenpai: false,
      isRinshan: false,
      gameStartTime: 0,
      gameUuid: '',
    };
    gameClients.set(ws, client);
    console.log('[game] Client connected');

    ws.on('message', (data: Buffer) => {
      try {
        const msg = client.session.parseFrame(data);
        handleGameMessage(client, msg);
      } catch (e) {
        console.error('[game] Error parsing message:', e);
      }
    });

    ws.on('close', () => {
      clearPendingOp(client);
      client.gameActive = false;
      client.engine = null;
      client.aiPlayers = [];
      gameClients.delete(ws);
      observeClients.delete(ws);
      console.log('[game] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[game] WebSocket error:', err);
    });
  });
}

// ─── Message dispatch ────────────────────────────────────────────────

function handleGameMessage(client: GameClient, msg: LiqiMessage): void {
  const { msgType, msgId, methodName, payload } = msg;

  if (msgType === MessageType.REQUEST) {
    console.log(`[game] Request: ${methodName} (msgId=${msgId})`);

    switch (methodName) {
      // ─── Route service (client calls these first after connecting) ───
      case '.lq.Route.requestConnection':
        sendResponse(client, msgId!, 'lq.ResRequestConnection', {
          error: {},
          timestamp: Date.now(),
          result: 1,
        });
        break;

      case '.lq.Route.heartbeat':
        sendResponse(client, msgId!, 'lq.ResHeartbeat', {
          error: {},
        });
        break;

      // ─── FastTest (Game) service ───
      case '.lq.FastTest.authGame':
        handleAuthGame(client, msgId!);
        break;

      case '.lq.FastTest.inputOperation':
        // Check if we're in selecting_gap phase (huansanzhang)
        if (client.engine && client.engine.phase === 'selecting_gap') {
          handleSelectGap(client, msgId!, payload);
          break;
        }
        handleInputOperation(client, msgId!, payload);
        break;

      case '.lq.FastTest.inputChiPengGang':
        handleInputChiPengGang(client, msgId!, payload);
        break;

      case '.lq.FastTest.confirmNewRound':
        handleConfirmNewRound(client, msgId!);
        break;

      case '.lq.FastTest.enterGame':
        sendResponse(client, msgId!, 'lq.ResEnterGame', {
          error: {},
          isEnd: false,
          step: 0,
        });
        break;

      case '.lq.FastTest.syncGame':
        if (client.engine && client.gameActive) {
          const restore = buildGameRestore(client);
          sendResponse(client, msgId!, 'lq.ResSyncGame', {
            gameRestore: restore,
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResSyncGame', {
            gameRestore: { actions: [] },
          });
        }
        break;

      case '.lq.FastTest.checkNetworkDelay':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.FastTest.authObserve': {
        const token = payload.token || '';
        const targetWs = validateObserveToken(token);
        if (targetWs) {
          const targetClient = gameClients.get(targetWs);
          const obsClient: ObserveClient = {
            ws: client.ws,
            token,
            targetClient: targetClient || null,
          };
          observeClients.set(client.ws, obsClient);
          console.log(`[game] Observe client authenticated with token: ${token}`);
          sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        } else {
          sendResponse(client, msgId!, 'lq.ResCommon', { error: { code: 5001 } });
        }
        break;
      }

      case '.lq.FastTest.startObserve': {
        const obsClient = observeClients.get(client.ws);
        if (obsClient && obsClient.targetClient) {
          const engine = obsClient.targetClient.engine;
          if (engine) {
            const humanHand = [...engine.players[obsClient.targetClient.seat].hand];
            sortTiles(humanHand);
            sendResponse(client, msgId!, 'lq.ResStartObserve', {
              head: {
                uuid: obsClient.targetClient.gameUuid,
                startTime: Math.floor(obsClient.targetClient.gameStartTime / 1000),
                gameConfig: {},
                players: engine.players.map((p, i) => ({
                  accountId: i === obsClient.targetClient!.seat ? (obsClient.targetClient!.accountId || 10001) : 20001 + i,
                  nickname: i === obsClient.targetClient!.seat ? 'LocalPlayer' : `AI_${i}`,
                  avatarId: 400101,
                  level: { id: 1001, score: 0 },
                })),
                seatList: engine.players.map((_, i) => i),
              },
              passed: { actions: [] },
            });
          } else {
            sendResponse(client, msgId!, 'lq.ResStartObserve', { head: null, passed: { actions: [] } });
          }
        } else {
          sendResponse(client, msgId!, 'lq.ResStartObserve', { head: null, passed: { actions: [] } });
        }
        break;
      }

      case '.lq.FastTest.stopObserve': {
        observeClients.delete(client.ws);
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
      }

      default:
        console.log(`[game] Unhandled method: ${methodName}`);
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
    }
  }
}

// ─── Auth game ───────────────────────────────────────────────────────

function handleAuthGame(client: GameClient, msgId: number): void {
  client.accountId = 10001;

  const numPlayers = 4;
  const engine = new MahjongEngine({ numPlayers: numPlayers as 3 | 4, initScore: 25000 });
  client.engine = engine;
  client.aiPlayers = [];
  for (let i = 1; i < numPlayers; i++) {
    client.aiPlayers.push(new AIPlayer(engine, i));
  }
  client.gameStartTime = Date.now();
  client.gameUuid = `game-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const seatList = Array.from({ length: numPlayers }, (_, i) => 10001 + i);
  seatList[0] = 10001;
  client.seat = 0;

  sendResponse(client, msgId, 'lq.ResAuthGame', {
    seatList: seatList,
    players: [{
      accountId: client.accountId,
      nickname: 'LocalPlayer',
      avatarId: 400101,
      level: { id: 1001, score: 0 },
      character: { charid: 200001, level: 1, exp: 0 },
    }],
    robots: client.aiPlayers.map((_, i) => ({
      accountId: seatList[i + 1],
      nickname: `AI_${i + 1}`,
      avatarId: 400101,
      level: { id: 1001, score: 0 },
      character: { charid: 200001, level: 1, exp: 0 },
    })),
    gameConfig: {
      category: 1,
      meta: { modeId: 2, roomId: 1 },
      mode: { mode: 1 },
    },
    isGameStart: true,
  });

  // Notify client that all players are ready to start
  sendNotify(client, '.lq.NotifyPlayerLoadGameReady', 'lq.NotifyPlayerLoadGameReady', {
    readyIdList: seatList,
  });

  setTimeout(() => startNewRound(client, 0, 0, 0, 0), 1000);
}

// ─── Start new round ────────────────────────────────────────────────

function startNewRound(client: GameClient, chang: number, ju: number, ben: number, liqibang: number): void {
  const engine = client.engine!;
  const roundData = engine.startRound(chang, ju, ben, liqibang);
  client.gameActive = true;
  client.lastWinnerSeat = null;
  client.lastWasRyukyoku = false;
  client.dealerTenpai = false;

  const humanHand = roundData.hands[client.seat];
  sortTiles(humanHand);

  // Dealer gets 14 tiles (including first draw), others get 13
  const tiles = client.seat === roundData.dealer
    ? humanHand
    : humanHand.slice(0, 13);

  // Build OptionalOperationList for dealer's first turn
  let operation: any = null;
  if (client.seat === roundData.dealer) {
    const ops = engine.getSelfOperations(client.seat);
    if (ops.length > 0) {
      operation = buildOptionalOperationList(client.seat, ops);
    }
  }

  sendActionNotify(client, 'ActionNewRound', {
    chang: roundData.chang,
    ju: roundData.ju,
    ben: roundData.ben,
    liqibang: roundData.liqibang,
    dora: roundData.doraIndicators[0] || '',
    doras: roundData.doraIndicators,
    scores: roundData.scores,
    tiles: tiles,
    leftTileCount: roundData.leftTileCount,
    operation: operation,
    tingpais0: engine.getWaitTiles(0).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    tingpais1: engine.getWaitTiles(1).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    tingpais2: engine.getWaitTiles(2).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    tingpais3: engine.getWaitTiles(3).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
  }, 0);

  // If huansanzhang mode, send ActionSelectGap
  if (engine.config.huansanzhang) {
    // AI players auto-select gap tiles
    for (const ai of client.aiPlayers) {
      const gapTiles = ai.chooseGapTiles();
      try {
        engine.selectGapTiles(ai.seat, gapTiles);
      } catch (e) {
        console.error(`[game] AI gap select error for seat ${ai.seat}:`, e);
      }
    }

    // Send select gap notification to human
    sendActionNotify(client, 'ActionSelectGap', {
      seat: client.seat,
      changeTiles: [],
      tileStates: [],
    }, engine.step);

    // Set pending op for gap selection
    setPendingOp(client, 'self', [{ type: 1 as any, combination: [] }]);
    return; // Don't proceed to normal draw yet
  }

  // If human is dealer, wait for their input (with OptionalOperationList)
  if (client.seat === roundData.dealer) {
    if (operation) {
      const ops = engine.getSelfOperations(client.seat);
      setPendingOp(client, 'self', ops);
    }
    // Human dealer waits for inputOperation
  } else {
    // AI dealer draws and plays
    setTimeout(() => runAITurn(client, roundData.dealer), 500);
  }
}

// ─── Input operation (human: discard/riichi/ankan/kakan/zimo) ───────

function handleInputOperation(client: GameClient, msgId: number, payload: any): void {
  const engine = client.engine!;
  const opType = payload.operation_type;

  // Validate: must have pending operation
  if (!client.pendingOp) {
    console.warn('[game] Received inputOperation without pending op, ignoring');
    sendResponse(client, msgId, 'lq.ResCommon', { error: {} });
    return;
  }

  clearPendingOp(client);

  // Acknowledge
  sendResponse(client, msgId, 'lq.ResCommon', { error: {} });

  switch (opType) {
    case OperationType.REACH:
      handlePlayerRiichi(client, payload);
      break;
    case OperationType.ANKAN:
      handlePlayerAnkan(client, payload);
      break;
    case OperationType.KAKAN:
      handlePlayerKakan(client, payload);
      break;
    case OperationType.NUKIDORA:
      handlePlayerNukidora(client, payload);
      break;
    case OperationType.ZIMO:
      handlePlayerZimo(client);
      break;
    default:
      if (payload.tile) {
        handlePlayerDiscard(client, payload);
      } else {
        console.warn(`[game] Unknown operation type: ${opType}, skipping`);
      }
      break;
  }
}

/** Send discard notification with optional operation list, then check for AI calls */
function sendDiscardNotify(client: GameClient, seat: number, result: any, isLiqi: boolean): void {
  const engine = client.engine!;

  // Calculate human player's call operations
  const humanCallOps = engine.getCallOperations(client.seat);
  const operation = humanCallOps.length > 0
    ? buildOptionalOperationList(client.seat, humanCallOps)
    : null;

  sendActionNotify(client, 'ActionDiscardTile', {
    seat: result.seat,
    tile: result.tile,
    isLiqi: isLiqi,
    isWliqi: false,  // double riichi (not implemented)
    moqie: result.moqie,
    doras: [...engine.doraIndicators],
    operation,
    zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
    tingpais: engine.getWaitTiles(result.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
  }, result.step);

  if (humanCallOps.length > 0) {
    setPendingOp(client, 'call', humanCallOps);
  } else {
    afterDiscardNoHumanOp(client, seat);
  }
}

/** After discard, when human has no call operations — check AI calls and proceed */
function afterDiscardNoHumanOp(client: GameClient, discardSeat: number): void {
  const engine = client.engine!;
  const allCallOptions = engine.checkCalls();
  const aiCallOptions = allCallOptions.filter(c => c.seat !== client.seat);

  if (aiCallOptions.length > 0) {
    const aiSeat = aiCallOptions[0].seat;
    const ai = client.aiPlayers.find(a => a.seat === aiSeat);
    if (ai) {
      const call = ai.chooseCall(aiCallOptions.filter(c => c.seat === aiSeat));
      if (call) {
        setTimeout(() => handleAICall(client, call), 300);
        return;
      }
    }
  }

  proceedToNextDraw(client, discardSeat);
}

/** Draw rinshan tile after kan */
function drawRinshanForSeat(client: GameClient, seat: number): void {
  const engine = client.engine!;
  client.isRinshan = true;
  const drawResult = engine.drawRinshan(seat);
  if (!drawResult) {
    handleExhaustiveDraw(client);
    return;
  }

  if (seat === client.seat) {
    const ops = engine.getSelfOperations(seat);
    sendActionNotify(client, 'ActionDealTile', {
      seat: drawResult.seat,
      tile: drawResult.tile,
      leftTileCount: drawResult.leftTileCount,
      doras: drawResult.doraIndicators,
      operation: ops.length > 0 ? buildOptionalOperationList(seat, ops) : null,
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    if (ops.length > 0) {
      setPendingOp(client, 'self', ops);
    }
  } else {
    sendActionNotify(client, 'ActionDealTile', {
      seat: drawResult.seat,
      tile: '',
      leftTileCount: drawResult.leftTileCount,
      doras: drawResult.doraIndicators,
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // AI self-operation check after rinshan
    const ai = client.aiPlayers.find(a => a.seat === seat);
    if (ai) {
      const selfOps = engine.getSelfOperations(seat);
      const zimoOp = selfOps.find(o => o.type === OperationType.ZIMO);
      if (zimoOp) {
        setTimeout(() => handleAIZimo(client, seat), 300);
        return;
      }
      const ankanOp = selfOps.find(o => o.type === OperationType.ANKAN);
      if (ankanOp) {
        setTimeout(() => handleAIAnkan(client, seat, ankanOp.combination[0]), 300);
        return;
      }
      const kakanOp = selfOps.find(o => o.type === OperationType.KAKAN);
      if (kakanOp) {
        setTimeout(() => handleAIKakan(client, seat, kakanOp.combination[0]), 300);
        return;
      }
      const nukiOp = selfOps.find(o => o.type === OperationType.NUKIDORA);
      if (nukiOp) {
        setTimeout(() => handleAINukidora(client, seat, nukiOp.combination[0]), 300);
        return;
      }

      // Normal discard
      const discardTile = ai.chooseDiscard();
      try {
        const result = engine.discardTile(seat, discardTile, true);
        sendDiscardNotify(client, seat, result, false);
      } catch (e) {
        console.error('[game] Error in AI rinshan discard:', e);
      }
    }
  }
}

function handlePlayerDiscard(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile;
  const moqie = payload.moqie || false;

  try {
    const result = engine.discardTile(client.seat, tile, moqie);
    sendDiscardNotify(client, result.seat, result, false);
  } catch (e) {
    console.error('[game] Error in player discard:', e);
  }
}

function handlePlayerRiichi(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile;
  const moqie = payload.moqie || false;

  try {
    const result = engine.discardTile(client.seat, tile, moqie);

    // Only modify state AFTER successful discard
    engine.players[client.seat].isRiichi = true;
    engine.players[client.seat].riichiTurn = engine.step;
    engine.riichiSticks++;
    engine.players[client.seat].score -= 1000;

    sendDiscardNotify(client, result.seat, result, true);
  } catch (e) {
    console.error('[game] Error in player riichi:', e);
  }
}

function handlePlayerAnkan(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile || payload.combination?.[0];

  try {
    engine.applyAnkan(client.seat, tile);

    sendActionNotify(client, 'ActionAnGangAddGang', {
      seat: client.seat,
      type: 3, // ankan
      tiles: tile,
      doras: [...engine.doraIndicators],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(client.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // After ankan: rinshan draw for the same player
    setTimeout(() => drawRinshanForSeat(client, client.seat), 300);
  } catch (e) {
    console.error('[game] Error in player ankan:', e);
  }
}

function handlePlayerKakan(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile || payload.combination?.[0];

  try {
    engine.applyKakan(client.seat, tile);

    sendActionNotify(client, 'ActionAnGangAddGang', {
      seat: client.seat,
      type: 2, // kakan
      tiles: tile,
      doras: [...engine.doraIndicators],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(client.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // After kakan: rinshan draw for the same player
    setTimeout(() => drawRinshanForSeat(client, client.seat), 300);
  } catch (e) {
    console.error('[game] Error in player kakan:', e);
  }
}

function handlePlayerNukidora(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile || payload.combination?.[0] || '4z';

  try {
    engine.applyNukidora(client.seat, tile);

    sendActionNotify(client, 'ActionAnGangAddGang', {
      seat: client.seat,
      type: 3, // nukidora
      tiles: tile,
      doras: [...engine.doraIndicators],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(client.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // After nukidora: draw rinshan for the same player
    setTimeout(() => drawRinshanForSeat(client, client.seat), 300);
  } catch (e) {
    console.error('[game] Error in player nukidora:', e);
  }
}

/** Handle human player selecting gap tiles (huansanzhang mode) */
function handleSelectGap(client: GameClient, msgId: number, payload: any): void {
  const engine = client.engine!;
  const tiles = payload.change_tiles || payload.combination || [];

  if (engine.phase !== 'selecting_gap') {
    sendResponse(client, msgId, 'lq.ResCommon', { error: { code: 6001 } });
    return;
  }

  try {
    engine.selectGapTiles(client.seat, tiles);
    sendResponse(client, msgId, 'lq.ResCommon', { error: {} });

    // Check if all players have selected
    if (engine.isAllGapSelected()) {
      // AI players auto-select if they haven't
      const results = engine.exchangeGapTiles();

      // Notify all players about the exchange
      for (const r of results) {
        sendActionNotify(client, 'ActionSelectGap', {
          seat: r.seat,
          changeTiles: r.received,
          tileStates: [],
        }, engine.step);
      }

      // Now proceed to normal game flow - deal first tile to dealer
      const firstDraw = engine.drawTile(engine.dealer);
      if (firstDraw) {
        handleAfterDraw(client, firstDraw);
      } else {
        handleExhaustiveDraw(client);
      }
    }
  } catch (e) {
    console.error('[game] Error in select gap:', e);
    sendResponse(client, msgId, 'lq.ResCommon', { error: { code: 6002 } });
  }
}

/** Handle after a tile is drawn - check self operations and proceed */
function handleAfterDraw(client: GameClient, drawResult: any): void {
  const engine = client.engine!;
  const seat = drawResult.seat;

  if (seat === client.seat) {
    // Human player drew
    const selfOps = engine.getSelfOperations(seat);
    const operation = selfOps.length > 0 ? buildOptionalOperationList(seat, selfOps) : null;

    sendActionNotify(client, 'ActionDealTile', {
      seat,
      tile: drawResult.tile,
      leftTileCount: drawResult.leftTileCount,
      doras: [...engine.doraIndicators],
      operation,
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    if (selfOps.length > 0) {
      setPendingOp(client, 'self', selfOps);
    } else {
      // Auto-discard after timeout
      setTimeout(() => {
        if (client.pendingOp) return; // player already acted
        handlePlayerDiscard(client, { tile: '' }); // auto-discard
      }, 15000);
    }
  } else {
    // AI player drew
    sendActionNotify(client, 'ActionDealTile', {
      seat,
      tile: drawResult.tile,
      leftTileCount: drawResult.leftTileCount,
      doras: [...engine.doraIndicators],
      operation: null,
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: [],
    }, engine.step);

    const ai = client.aiPlayers.find(a => a.seat === seat);
    if (ai) {
      runAITurn(client, seat);
    }
  }
}

/** Find the next seat that hasn't won (for blood battle mode) */
function findNextActiveSeat(engine: MahjongEngine, afterSeat: number): number {
  const n = engine.config.numPlayers;
  for (let i = 1; i <= n; i++) {
    const seat = (afterSeat + i) % n;
    if (!engine.players[seat].hasWon) return seat;
  }
  return -1; // no active players
}

function handlePlayerZimo(client: GameClient): void {
  const engine = client.engine!;
  const seat = client.seat;
  const hand = [...engine.players[seat].hand];
  const huTile = hand[hand.length - 1]; // last drawn tile

  handleWin(client, [{
    seat,
    isZimo: true,
    fromSeat: seat,
    hand: hand.slice(0, -1), // exclude the hu tile from hand
    melds: [...engine.players[seat].melds],
    huTile,
  }]);
}

// ─── Input chi/pon/gang (human: chi/pon/daiminkan/ron) ──────────────

function handleInputChiPengGang(client: GameClient, msgId: number, payload: any): void {
  const engine = client.engine!;
  const opType = payload.operation_type;

  // Validate: must have pending operation
  if (!client.pendingOp) {
    console.warn('[game] Received inputChiPengGang without pending op, ignoring');
    sendResponse(client, msgId, 'lq.ResCommon', { error: {} });
    return;
  }

  clearPendingOp(client);

  // Acknowledge
  sendResponse(client, msgId, 'lq.ResCommon', { error: {} });

  switch (opType) {
    case OperationType.CHI:
      handlePlayerChi(client, payload);
      break;
    case OperationType.PON:
      handlePlayerPon(client, payload);
      break;
    case OperationType.DAIMINKAN:
      handlePlayerDaiminkan(client, payload);
      break;
    case OperationType.RON:
      handlePlayerRon(client);
      break;
    default:
      // Skip / no operation - continue game
      afterCallSkip(client);
      break;
  }
}

function handlePlayerChi(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile;
  const combination = payload.combination || [];

  if (!engine.lastDiscard) return;
  const fromSeat = engine.lastDiscard.seat;

  try {
    engine.applyChi(client.seat, fromSeat, tile, combination);

    // Build tiles and froms for ActionChiPengGang
    // tiles = [discarded_tile, consumed1, consumed2], froms = [from, seat, seat]
    const allTiles = [tile, ...combination];
    const froms = allTiles.map((_, i) => i === 0 ? fromSeat : client.seat);

    sendActionNotify(client, 'ActionChiPengGang', {
      seat: client.seat,
      type: 0, // chi
      tiles: allTiles,
      froms: froms,
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(client.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // After chi, player must discard - wait for inputOperation
    // No OptionalOperationList needed (just discard)
  } catch (e) {
    console.error('[game] Error in player chi:', e);
  }
}

function handlePlayerPon(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile;

  if (!engine.lastDiscard) return;
  const fromSeat = engine.lastDiscard.seat;

  try {
    engine.applyPon(client.seat, fromSeat, tile);

    sendActionNotify(client, 'ActionChiPengGang', {
      seat: client.seat,
      type: 1, // pon
      tiles: [tile, tile, tile],
      froms: [fromSeat, client.seat, client.seat],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(client.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // After pon, player must discard - wait for inputOperation
  } catch (e) {
    console.error('[game] Error in player pon:', e);
  }
}

function handlePlayerDaiminkan(client: GameClient, payload: any): void {
  const engine = client.engine!;
  const tile = payload.tile;

  if (!engine.lastDiscard) return;
  const fromSeat = engine.lastDiscard.seat;

  try {
    engine.applyDaiminkan(client.seat, fromSeat, tile);

    sendActionNotify(client, 'ActionChiPengGang', {
      seat: client.seat,
      type: 2, // daiminkan
      tiles: [tile, tile, tile, tile],
      froms: [fromSeat, client.seat, client.seat, client.seat],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(client.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // After daiminkan: rinshan draw
    setTimeout(() => drawForSeat(client, client.seat), 300);
  } catch (e) {
    console.error('[game] Error in player daiminkan:', e);
  }
}

function handlePlayerRon(client: GameClient): void {
  const engine = client.engine!;
  if (!engine.lastDiscard) return;

  const fromSeat = engine.lastDiscard.seat;
  const huTile = engine.lastDiscard.tile;
  const hand = [...engine.players[client.seat].hand];

  handleWin(client, [{
    seat: client.seat,
    isZimo: false,
    fromSeat,
    hand,
    melds: [...engine.players[client.seat].melds],
    huTile,
  }]);
}

// ─── After discard: check calls and continue ─────────────────────────

/** Called when human skips call operation */
function afterCallSkip(client: GameClient): void {
  const engine = client.engine!;

  // Check if human could have called ron but skipped -> temporary furiten
  if (engine.lastDiscard && engine.canWin(client.seat, engine.lastDiscard.tile)) {
    engine.players[client.seat].temporaryFuriten = true;
  }

  // Check if any AI can still call
  const allCallOptions = engine.checkCalls();
  const aiCallOptions = allCallOptions.filter(c => c.seat !== client.seat);

  if (aiCallOptions.length > 0) {
    const aiSeat = aiCallOptions[0].seat;
    const ai = client.aiPlayers.find(a => a.seat === aiSeat);
    if (ai) {
      const call = ai.chooseCall(aiCallOptions.filter(c => c.seat === aiSeat));
      if (call) {
        setTimeout(() => handleAICall(client, call), 300);
        return;
      }
    }
  }

  // No AI calls either - next player draws
  if (engine.lastDiscard) {
    proceedToNextDraw(client, engine.lastDiscard.seat);
  }
}

function proceedToNextDraw(client: GameClient, lastDiscardSeat: number): void {
  const engine = client.engine!;
  const nextSeat = engine.nextSeat(lastDiscardSeat);

  if (nextSeat === client.seat) {
    // Human's turn - draw tile
    drawForSeat(client, client.seat);
  } else {
    // AI's turn
    setTimeout(() => runAITurn(client, nextSeat), 300);
  }
}

// ─── Draw tile for a seat ────────────────────────────────────────────

function drawForSeat(client: GameClient, seat: number): void {
  const engine = client.engine!;
  client.isRinshan = false;

  const drawResult = engine.drawTile(seat);
  if (!drawResult) {
    handleExhaustiveDraw(client);
    return;
  }

  if (seat === client.seat) {
    // Human draw - show tile, check operations
    const ops = engine.getSelfOperations(seat);

    sendActionNotify(client, 'ActionDealTile', {
      seat: drawResult.seat,
      tile: drawResult.tile,
      leftTileCount: drawResult.leftTileCount,
      doras: drawResult.doraIndicators,
      operation: ops.length > 0 ? buildOptionalOperationList(seat, ops) : null,
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    if (ops.length > 0) {
      setPendingOp(client, 'self', ops);
    }
    // Wait for human inputOperation
  } else {
    // AI draw - hidden tile, AI decides action
    sendActionNotify(client, 'ActionDealTile', {
      seat: drawResult.seat,
      tile: '', // Hidden
      leftTileCount: drawResult.leftTileCount,
      doras: drawResult.doraIndicators,
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // AI self-operation check
    const ai = client.aiPlayers.find(a => a.seat === seat);
    if (ai) {
      const selfOps = engine.getSelfOperations(seat);
      const zimoOp = selfOps.find(o => o.type === OperationType.ZIMO);
      if (zimoOp) {
        // AI self-draw win
        setTimeout(() => handleAIZimo(client, seat), 300);
        return;
      }

      const ankanOp = selfOps.find(o => o.type === OperationType.ANKAN);
      if (ankanOp) {
        // AI ankan
        setTimeout(() => handleAIAnkan(client, seat, ankanOp.combination[0]), 300);
        return;
      }

      const kakanOp = selfOps.find(o => o.type === OperationType.KAKAN);
      if (kakanOp) {
        // AI kakan
        setTimeout(() => handleAIKakan(client, seat, kakanOp.combination[0]), 300);
        return;
      }

      const nukiOp = selfOps.find(o => o.type === OperationType.NUKIDORA);
      if (nukiOp) {
        setTimeout(() => handleAINukidora(client, seat, nukiOp.combination[0]), 300);
        return;
      }

      // Check riichi
      if (engine.canRiichi(seat) && Math.random() < 0.5) {
        // AI declares riichi
        handleAIRiichi(client, seat);
        return;
      }
    }

    // Normal discard
    if (ai) {
      const discardTile = ai.chooseDiscard();
      try {
        const result = engine.discardTile(seat, discardTile, true);
        sendDiscardNotify(client, seat, result, false);
      } catch (e) {
        console.error('[game] Error in AI discard:', e);
      }
    }
  }
}

// ─── AI turn ─────────────────────────────────────────────────────────

function runAITurn(client: GameClient, seat: number): void {
  drawForSeat(client, seat);
}

// ─── AI actions ──────────────────────────────────────────────────────

function handleAICall(client: GameClient, call: any): void {
  const engine = client.engine!;

  switch (call.type) {
    case 'pon': {
      engine.applyPon(call.seat, call.from, call.tile);
      sendActionNotify(client, 'ActionChiPengGang', {
        seat: call.seat,
        type: 1,
        tiles: [call.tile, call.tile, call.tile],
        froms: [call.from, call.seat, call.seat],
        zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
        tingpais: engine.getWaitTiles(call.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
      }, engine.step);

      // AI discards after pon
      const ai = client.aiPlayers.find(a => a.seat === call.seat);
      if (ai) {
        const discard = ai.chooseDiscard();
        try {
          const result = engine.discardTile(call.seat, discard, true);
          sendDiscardNotify(client, call.seat, result, false);
        } catch (e) {
          console.error('[game] Error in AI pon discard:', e);
        }
      }
      break;
    }

    case 'daiminkan': {
      engine.applyDaiminkan(call.seat, call.from, call.tile);
      sendActionNotify(client, 'ActionChiPengGang', {
        seat: call.seat,
        type: 2,
        tiles: [call.tile, call.tile, call.tile, call.tile],
        froms: [call.from, call.seat, call.seat, call.seat],
        zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
        tingpais: engine.getWaitTiles(call.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
      }, engine.step);
      // Rinshan draw
      setTimeout(() => drawRinshanForSeat(client, call.seat), 300);
      break;
    }

    case 'chi': {
      const consumed = call.consumed || [];
      engine.applyChi(call.seat, call.from, call.tile, consumed);
      const allTiles = [call.tile, ...consumed];
      const froms = allTiles.map((_: any, i: number) => i === 0 ? call.from : call.seat);
      sendActionNotify(client, 'ActionChiPengGang', {
        seat: call.seat,
        type: 0,
        tiles: allTiles,
        froms: froms,
        zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
        tingpais: engine.getWaitTiles(call.seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
      }, engine.step);

      // AI discards after chi
      const ai = client.aiPlayers.find(a => a.seat === call.seat);
      if (ai) {
        const discard = ai.chooseDiscard();
        try {
          const result = engine.discardTile(call.seat, discard, true);
          sendDiscardNotify(client, call.seat, result, false);
        } catch (e) {
          console.error('[game] Error in AI chi discard:', e);
        }
      }
      break;
    }

    case 'ron': {
      handleAIRon(client, call.seat, call.from, call.tile);
      break;
    }

    default:
      break;
  }
}

function handleAIRon(client: GameClient, seat: number, fromSeat: number, tile: string): void {
  const engine = client.engine!;
  const hand = [...engine.players[seat].hand];

  handleWin(client, [{
    seat,
    isZimo: false,
    fromSeat,
    hand,
    melds: [...engine.players[seat].melds],
    huTile: tile,
  }]);
}

function handleAIZimo(client: GameClient, seat: number): void {
  const engine = client.engine!;
  const hand = [...engine.players[seat].hand];
  const huTile = hand[hand.length - 1];

  handleWin(client, [{
    seat,
    isZimo: true,
    fromSeat: seat,
    hand: hand.slice(0, -1),
    melds: [...engine.players[seat].melds],
    huTile,
  }]);
}

function handleAIAnkan(client: GameClient, seat: number, tile: string): void {
  const engine = client.engine!;

  try {
    engine.applyAnkan(seat, tile);
    sendActionNotify(client, 'ActionAnGangAddGang', {
      seat,
      type: 3,
      tiles: tile,
      doras: [...engine.doraIndicators],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // Rinshan draw
    setTimeout(() => drawRinshanForSeat(client, seat), 300);
  } catch (e) {
    console.error('[game] Error in AI ankan:', e);
  }
}

function handleAIKakan(client: GameClient, seat: number, tile: string): void {
  const engine = client.engine!;

  try {
    engine.applyKakan(seat, tile);
    sendActionNotify(client, 'ActionAnGangAddGang', {
      seat,
      type: 2,
      tiles: tile,
      doras: [...engine.doraIndicators],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // Rinshan draw
    setTimeout(() => drawRinshanForSeat(client, seat), 300);
  } catch (e) {
    console.error('[game] Error in AI kakan:', e);
  }
}

function handleAINukidora(client: GameClient, seat: number, tile: string): void {
  const engine = client.engine!;
  try {
    engine.applyNukidora(seat, tile);

    sendActionNotify(client, 'ActionAnGangAddGang', {
      seat,
      type: 3, // nukidora
      tiles: tile,
      doras: [...engine.doraIndicators],
      zhenting: engine.players.map(p => p.furiten || p.temporaryFuriten),
      tingpais: engine.getWaitTiles(seat).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    }, engine.step);

    // Rinshan draw after nukidora
    setTimeout(() => drawRinshanForSeat(client, seat), 300);
  } catch (e) {
    console.error('[game] Error in AI nukidora:', e);
  }
}

function handleAIRiichi(client: GameClient, seat: number): void {
  const engine = client.engine!;
  const ai = client.aiPlayers.find(a => a.seat === seat);
  if (!ai) return;

  const discardTile = ai.chooseDiscard();
  try {
    const result = engine.discardTile(seat, discardTile, true);

    // Only modify state AFTER successful discard
    engine.players[seat].isRiichi = true;
    engine.players[seat].riichiTurn = engine.step;
    engine.riichiSticks++;
    engine.players[seat].score -= 1000;

    sendDiscardNotify(client, seat, result, true);
  } catch (e) {
    console.error('[game] Error in AI riichi:', e);
  }
}

// ─── Win (hule) flow ─────────────────────────────────────────────────

interface WinInfo {
  seat: number;
  isZimo: boolean;
  fromSeat: number;
  hand: string[];
  melds: Meld[];
  huTile: string;
}

function handleWin(client: GameClient, winners: WinInfo[]): void {
  const engine = client.engine!;
  clearPendingOp(client);

  const oldScores = engine.players.map(p => p.score);
  const deltaScores = new Array(engine.players.length).fill(0) as number[];

  // Simplified scoring
  for (const w of winners) {
    const isDealer = w.seat === engine.dealer;
    const isRiichi = engine.players[w.seat].isRiichi;
    const isMenzen = engine.players[w.seat].menzen;

    // Calculate han and fu
    const isLastTile = engine.wall.length - 14 <= 0;
    const { han, fu, fans, yiman } = calculateScore(engine, w, client.isRinshan, isLastTile, false);

    // Calculate points
    const points = calculatePoints(han, fu, isDealer, yiman);

    if (w.isZimo) {
      // Self-draw: all others pay
      for (let i = 0; i < engine.players.length; i++) {
        if (i === w.seat) continue;
        const targetIsDealer = i === engine.dealer;
        const payment = targetIsDealer ? points.zimoQin : points.zimoXian;
        deltaScores[i] -= payment;
        deltaScores[w.seat] += payment;
      }
    } else {
      // Ron: discarding player pays all
      deltaScores[w.fromSeat] -= points.ron;
      deltaScores[w.seat] += points.ron;
    }

    // Add honba
    if (engine.honba > 0) {
      if (w.isZimo) {
        const honbaPerPlayer = engine.honba * 100;
        for (let i = 0; i < engine.players.length; i++) {
          if (i === w.seat) continue;
          deltaScores[i] -= honbaPerPlayer;
          deltaScores[w.seat] += honbaPerPlayer;
        }
      } else {
        const honbaTotal = engine.honba * 300;
        deltaScores[w.fromSeat] -= honbaTotal;
        deltaScores[w.seat] += honbaTotal;
      }
    }

    // Store winner info for renchan logic
    client.lastWinnerSeat = w.seat;
  }

  // Award riichi sticks to first winner (only once)
  if (engine.riichiSticks > 0) {
    deltaScores[winners[0].seat] += engine.riichiSticks * 1000;
  }
  // Clear riichi sticks after awarding to winner
  engine.riichiSticks = 0;

  // Update scores
  const newScores = oldScores.map((s, i) => s + deltaScores[i]);
  for (let i = 0; i < engine.players.length; i++) {
    engine.players[i].score = newScores[i];
  }

  // Build HuleInfo list
  const hules = winners.map(w => {
    const isDealer = w.seat === engine.dealer;
    const isRiichi = engine.players[w.seat].isRiichi;
    const isLastTile = engine.wall.length - 14 <= 0;
    const { han, fu, fans, yiman } = calculateScore(engine, w, client.isRinshan, isLastTile, false);
    const points = calculatePoints(han, fu, isDealer, yiman);

    return {
      hand: w.hand,
      ming: w.melds.flatMap(m => m.tiles),
      huTile: w.huTile,
      seat: w.seat,
      zimo: w.isZimo,
      qinjia: isDealer,
      liqi: isRiichi,
      doras: [...engine.doraIndicators],
      liDoras: isRiichi ? [...engine.uraDoraIndicators] : [],
      yiman,
      count: han,
      fans,
      fu,
      pointRong: points.ron,
      pointZimoQin: points.zimoQin,
      pointZimoXian: points.zimoXian,
      pointSum: w.isZimo
        ? (w.seat === engine.dealer
          ? points.zimoQin * (engine.players.length - 1)
          : points.zimoQin + points.zimoXian * (engine.players.length - 2))
        : points.ron,
      dadian: w.isZimo ? 0 : points.ron,
    };
  });

  // Check if game should end
  const gameEnd = shouldGameEnd(engine, newScores);

  sendActionNotify(client, 'ActionHule', {
    hules,
    oldScores: oldScores,
    deltaScores: deltaScores,
    waitTimeout: 15000,
    scores: newScores,
    gameend: gameEnd ? { scores: newScores } : null,
    doras: [...engine.doraIndicators],
  }, engine.step);

  if (gameEnd) {
    setTimeout(() => endGame(client), 2000);
    return;
  }

  // Blood battle mode: check if round continues
  if (engine.config.xuezhandaodi || engine.config.chuanma) {
    // Mark winners
    for (const w of winners) {
      engine.markPlayerWon(w.seat);
    }

    if (!engine.isRoundOver()) {
      // Round continues - find next active player and draw
      const nextSeat = findNextActiveSeat(engine, winners[0].seat);
      if (nextSeat >= 0) {
        setTimeout(() => {
          try {
            const drawResult = engine.drawTile(nextSeat);
            handleAfterDraw(client, drawResult);
          } catch (e) {
            console.error('[game] Error continuing after blood battle win:', e);
          }
        }, 1000);
        return; // Don't end the round
      }
    }
  }
  // Otherwise, client will send confirmNewRound
}

// ─── Yaku detection helpers ──────────────────────────────────────────

/** Check if hand is chiitoi (seven pairs) */
function isChiitoi(hand: string[]): boolean {
  if (hand.length !== 14) return false;
  const counts = new Map<string, number>();
  for (const t of hand) {
    const n = toNormalTile(t);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  if (counts.size !== 7) return false;
  for (const c of counts.values()) {
    if (c !== 2) return false;
  }
  return true;
}

/** Check if hand is kokushi (thirteen orphans) */
function isKokushi(hand: string[]): boolean {
  if (hand.length !== 14) return false;
  const terminals = ['1m','9m','1p','9p','1s','9s','1z','2z','3z','4z','5z','6z','7z'];
  const counts = new Map<string, number>();
  for (const t of hand) {
    counts.set(toNormalTile(t), (counts.get(toNormalTile(t)) || 0) + 1);
  }
  let hasPair = false;
  for (const t of terminals) {
    const c = counts.get(t) || 0;
    if (c === 0) return false;
    if (c >= 2) hasPair = true;
  }
  return hasPair;
}

/** Check if all melds are triplets (toitoi) */
function isToitoi(melds: Meld[]): boolean {
  if (melds.length === 0) return false;
  return melds.every(m => m.type === 'pon' || m.type === 'ankan' || m.type === 'daiminkan' || m.type === 'kakan');
}

/** Check if hand+melds is honitsu (half flush: one suit + honors) */
function isHonitsu(hand: string[], melds: Meld[]): boolean {
  const allTiles = [...hand.map(toNormalTile)];
  for (const m of melds) for (const t of m.tiles) allTiles.push(toNormalTile(t));
  const suits = new Set(allTiles.map(t => t[1]));
  // Must have exactly one numbered suit + honors
  const numSuits = ['m', 'p', 's'].filter(s => suits.has(s));
  return numSuits.length === 1 && suits.has('z');
}

/** Check if hand+melds is chinitsu (full flush: one suit, no honors) */
function isChinitsu(hand: string[], melds: Meld[]): boolean {
  const allTiles = [...hand.map(toNormalTile)];
  for (const m of melds) for (const t of m.tiles) allTiles.push(toNormalTile(t));
  const suits = new Set(allTiles.map(t => t[1]));
  const numSuits = ['m', 'p', 's'].filter(s => suits.has(s));
  return numSuits.length === 1 && !suits.has('z');
}

/** Check for ippitsu (straight: 123-456-789 of same suit) */
function isIppitsu(hand: string[], melds: Meld[]): boolean {
  // Collect all sequence tiles from hand decomposition and melds
  // Simplified: check if hand+melds contains 1-2-3, 4-5-6, 7-8-9 of same suit
  const allTiles = [...hand.map(toNormalTile)];
  for (const m of melds) for (const t of m.tiles) allTiles.push(toNormalTile(t));

  for (const suit of ['m', 'p', 's']) {
    const counts = new Map<string, number>();
    for (const t of allTiles) {
      if (t[1] === suit) counts.set(t, (counts.get(t) || 0) + 1);
    }
    // Check if we have at least 1-2-3, 4-5-6, 7-8-9
    let hasLow = (counts.get(`1${suit}`) || 0) >= 1 && (counts.get(`2${suit}`) || 0) >= 1 && (counts.get(`3${suit}`) || 0) >= 1;
    let hasMid = (counts.get(`4${suit}`) || 0) >= 1 && (counts.get(`5${suit}`) || 0) >= 1 && (counts.get(`6${suit}`) || 0) >= 1;
    let hasHigh = (counts.get(`7${suit}`) || 0) >= 1 && (counts.get(`8${suit}`) || 0) >= 1 && (counts.get(`9${suit}`) || 0) >= 1;
    if (hasLow && hasMid && hasHigh) return true;
  }
  return false;
}

/** Check for sanshoku (three colored sequences: same numbers in m/p/s) */
function isSanshoku(hand: string[], melds: Meld[]): boolean {
  // Collect all sequence info from melds (chi melds)
  const chiSequences: string[] = [];
  for (const m of melds) {
    if (m.type === 'chi') {
      const nums = m.tiles.map(t => toNormalTile(t)).sort().map(t => t[0]).join('');
      chiSequences.push(nums);
    }
  }
  // Also check hand for potential sequences (simplified: check all possible)
  const allTiles = [...hand.map(toNormalTile)];
  for (const m of melds) for (const t of m.tiles) allTiles.push(toNormalTile(t));

  for (let num = 1; num <= 7; num++) {
    const seq = `${num}${num + 1}${num + 2}`;
    // Check if each suit has the required tiles for this sequence
    const mHas = allTiles.filter(t => t === `${num}m` || t === `${num+1}m` || t === `${num+2}m`).length >= 3;
    const pHas = allTiles.filter(t => t === `${num}p` || t === `${num+1}p` || t === `${num+2}p`).length >= 3;
    const sHas = allTiles.filter(t => t === `${num}s` || t === `${num+1}s` || t === `${num+2}s`).length >= 3;
    if (mHas && pHas && sHas) return true;
  }
  return false;
}

/** Check for chanta (all melds+pair contain at least one terminal or honor) */
function isChanta(hand: string[], melds: Meld[]): boolean {
  const allTiles = [...hand.map(toNormalTile)];
  for (const m of melds) for (const t of m.tiles) allTiles.push(toNormalTile(t));
  // Every tile must be terminal or honor, or part of a meld containing terminal/honor
  // Simplified: check that there are no "pure inner" groups (2-8 of same suit with no terminal/honor)
  // More accurate: at least one tile in each meld is terminal/honor
  for (const m of melds) {
    const hasTerminal = m.tiles.some(t => {
      const n = toNormalTile(t);
      return n[1] === 'z' || n[0] === '1' || n[0] === '9';
    });
    if (m.type === 'chi' && !hasTerminal) return false;
  }
  // Check hand tiles: pair and potential melds must contain terminal/honor
  // Simplified: just check that all tiles include at least some terminals/honors
  const handNormals = hand.map(toNormalTile);
  const hasOnlyInner = handNormals.some(t => {
    const num = parseInt(t[0]);
    return t[1] !== 'z' && num >= 2 && num <= 8;
  });
  // If hand has inner tiles, they must be part of melds containing terminals
  // Very simplified check: require at least some terminals/honors in the whole hand
  return allTiles.some(t => t[1] === 'z' || t[0] === '1' || t[0] === '9');
}

/** Check for junchan (all melds+pair contain terminals, no honors) - pure chanta */
function isJunchan(hand: string[], melds: Meld[]): boolean {
  const allTiles = [...hand.map(toNormalTile)];
  for (const m of melds) for (const t of m.tiles) allTiles.push(toNormalTile(t));
  // No honor tiles allowed
  if (allTiles.some(t => t[1] === 'z')) return false;
  // Every meld must contain a terminal
  for (const m of melds) {
    const hasTerminal = m.tiles.some(t => {
      const n = toNormalTile(t);
      return n[0] === '1' || n[0] === '9';
    });
    if (m.type === 'chi' && !hasTerminal) return false;
  }
  return allTiles.some(t => t[0] === '1' || t[0] === '9');
}

/** Count ankou (concealed triplets) in hand + melds */
function countAnkou(melds: Meld[], hand: string[]): number {
  let count = 0;
  // Ankan melds are always ankou
  count += melds.filter(m => m.type === 'ankan').length;
  // Check hand for concealed triplets (triplets not in melds)
  const meldedTiles = new Set<string>();
  for (const m of melds) {
    for (const t of m.tiles) meldedTiles.add(toNormalTile(t));
  }
  const handCounts = new Map<string, number>();
  for (const t of hand) {
    const n = toNormalTile(t);
    handCounts.set(n, (handCounts.get(n) || 0) + 1);
  }
  for (const [tile, cnt] of handCounts) {
    if (cnt >= 3 && !meldedTiles.has(tile)) count++;
  }
  return count;
}

/** Calculate fu (minipoints) for a winning hand */
function calculateFu(
  hand: string[], melds: Meld[], winTile: string,
  isZimo: boolean, isRiichi: boolean, isMenzen: boolean,
  seat: number, round: number, isChiitoiHand: boolean
): number {
  if (isChiitoiHand) return 25; // Chiitoi is always 25 fu

  let fu = 20; // Base fu

  // Menzen ron bonus +10
  if (isMenzen && !isZimo) fu += 10;

  // Meld fu
  for (const meld of melds) {
    const tiles = meld.tiles.map(toNormalTile);
    const isTerminal = tiles.some(t => {
      const n = parseInt(t[0]);
      const s = t[1];
      return s === 'z' || n === 1 || n === 9;
    });
    if (meld.type === 'chi') continue; // Sequences have no fu
    if (meld.type === 'pon') fu += isTerminal ? 4 : 2;
    if (meld.type === 'ankan') fu += isTerminal ? 32 : 16;
    if (meld.type === 'daiminkan' || meld.type === 'kakan') fu += isTerminal ? 16 : 8;
  }

  // Check for concealed triplets in hand (not in melds)
  const meldTiles = new Set<string>();
  for (const m of melds) for (const t of m.tiles) meldTiles.add(toNormalTile(t));
  const handCounts = new Map<string, number>();
  for (const t of hand) handCounts.set(toNormalTile(t), (handCounts.get(toNormalTile(t)) || 0) + 1);
  for (const [tile, cnt] of handCounts) {
    if (cnt >= 3 && !meldTiles.has(tile)) {
      const isTerminal = tile[1] === 'z' || tile[0] === '1' || tile[0] === '9';
      fu += isTerminal ? 8 : 4; // Concealed triplet in hand
    }
  }

  // Yakuhai pair (dragon pair or seat/round wind pair) +2 fu each
  const pairCounts = new Map<string, number>();
  for (const t of hand) pairCounts.set(toNormalTile(t), (pairCounts.get(toNormalTile(t)) || 0) + 1);
  for (const [tile, cnt] of pairCounts) {
    if (cnt === 2) {
      // Dragon pair
      if (tile === '5z' || tile === '6z' || tile === '7z') fu += 2;
      // Seat wind pair
      if (tile === `${seat + 1}z`) fu += 2;
      // Round wind pair
      if (tile === `${round + 1}z`) fu += 2;
    }
  }

  // Tsumo bonus (not with pinhu)
  if (isZimo && isMenzen) fu += 2;

  // Round up to 10
  fu = Math.ceil(fu / 10) * 10;

  // Minimum fu is 30
  if (fu < 30) fu = 30;

  return fu;
}

// ─── Scoring ─────────────────────────────────────────────────────────

interface ScoreResult {
  han: number;
  fu: number;
  fans: { name: string; val: number; id: number }[];
  yiman: boolean;
}

function calculateScore(engine: MahjongEngine, w: WinInfo, isRinshan: boolean = false, isLastTile: boolean = false, isChankan: boolean = false): ScoreResult {
  let han = 0;
  const fans: { name: string; val: number; id: number }[] = [];
  const isMenzen = engine.players[w.seat].menzen;
  const isRiichi = engine.players[w.seat].isRiichi;
  const isDealer = w.seat === engine.dealer;

  // ─── Yakuman checks first ──────────────────────────────────────────

  // Kokushi (thirteen orphans) - yakuman
  const chiitoiHand = isChiitoi([...w.hand, w.huTile]);
  const kokushiHand = isKokushi([...w.hand, w.huTile]);

  if (kokushiHand) {
    fans.push({ name: '国士無双', val: 13, id: 35 });
    const fu = calculateFu(w.hand, w.melds, w.huTile, w.isZimo, isRiichi, isMenzen, w.seat, engine.round, false);
    return { han: 13, fu, fans, yiman: true };
  }

  // Suuankou (four concealed triplets) - yakuman
  const ankouCount = countAnkou(w.melds, w.hand);
  if (ankouCount >= 4) {
    fans.push({ name: '四暗刻', val: 13, id: 37 });
    const fu = calculateFu(w.hand, w.melds, w.huTile, w.isZimo, isRiichi, isMenzen, w.seat, engine.round, false);
    return { han: 13, fu, fans, yiman: true };
  }

  // ─── Regular yaku ──────────────────────────────────────────────────

  // Riichi (id=1)
  if (isRiichi) {
    han += 1;
    fans.push({ name: '立直', val: 1, id: 1 });
  }

  // Ippatsu (id=3): riichi + first turn win
  if (isRiichi && engine.players[w.seat].riichiTurn >= 0 && engine.step - engine.players[w.seat].riichiTurn <= 1) {
    han += 1;
    fans.push({ name: '一発', val: 1, id: 3 });
  }

  // Menzen tsumo (id=2)
  if (isMenzen && w.isZimo) {
    han += 1;
    fans.push({ name: '門前清自摸和', val: 1, id: 2 });
  }

  // Rinshan (id=4)
  if (isRinshan) {
    han += 1;
    fans.push({ name: '嶺上開花', val: 1, id: 4 });
  }

  // Chankan (id=5)
  if (isChankan) {
    han += 1;
    fans.push({ name: '槍槓', val: 1, id: 5 });
  }

  // Haidi (id=6): last tile + zimo
  if (isLastTile && w.isZimo) {
    han += 1;
    fans.push({ name: '海底摸月', val: 1, id: 6 });
  }

  // Hedi (id=7): last tile + ron
  if (isLastTile && !w.isZimo) {
    han += 1;
    fans.push({ name: '河底撈魚', val: 1, id: 7 });
  }

  // Check for yakuhai (honor tiles in hand)
  const handNormal = w.hand.map(t => toNormalTile(t));
  const allTiles = [...handNormal];
  for (const meld of w.melds) {
    for (const t of meld.tiles) {
      allTiles.push(toNormalTile(t));
    }
  }

  // Yakuhai: round wind (East = 1z in East round)
  const roundWindTile = `${engine.round + 1}z`;
  const roundWindCount = allTiles.filter(t => t === roundWindTile).length;
  if (roundWindCount >= 3) {
    han += 1;
    fans.push({ name: '役牌', val: 1, id: 10 + engine.round });
  }

  // Yakuhai: seat wind
  const seatWindTile = `${w.seat + 1}z`;
  const seatWindCount = allTiles.filter(t => t === seatWindTile).length;
  if (seatWindCount >= 3 && seatWindTile !== roundWindTile) {
    han += 1;
    fans.push({ name: '役牌', val: 1, id: 14 + w.seat });
  }

  // Yakuhai: dragons (5z=Haku, 6z=Hatsu, 7z=Chun)
  for (const dragon of ['5z', '6z', '7z']) {
    const count = allTiles.filter(t => t === dragon).length;
    if (count >= 3) {
      han += 1;
      const dragonNames: Record<string, string> = { '5z': '白', '6z': '發', '7z': '中' };
      const dragonIds: Record<string, number> = { '5z': 17, '6z': 18, '7z': 19 };
      fans.push({ name: `役牌${dragonNames[dragon]}`, val: 1, id: dragonIds[dragon] });
    }
  }

  // Tanyao (id=20)
  const hasTerminalOrHonor = allTiles.some(t => {
    const n = toNormalTile(t);
    const num = parseInt(n[0]);
    const suit = n[1];
    return suit === 'z' || num === 1 || num === 9;
  });
  if (!hasTerminalOrHonor) {
    han += 1;
    fans.push({ name: '断幺九', val: 1, id: 20 });
  }

  // Pinhu (id=21) - simplified check
  if (isMenzen && w.melds.length === 0 && !w.isZimo) {
    const hasTriplet = checkHandHasTriplet(w.hand);
    if (!hasTriplet) {
      han += 1;
      fans.push({ name: '平和', val: 1, id: 21 });
    }
  }

  // Toitoi (id=22)
  if (isToitoi(w.melds)) {
    han += 2;
    fans.push({ name: '対々和', val: 2, id: 22 });
  }

  // Chiitoi (id=23) - requires menzen
  if (chiitoiHand && isMenzen) {
    han += 2;
    fans.push({ name: '七対子', val: 2, id: 23 });
  }

  // Chanta (id=24)
  if (isChanta(w.hand, w.melds)) {
    han += isMenzen ? 2 : 1;
    fans.push({ name: '混全帯幺九', val: isMenzen ? 2 : 1, id: 24 });
  }

  // Ippitsu straight (id=25)
  if (isIppitsu(w.hand, w.melds)) {
    han += isMenzen ? 2 : 1;
    fans.push({ name: '一気通貫', val: isMenzen ? 2 : 1, id: 25 });
  }

  // Sanshoku (id=26)
  if (isSanshoku(w.hand, w.melds)) {
    han += isMenzen ? 2 : 1;
    fans.push({ name: '三色同順', val: isMenzen ? 2 : 1, id: 26 });
  }

  // Sanankou (id=28)
  if (ankouCount >= 3) {
    han += 2;
    fans.push({ name: '三暗刻', val: 2, id: 28 });
  }

  // Honitsu (id=30)
  if (isHonitsu(w.hand, w.melds)) {
    han += isMenzen ? 3 : 2;
    fans.push({ name: '混一色', val: isMenzen ? 3 : 2, id: 30 });
  }

  // Junchan (id=31)
  if (isJunchan(w.hand, w.melds)) {
    han += isMenzen ? 3 : 2;
    fans.push({ name: '純全帯幺九', val: isMenzen ? 3 : 2, id: 31 });
  }

  // Chinitsu (id=34)
  if (isChinitsu(w.hand, w.melds)) {
    han += isMenzen ? 6 : 5;
    fans.push({ name: '清一色', val: isMenzen ? 6 : 5, id: 34 });
  }

  // If no yaku found, give minimum (this shouldn't happen with proper canWin)
  if (han === 0) {
    han = 1;
    fans.push({ name: '断幺九', val: 1, id: 20 }); // fallback
  }

  // Calculate fu using the precise function
  const fu = calculateFu(w.hand, w.melds, w.huTile, w.isZimo, isRiichi, isMenzen, w.seat, engine.round, chiitoiHand && isMenzen);

  // Dora count
  const doraCount = countDora(w.hand, w.melds, engine.doraIndicators);
  if (doraCount > 0) {
    han += doraCount;
    fans.push({ name: 'ドラ', val: doraCount, id: 52 });
  }

  // Ura dora (only if riichi)
  if (isRiichi) {
    const uraDoraCount = countDora(w.hand, w.melds, engine.uraDoraIndicators);
    if (uraDoraCount > 0) {
      han += uraDoraCount;
      fans.push({ name: '裏ドラ', val: uraDoraCount, id: 53 });
    }
  }

  const yiman = han >= 13;
  return { han: yiman ? 13 : han, fu, fans, yiman };
}

function checkHandHasTriplet(hand: string[]): boolean {
  const counts = new Map<string, number>();
  for (const t of hand) {
    const n = toNormalTile(t);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  for (const count of counts.values()) {
    if (count >= 3) return true;
  }
  return false;
}

function countDora(hand: string[], melds: Meld[], doraIndicators: string[]): number {
  let count = 0;
  const doraTiles = doraIndicators.map(ind => getDoraTile(ind));

  const allTiles = [...hand];
  for (const meld of melds) {
    allTiles.push(...meld.tiles);
  }

  for (const tile of allTiles) {
    const normal = toNormalTile(tile);
    if (doraTiles.includes(normal)) {
      count++;
    }
    // Red fives are also dora
    if (tile === '0m' || tile === '0p' || tile === '0s') {
      count++;
    }
  }

  return count;
}

function getDoraTile(indicator: string): string {
  const normal = toNormalTile(indicator);
  const suit = normal[1];
  const num = parseInt(normal[0]);

  if (suit === 'z') {
    // Winds: 1→2, 2→3, 3→4, 4→1
    if (num >= 1 && num <= 3) return `${num + 1}z`;
    if (num === 4) return '1z';
    // Dragons: 5→6, 6→7, 7→5
    if (num === 5) return '6z';
    if (num === 6) return '7z';
    if (num === 7) return '5z';
  }

  // Numbered suits: wrap 9→1
  if (num === 9) return `1${suit}`;
  return `${num + 1}${suit}`;
}

interface PointResult {
  ron: number;
  zimoQin: number;
  zimoXian: number;
}

function calculatePoints(han: number, fu: number, isDealer: boolean, yiman: boolean): PointResult {
  if (yiman) {
    if (isDealer) {
      return { ron: 48000, zimoQin: 16000, zimoXian: 16000 };
    }
    return { ron: 32000, zimoQin: 16000, zimoXian: 8000 };
  }

  // Point table (simplified)
  if (han >= 11) return isDealer
    ? { ron: 36000, zimoQin: 12000, zimoXian: 12000 }
    : { ron: 24000, zimoQin: 12000, zimoXian: 6000 };
  if (han >= 8) return isDealer
    ? { ron: 24000, zimoQin: 8000, zimoXian: 8000 }
    : { ron: 16000, zimoQin: 8000, zimoXian: 4000 };
  if (han >= 6) return isDealer
    ? { ron: 18000, zimoQin: 6000, zimoXian: 6000 }
    : { ron: 12000, zimoQin: 6000, zimoXian: 3000 };
  if (han === 5) return isDealer
    ? { ron: 12000, zimoQin: 4000, zimoXian: 4000 }
    : { ron: 8000, zimoQin: 4000, zimoXian: 2000 };
  if (han === 4) {
    if (fu >= 40) return isDealer
      ? { ron: 12000, zimoQin: 4000, zimoXian: 4000 }
      : { ron: 8000, zimoQin: 4000, zimoXian: 2000 };
    return isDealer
      ? { ron: 8000, zimoQin: 2000, zimoXian: 2000 }
      : { ron: 5200, zimoQin: 2600, zimoXian: 1300 };
  }
  if (han === 3) {
    if (fu >= 70) return isDealer
      ? { ron: 12000, zimoQin: 4000, zimoXian: 4000 }
      : { ron: 8000, zimoQin: 4000, zimoXian: 2000 };
    if (fu >= 60) return isDealer
      ? { ron: 8000, zimoQin: 2000, zimoXian: 2000 }
      : { ron: 5200, zimoQin: 2600, zimoXian: 1300 };
    return isDealer
      ? { ron: 5800, zimoQin: 2000, zimoXian: 2000 }
      : { ron: 3900, zimoQin: 2000, zimoXian: 1000 };
  }
  if (han === 2) {
    if (fu >= 60) return isDealer
      ? { ron: 5800, zimoQin: 2000, zimoXian: 2000 }
      : { ron: 3900, zimoQin: 2000, zimoXian: 1000 };
    if (fu >= 40) return isDealer
      ? { ron: 3900, zimoQin: 1300, zimoXian: 1300 }
      : { ron: 2600, zimoQin: 1300, zimoXian: 700 };
    return isDealer
      ? { ron: 2900, zimoQin: 1000, zimoXian: 1000 }
      : { ron: 2000, zimoQin: 1000, zimoXian: 500 };
  }
  // han === 1
  if (fu >= 70) return isDealer
    ? { ron: 2900, zimoQin: 1000, zimoXian: 1000 }
    : { ron: 2000, zimoQin: 1000, zimoXian: 500 };
  if (fu >= 50) return isDealer
    ? { ron: 2000, zimoQin: 700, zimoXian: 700 }
    : { ron: 1300, zimoQin: 700, zimoXian: 400 };
  return isDealer
    ? { ron: 1500, zimoQin: 500, zimoXian: 500 }
    : { ron: 1000, zimoQin: 500, zimoXian: 300 };
}

function shouldGameEnd(engine: MahjongEngine, scores: number[]): boolean {
  // End if any player is below 0
  if (scores.some(s => s < 0)) return true;
  // End if we've gone through all rounds (East + South = chang 0 and 1)
  // This is checked in confirmNewRound
  return false;
}

// ─── Exhaustive draw ─────────────────────────────────────────────────

function handleExhaustiveDraw(client: GameClient): void {
  const engine = client.engine!;
  clearPendingOp(client);

  // Calculate tenpai/noten payments
  const tenpaiPlayers: number[] = [];
  for (let i = 0; i < engine.players.length; i++) {
    if (engine.isTenpai(i)) {
      tenpaiPlayers.push(i);
    }
  }

  const oldScores = engine.players.map(p => p.score);
  const deltaScores = new Array(engine.players.length).fill(0) as number[];

  if (tenpaiPlayers.length > 0 && tenpaiPlayers.length < engine.players.length) {
    const notenCount = engine.players.length - tenpaiPlayers.length;
    const payment = 3000; // total tenpai payment
    const perNoten = Math.floor(payment / tenpaiPlayers.length);
    const perTenpai = Math.floor(payment / notenCount);

    for (const seat of tenpaiPlayers) {
      deltaScores[seat] += perNoten;
    }
    for (let i = 0; i < engine.players.length; i++) {
      if (!tenpaiPlayers.includes(i)) {
        deltaScores[i] -= perTenpai;
      }
    }
  }

  const newScores = oldScores.map((s, i) => s + deltaScores[i]);
  for (let i = 0; i < engine.players.length; i++) {
    engine.players[i].score = newScores[i];
  }

  // Track dealer tenpai for renchan
  client.dealerTenpai = tenpaiPlayers.includes(engine.dealer);
  client.lastWasRyukyoku = true;
  client.lastWinnerSeat = null;

  const gameEnd = shouldGameEnd(engine, newScores);

  sendActionNotify(client, 'ActionNoTile', {
    liujumanguan: false,
    players: engine.players.map((p, i) => ({
      tingpai: tenpaiPlayers.includes(i),
      hand: [...p.hand],
      alreadyHule: false,
    })),
    scores: engine.players.map((_, i) => ({
      seat: i,
      oldScores: oldScores,
      deltaScores: deltaScores,
    })),
    gameend: gameEnd ? { scores: newScores } : null,
  }, engine.step);

  if (gameEnd) {
    setTimeout(() => endGame(client), 2000);
  }
}

// ─── Confirm new round ───────────────────────────────────────────────

function handleConfirmNewRound(client: GameClient, msgId: number): void {
  sendResponse(client, msgId, 'lq.ResCommon', { error: {} });

  const engine = client.engine!;

  // Determine next round
  let nextChang = engine.round;
  let nextJu = engine.ju;
  let nextHonba = engine.honba;

  if (client.lastWinnerSeat !== null && client.lastWinnerSeat === engine.dealer) {
    // Dealer won - renchan (same dealer, honba + 1)
    nextHonba++;
  } else if (client.lastWasRyukyoku && client.dealerTenpai) {
    // Ryukyoku with dealer tenpai - renchan
    nextHonba++;
  } else {
    // Rotate dealer
    nextJu = (engine.ju + 1) % engine.config.numPlayers;
    nextHonba = 0;
    if (nextJu === 0) {
      nextChang = engine.round + 1;
    }
  }

  // Check if game should end
  if (nextChang >= 2) { // East + South round only
    endGame(client);
    return;
  }

  // Check if any player is bankrupt
  if (engine.players.some(p => p.score < 0)) {
    endGame(client);
    return;
  }

  setTimeout(() => startNewRound(client, nextChang, nextJu, nextHonba, engine.riichiSticks), 500);
}

// ─── End game ────────────────────────────────────────────────────────

function endGame(client: GameClient): void {
  const engine = client.engine!;
  client.gameActive = false;
  clearPendingOp(client);

  sendNotify(client, '.lq.NotifyGameEndResult', 'lq.NotifyGameEndResult', {
    result: {
      players: engine.players.map((p, i) => ({
        seat: i,
        totalPoint: p.score - 25000,
        partPoint1: p.score,
      })),
    },
  });

  // Send game finish reward (empty data for private server)
  sendNotify(client, '.lq.NotifyGameFinishReward', 'lq.NotifyGameFinishReward', {
    modeId: 2,
    levelChange: { levelId: 1001, score: 0 },
    matchChest: { chestId: 0, reward: [] },
    mainCharacter: { exp: 0, add: 0 },
    characterGift: { gifts: [] },
    badges: [],
  });

  // Save game record
  saveRecord({
    uuid: client.gameUuid,
    startTime: client.gameStartTime,
    endTime: Date.now(),
    players: engine.players.map((p, i) => ({
      accountId: i === client.seat ? (client.accountId || 10001) : 20001 + i,
      nickname: i === client.seat ? 'LocalPlayer' : `AI_${i}`,
      score: p.score,
      seat: i,
    })),
    config: { numPlayers: engine.config.numPlayers, initScore: engine.config.initScore },
  });
}

/** Build a GameRestore for reconnection (simplified: current state snapshot) */
function buildGameRestore(client: GameClient): any {
  const engine = client.engine!;
  const humanHand = [...engine.players[client.seat].hand];
  sortTiles(humanHand);

  // Build a single ActionNewRound action as the restore snapshot
  const actions = [{
    step: 0,
    type: 'ActionNewRound',
    data: {
      chang: engine.round,
      ju: engine.ju,
      ben: engine.honba,
      liqibang: engine.riichiSticks,
      dora: engine.doraIndicators[0] || '',
      doras: [...engine.doraIndicators],
      scores: engine.players.map(p => p.score),
      tiles: humanHand,
      leftTileCount: engine.wall.length - 14,
      tingpais0: engine.getWaitTiles(0).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
      tingpais1: engine.getWaitTiles(1).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
      tingpais2: engine.getWaitTiles(2).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
      tingpais3: engine.getWaitTiles(3).map(t => ({ tile: t, haveyi: false, yiman: false, count: 0, fu: 0 })),
    },
  }];

  return {
    actions,
    gameState: {
      step: engine.step,
      chang: engine.round,
      ju: engine.ju,
      ben: engine.honba,
      liqibang: engine.riichiSticks,
      leftTileCount: engine.wall.length - 14,
      scores: engine.players.map(p => p.score),
      doras: [...engine.doraIndicators],
    },
  };
}

// ─── OptionalOperationList helpers ───────────────────────────────────

function buildOptionalOperationList(seat: number, ops: OptionalOp[]): any {
  return {
    seat,
    operationList: ops.map(op => ({
      type: op.type,
      combination: op.combination,
    })),
    timeAdd: 0,
    timeFixed: 30,
  };
}

function setPendingOp(client: GameClient, type: 'self' | 'call', ops: OptionalOp[]): void {
  clearPendingOp(client);

  client.pendingOp = {
    type,
    operations: ops,
    timer: setTimeout(() => {
      console.log('[game] Operation timeout, auto-skipping');
      client.pendingOp = null;
      if (type === 'self') {
        // Auto-discard the first tile
        const engine = client.engine!;
        if (engine.players[client.seat].hand.length > 0) {
          const hand = engine.players[client.seat].hand;
          const tile = hand[hand.length - 1]; // discard last drawn tile
          handlePlayerDiscard(client, { tile, moqie: true });
        }
      } else {
        // Auto-skip call
        afterCallSkip(client);
      }
    }, 30000),
  };
}

function clearPendingOp(client: GameClient): void {
  if (client.pendingOp?.timer) {
    clearTimeout(client.pendingOp.timer);
  }
  client.pendingOp = null;
}

// ─── Send helpers ────────────────────────────────────────────────────

/** Create an observe token for a game client */
export function createObserveTokenForClient(clientWs: WebSocket): string {
  const { createObserveToken } = require('../shared/observe-tokens');
  return createObserveToken(clientWs);
}

function sendResponse(client: GameClient, msgId: number, typeName: string, payload: any): void {
  try {
    const frame = buildResponse(msgId, typeName, payload);
    client.ws.send(frame);
  } catch (e) {
    console.error('[game] Error sending response:', e);
  }
}

function sendNotify(client: GameClient, methodName: string, typeName: string, payload: any): void {
  try {
    const frame = buildNotify(methodName, typeName, payload);
    client.ws.send(frame);
  } catch (e) {
    console.error('[game] Error sending notify:', e);
  }
}

function sendActionNotify(client: GameClient, actionName: string, actionPayload: any, step: number): void {
  try {
    const frame = buildActionNotify(actionName, actionPayload, step);
    client.ws.send(frame);
  } catch (e) {
    console.error(`[game] Error sending action notify ${actionName}:`, e);
  }

  // Also send to observe clients watching this game
  for (const [obsWs, obsClient] of observeClients) {
    if (obsClient.targetClient && obsClient.targetClient.ws === client.ws) {
      try {
        const frame = buildActionNotify(actionName, actionPayload, step);
        obsWs.send(frame);
      } catch (e) {
        // Ignore errors for observe clients
      }
    }
  }
}

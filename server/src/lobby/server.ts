/**
 * Lobby WebSocket server - minimal implementation.
 *
 * Handles: login, fetchInfo, heartbeat, createRoom, joinRoom.
 * After createRoom/joinRoom, sends NotifyRoomGameStart to redirect to Game server.
 */

import WebSocket, { WebSocketServer } from 'ws';
import {
  initProto, LiqiSession, buildResponse, buildNotify,
  MessageType, LiqiMessage,
} from '../proto/proto-loader';
import { getRecord, getRecordList, GameRecordData } from '../shared/game-records';
import * as db from '../shared/database';
import { getGameData } from '../shared/game-data';
import { getConfig } from '../shared/config';
import { createObserveToken } from '../shared/observe-tokens';

const config = getConfig();
const LOBBY_PORT = config.server.lobby_port;
const GAME_SERVER_URL = `ws://${config.server.host}:${config.server.game_port}`;

interface RoomPlayer {
  accountId: number;
  nickname: string;
  avatarId: number;
  ready: boolean;
}

interface RoomState {
  roomId: number;
  ownerId: number;
  players: RoomPlayer[];
  maxPlayerCount: number;
  mode: number;
  detailRule: any;
  publicLive: boolean;
  gameStarted: boolean;
}

let nextRoomId = 1;
const rooms: Map<number, RoomState> = new Map();

interface ContestState {
  contestId: string;
  contestName: string;
  ownerId: number;
  players: number[];
  state: 'waiting' | 'playing' | 'finished';
  gameRule: any;
}

let nextContestId = 1;
const contests: Map<string, ContestState> = new Map();

interface LobbyClient {
  ws: WebSocket;
  accountId: number | null;
  nickname: string;
  session: LiqiSession;
}

const clients: Map<WebSocket, LobbyClient> = new Map();

export async function startLobbyServer(): Promise<void> {
  try {
    await initProto();
  } catch {
    // Already initialized
  }

  const wss = new WebSocketServer({
    port: LOBBY_PORT,
    // Don't negotiate any subprotocol — return false so ws does NOT include
    // Sec-WebSocket-Protocol in the 101 response.  BestHTTP may send an empty
    // protocol header when ssl=false; returning '' previously caused ws to
    // include "Sec-WebSocket-Protocol: " (empty value) which some clients reject.
    handleProtocols: (protocols, request) => {
      console.log(`[lobby] Client offered protocols: ${[...protocols].join(', ') || '(none)'}`);
      return false;
    },
    verifyClient: (info, callback) => {
      // Log upgrade request headers for debugging
      const headers = info.req.headers;
      console.log(`[lobby] Upgrade request: ${info.req.method} ${info.req.url}`);
      console.log(`[lobby]   Host: ${headers.host}`);
      console.log(`[lobby]   Sec-WebSocket-Protocol: ${headers['sec-websocket-protocol'] ?? '(not set)'}`);
      console.log(`[lobby]   Origin: ${headers.origin ?? '(not set)'}`);
      callback(true);
    },
  });
  console.log(`[lobby] Lobby server started on port ${LOBBY_PORT}`);

  wss.on('connection', (ws) => {
    const client: LobbyClient = { ws, accountId: null, nickname: '', session: new LiqiSession() };
    clients.set(ws, client);
    console.log('[lobby] Client connected');

    ws.on('message', (data: Buffer) => {
      try {
        console.log(`[lobby] Received ${data.length} bytes, hex: ${data.subarray(0, Math.min(32, data.length)).toString('hex')}`);
        const msg = client.session.parseFrame(data);
        console.log(`[lobby] Parsed message: type=${msg.msgType}, method=${msg.methodName}, payload=${JSON.stringify(msg.payload)}`);
        handleLobbyMessage(client, msg);
      } catch (e) {
        console.error('[lobby] Error parsing message:', e);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('[lobby] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[lobby] WebSocket error:', err);
    });
  });
}

function handleLobbyMessage(client: LobbyClient, msg: LiqiMessage): void {
  const { msgType, msgId, methodName, payload } = msg;

  if (msgType === MessageType.REQUEST) {
    console.log(`[lobby] Request: ${methodName} (msgId=${msgId})`);

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

      // ─── Lobby service ───
      case '.lq.Lobby.fetchConnectionInfo':
        sendResponse(client, msgId!, 'lq.ResConnectionInfo', {
          clientEndpoint: {
            family: 'IPv4',
            address: '127.0.0.1',
            port: LOBBY_PORT,
          },
        });
        break;

      case '.lq.Lobby.prepareLogin':
        // Login step 1: always succeed (private server, no real auth)
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.loginBeat':
        // Periodic heartbeat after login
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.fastLogin':
      case '.lq.Lobby.oauth2Login':
      case '.lq.Lobby.login': {
        const accountName = payload.account || '';
        const password = payload.password || '';
        const token = payload.token || payload.access_token || '';

        let account = accountName ? db.findAccountByUsername(accountName) : null;

        if (!account && accountName) {
          // Auto-register
          account = db.createAccount(accountName, password, `Player${Date.now() % 10000}`);
          console.log(`[lobby] Auto-registered: ${accountName} -> id=${account.id}`);
        }

        if (!account && token) {
          // oauth2Login/fastLogin - extract account id from token
          const tokenMatch = token.match(/local-token-(\d+)/);
          if (tokenMatch) {
            account = db.findAccountById(parseInt(tokenMatch[1]));
          }
        }

        if (!account) {
          // Fallback to default account
          account = db.findAccountByUsername('default') || db.createAccount('default', '', 'LocalPlayer');
        }

        const accountId = account.id;
        client.accountId = accountId;
        client.nickname = account.nickname;
        db.updateAccountLogin(accountId);

        sendResponse(client, msgId!, 'lq.ResLogin', {
          error: {},
          accountId: accountId,
          account: {
            accountId: accountId,
            nickname: account.nickname,
            avatarId: account.avatar_id,
            level: { id: account.level_id, score: account.level_score },
            level3: { id: account.level3_id, score: account.level3_score },
            vip: account.vip,
            title: account.title,
            loginTime: account.login_time,
            logoutTime: account.logout_time,
            roomId: 0,
            antiAddiction: { onlineDuration: 0 },
            email: account.username,
            gold: account.gold,
            diamond: account.diamond,
            skinTicket: account.skin_ticket,
            signature: account.signature,
            phoneVerify: 0,
            emailVerify: account.username ? 1 : 0,
            avatarFrame: account.avatar_frame,
            verified: account.verified,
          },
          accessToken: `local-token-${accountId}`,
          hasUnreadAnnouncement: false,
          country: 'chs',
          isIdCardAuthed: true,
          signupTime: account.signup_time,
        });
        break;
      }

      case '.lq.Lobby.signup': {
        const accountName = payload.account || '';
        const password = payload.password || '';

        if (!accountName) {
          sendResponse(client, msgId!, 'lq.ResSignupAccount', { error: { code: 2001 } });
          break;
        }

        const existing = db.findAccountByUsername(accountName);
        if (!existing) {
          db.createAccount(accountName, password, `Player${Date.now() % 10000}`);
          console.log(`[lobby] Registered: ${accountName}`);
        }

        sendResponse(client, msgId!, 'lq.ResSignupAccount', { error: {} });
        break;
      }

      case '.lq.Lobby.oauth2Auth': {
        // Private server: return a fake access_token
        const socioType = payload.type || 0;
        const code = payload.code || 'local-code';
        // Create a temporary account to get a token
        const tempAccount = db.findAccountByUsername('default') || db.createAccount('default', '', 'LocalPlayer');
        const accessToken = `local-token-${tempAccount.id}`;

        sendResponse(client, msgId!, 'lq.ResOauth2Auth', {
          error: {},
          accessToken: accessToken,
        });
        console.log(`[lobby] oauth2Auth type=${socioType} code=${code} -> token=${accessToken}`);
        break;
      }

      case '.lq.Lobby.oauth2Check': {
        // Private server: always has_account=true so it goes to login directly
        sendResponse(client, msgId!, 'lq.ResOauth2Check', {
          error: {},
          hasAccount: true,
        });
        break;
      }

      case '.lq.Lobby.oauth2Signup': {
        // Private server: auto-register via OAuth2
        const socioType = payload.type || 0;
        const accessToken = payload.access_token || '';
        const email = payload.email || '';

        // Extract account id from token or create new
        let account: db.AccountRow | undefined;
        const tokenMatch = accessToken.match(/local-token-(\d+)/);
        if (tokenMatch) {
          account = db.findAccountById(parseInt(tokenMatch[1]));
        }

        // Create account if not exists
        const accountKey = email || `oauth2_${socioType}_${account?.id || 0}`;
        if (!db.findAccountByUsername(accountKey)) {
          account = db.createAccount(accountKey, '', `Player${Date.now() % 10000}`);
          console.log(`[lobby] oauth2Signup: ${accountKey} -> id=${account.id}`);
        }

        sendResponse(client, msgId!, 'lq.ResOauth2Signup', {
          error: {},
        });
        break;
      }

      case '.lq.Lobby.openidCheck': {
        // Private server: always has_account=true
        sendResponse(client, msgId!, 'lq.ResOauth2Check', {
          error: {},
          hasAccount: true,
        });
        break;
      }

      case '.lq.Lobby.emailLogin': {
        // Private server: same as login
        const email = payload.email || '';
        const password = payload.password || '';

        let account = email ? db.findAccountByUsername(email) : null;
        if (!account && email) {
          account = db.createAccount(email, password, `Player${Date.now() % 10000}`);
          console.log(`[lobby] Auto-registered via email: ${email} -> id=${account.id}`);
        }

        if (!account) {
          account = db.findAccountByUsername('default') || db.createAccount('default', '', 'LocalPlayer');
        }

        const accountId = account.id;
        client.accountId = accountId;
        client.nickname = account.nickname;
        db.updateAccountLogin(accountId);

        sendResponse(client, msgId!, 'lq.ResLogin', {
          error: {},
          accountId: accountId,
          account: {
            accountId: accountId,
            nickname: account.nickname,
            avatarId: account.avatar_id,
            level: { id: account.level_id, score: account.level_score },
            level3: { id: account.level3_id, score: account.level3_score },
            vip: account.vip,
            title: account.title,
            loginTime: account.login_time,
            logoutTime: account.logout_time,
            roomId: 0,
            antiAddiction: { onlineDuration: 0 },
            email: account.username,
            gold: account.gold,
            diamond: account.diamond,
            skinTicket: account.skin_ticket,
            signature: account.signature,
            phoneVerify: 0,
            emailVerify: account.username ? 1 : 0,
            avatarFrame: account.avatar_frame,
            verified: account.verified,
          },
          accessToken: `local-token-${accountId}`,
          hasUnreadAnnouncement: false,
          country: 'chs',
          isIdCardAuthed: true,
          signupTime: account.signup_time,
        });
        break;
      }

      case '.lq.Lobby.loginSuccess': {
        // Client confirms login is complete
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        console.log(`[lobby] Account ${client.accountId} loginSuccess`);

        // Push NotifyAccountUpdate so client initializes account state
        const accountId = client.accountId;
        if (accountId) {
          const account = db.findAccountById(accountId);
          if (account) {
            const charRows = db.getAccountCharacters(accountId);
            const skinRows = db.getAccountSkins(accountId);
            sendNotify(client, '.lq.NotifyAccountUpdate', 'lq.NotifyAccountUpdate', {
              update: {
                numerical: [
                  { id: 100001, final: account.gold },
                  { id: 100002, final: account.diamond },
                  { id: 100003, final: account.skin_ticket },
                  { id: 100004, final: account.vip },
                ],
                character: {
                  characters: charRows.map(c => ({
                    charid: c.charid,
                    level: c.level,
                    exp: c.exp,
                    skin: c.skin,
                    isUpgraded: c.is_upgraded === 1,
                    extraEmoji: JSON.parse(c.extra_emoji || '[]'),
                    rewardedLevel: JSON.parse(c.rewarded_level || '[]'),
                  })),
                  skins: skinRows.map(s => s.skin_id),
                  finishedEndings: [],
                  rewardedEndings: [],
                },
                title: {
                  newTitles: [],
                  removeTitles: [],
                },
                mainCharacter: {
                  characterId: charRows.length > 0 ? charRows[0].charid : 200001,
                },
              },
            });
          }
        }
        break;
      }

      case '.lq.Lobby.logout': {
        sendResponse(client, msgId!, 'lq.ResLogout', { error: {} });
        console.log(`[lobby] Account ${client.accountId} logout`);
        break;
      }

      case '.lq.Lobby.fetchLastPrivacy': {
        // Return current privacy versions so no update needed
        sendResponse(client, msgId!, 'lq.ResFetchLastPrivacy', {
          error: {},
          privacy: [
            { type: 1, version: 'USER-20210715-1' },
            { type: 2, version: 'PRIVACY-20210715-1' },
          ],
        });
        break;
      }

      case '.lq.Lobby.checkPrivacy': {
        // Accept any privacy agreement
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
      }

      case '.lq.Lobby.bindOauth2': {
        // Private server: always succeed
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
      }

      case '.lq.Lobby.cancelDeleteAccount': {
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
      }

      case '.lq.Lobby.fetchInfo': {
        const accountId = client.accountId || 10001;
        const charRows = db.getAccountCharacters(accountId);
        const skinRows = db.getAccountSkins(accountId);
        const itemRows = db.getAccountItems(accountId);
        const titleRows = db.getAccountTitles(accountId);

        const characters = charRows.map(c => ({
          charid: c.charid,
          level: c.level,
          exp: c.exp,
          skin: c.skin,
          isUpgraded: c.is_upgraded === 1,
          extraEmoji: JSON.parse(c.extra_emoji || '[]'),
          rewardedLevel: JSON.parse(c.rewarded_level || '[]'),
        }));

        const skinIds = skinRows.map(s => s.skin_id);
        const items = itemRows.map(i => ({ itemId: i.item_id, stack: i.count }));
        const titleIds = titleRows.map(t => t.title_id);

        sendResponse(client, msgId!, 'lq.ResFetchInfo', {
          error: {},
          serverTime: { serverTime: Math.floor(Date.now() / 1000) },
          serverSetting: {
            error: {},
            settings: {
              paymentSettingV2: { openPayment: 0, paymentPlatforms: [] },
              nicknameSetting: { enable: 0, nicknames: [] },
            }
          },
          clientValue: { error: {}, datas: [] },
          friendList: { error: {}, friends: [] },
          friendApplyList: { error: {}, applies: [] },
          recentFriend: { error: {}, accountList: [] },
          mailInfo: { error: {}, mails: [] },
          receiveCoinInfo: { error: {} },
          titleList: { error: {}, titleList: titleIds },
          bagInfo: { error: {}, bag: { items } },
          shopInfo: { error: {}, shopInfo: [] },
          shopInterval: { error: {}, result: [] },
          activityData: { error: {} },
          activityInterval: { error: {}, result: [] },
          activityBuff: { error: {} },
          vipReward: { error: {} },
          monthTicketInfo: { error: {} },
          achievement: { error: {}, progresses: [], rewardedGroup: [] },
          commentSetting: { error: {}, commentAllow: 1 },
          accountSettings: { error: {}, settings: [] },
          modNicknameTime: { error: {}, lastModTime: 0 },
          misc: { error: {}, rechargedList: [], faiths: [] },
          characterInfo: {
            error: {},
            characters,
            skins: skinIds,
            mainCharacterId: characters.length > 0 ? characters[0].charid : 200001,
            hiddenCharacters: [],
            characterSort: characters.map(c => c.charid),
            otherCharacterSort: [],
            finishedEndings: [],
            rewardedEndings: [],
          },
          allCommonViews: [],
          collectedGameRecordList: { error: {}, recordList: [] },
          maintainNotice: { error: {} },
          maintenanceInfo: { functionMaintenance: [] },
          randomCharacter: { error: {} },
          seerInfo: { error: {} },
          annualReportInfo: { error: {} },
        });
        break;
      }

      case '.lq.Lobby.heatbeat':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.createRoom': {
        const accountId = client.accountId || 10001;
        const account = db.findAccountById(accountId);
        const nickname = account ? account.nickname : 'LocalPlayer';
        const avatarId = account ? account.avatar_id : 400101;
        const mode = payload.mode || {};
        const detailRule = mode.detail_rule || {};
        const playerCount = payload.player_count || 4;
        const publicLive = payload.public_live || false;

        const roomId = nextRoomId++;
        const room: RoomState = {
          roomId,
          ownerId: accountId,
          players: [{
            accountId,
            nickname,
            avatarId,
            ready: false,
          }],
          maxPlayerCount: playerCount,
          mode: mode.mode || 1,
          detailRule,
          publicLive,
          gameStarted: false,
        };
        rooms.set(roomId, room);

        sendResponse(client, msgId!, 'lq.ResCreateRoom', {
          error: {},
          room: {
            roomId: roomId,
            ownerId: accountId,
            state: 1,
            players: room.players.map(p => ({
              accountId: p.accountId,
              nickname: p.nickname,
              avatarId: p.avatarId,
            })),
            maxPlayerCount: room.maxPlayerCount,
            mode: { mode: room.mode, detailRule: room.detailRule },
            publicLive: room.publicLive,
          },
        });
        break;
      }

      case '.lq.Lobby.joinRoom': {
        const accountId = client.accountId || 10001;
        const account = db.findAccountById(accountId);
        const nickname = account ? account.nickname : 'LocalPlayer';
        const avatarId = account ? account.avatar_id : 400101;
        const roomId = payload.room_id || 1;
        const room = rooms.get(roomId);

        if (room && !room.gameStarted && room.players.length < room.maxPlayerCount) {
          // Check if already in room
          if (!room.players.some(p => p.accountId === accountId)) {
            room.players.push({
              accountId,
              nickname,
              avatarId,
              ready: false,
            });
          }

          sendResponse(client, msgId!, 'lq.ResJoinRoom', {
            error: {},
            room: {
              roomId: room.roomId,
              ownerId: room.ownerId,
              state: 1,
              players: room.players.map(p => ({
                accountId: p.accountId,
                nickname: p.nickname,
                avatarId: p.avatarId,
              })),
              maxPlayerCount: room.maxPlayerCount,
              mode: { mode: room.mode, detailRule: room.detailRule },
              publicLive: room.publicLive,
            },
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResJoinRoom', {
            error: { code: 2001 },
          });
        }
        break;
      }

      case '.lq.Lobby.matchGame': {
        const accountId = client.accountId || 10001;
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });

        // Simulate match found
        setTimeout(() => {
          sendNotify(client, '.lq.NotifyMatchGameStart', 'lq.NotifyMatchGameStart', {
            gameUrl: GAME_SERVER_URL,
            connectToken: `local-connect-token-${accountId}`,
            gameUuid: 'local-game-uuid-001',
            matchModeId: 1,
            location: 'local',
          });
        }, 1000);
        break;
      }

      case '.lq.Lobby.fetchAccountInfo': {
        const targetId = payload.account_id || client.accountId || 10001;
        const account = db.findAccountById(targetId);
        sendResponse(client, msgId!, 'lq.ResAccountInfo', {
          error: {},
          account: account ? {
            accountId: account.id,
            nickname: account.nickname,
            avatarId: account.avatar_id,
            level: { id: account.level_id, score: account.level_score },
            level3: { id: account.level3_id, score: account.level3_score },
            vip: account.vip,
            title: account.title,
            avatarFrame: account.avatar_frame,
            skinTicket: account.skin_ticket,
            verified: account.verified,
          } : {
            accountId: targetId,
            nickname: 'Unknown',
            avatarId: 400101,
            level: { id: 1001, score: 0 },
            level3: { id: 1001, score: 0 },
          },
        });
        break;
      }

      case '.lq.Lobby.fetchAccountStatisticInfo': {
        sendResponse(client, msgId!, 'lq.ResAccountStatisticInfo', {
          error: {},
          statisticData: [
            { category: '2p_rank', mode: '2p_rank', score: 1800 },
            { category: '4p_rank', mode: '4p_rank', score: 1700 },
            { category: '3p_rank', mode: '3p_rank', score: 1600 },
            { category: 'rank_point', mode: 'rank_point', score: 50000 },
          ],
          detailData: {
            totalCount: { totalRounds: 1000, total2pRounds: 500, total4pRounds: 400, total3pRounds: 100 },
            rankScore: { first: 300, second: 250, third: 200, fourth: 150 },
            maxContinuousWinCount: 5,
            maxContinuousRoundCount: 20,
          },
        });
        break;
      }

      case '.lq.Lobby.fetchAccountChallengeRankInfo': {
        sendResponse(client, msgId!, 'lq.ResAccountChallengeRankInfo', {
          error: {},
          seasonInfo: [],
        });
        break;
      }

      case '.lq.Lobby.fetchCommentList': {
        sendResponse(client, msgId!, 'lq.ResFetchCommentList', {
          error: {},
          commentAllow: 1,
          commentIdList: [],
          lastReadId: 0,
        });
        break;
      }

      case '.lq.Lobby.fetchRoomList': {
        // This method doesn't exist in liqi.json, use ResSelfRoom as fallback
        sendResponse(client, msgId!, 'lq.ResSelfRoom', { error: {} });
        break;
      }

      case '.lq.Lobby.leaveRoom': {
        const accountId = client.accountId || 10001;
        const roomId = payload.room_id || 1;
        const room = rooms.get(roomId);

        if (room) {
          room.players = room.players.filter(p => p.accountId !== accountId);
          if (room.players.length === 0) {
            rooms.delete(roomId);
          }
        }

        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
      }

      case '.lq.Lobby.fetchFriendList':
        sendResponse(client, msgId!, 'lq.ResFriendList', { friends: [] });
        break;

      case '.lq.Lobby.fetchMail':
        sendResponse(client, msgId!, 'lq.ResMailInfo', { mailList: [] });
        break;

      case '.lq.Lobby.fetchShopInfo':
        sendResponse(client, msgId!, 'lq.ResShopInfo', { shops: [] });
        break;

      case '.lq.Lobby.fetchCharacterInfo': {
        const accountId = client.accountId || 10001;
        const charRows = db.getAccountCharacters(accountId);
        const skinRows = db.getAccountSkins(accountId);

        const characters = charRows.map(c => ({
          charid: c.charid,
          level: c.level,
          exp: c.exp,
          skin: c.skin,
          isUpgraded: c.is_upgraded === 1,
          extraEmoji: JSON.parse(c.extra_emoji || '[]'),
          rewardedLevel: JSON.parse(c.rewarded_level || '[]'),
        }));

        const skinIds = skinRows.map(s => s.skin_id);

        sendResponse(client, msgId!, 'lq.ResCharacterInfo', {
          error: {},
          characters,
          skins: skinIds,
          mainCharacterId: characters.length > 0 ? characters[0].charid : 200001,
          hiddenCharacters: [],
          characterSort: characters.map(c => c.charid),
          otherCharacterSort: [],
          finishedEndings: [],
          rewardedEndings: [],
        });
        break;
      }

      case '.lq.Lobby.fetchBagInfo': {
        const accountId = client.accountId || 10001;
        const itemRows = db.getAccountItems(accountId);
        const items = itemRows.map(i => ({ itemId: i.item_id, stack: i.count }));
        sendResponse(client, msgId!, 'lq.ResBagInfo', { error: {}, bag: { items } });
        break;
      }

      case '.lq.Lobby.fetchAchievement': {
        sendResponse(client, msgId!, 'lq.ResAchievement', { error: {}, progresses: [], rewardedGroup: [] });
        break;
      }

      case '.lq.Lobby.fetchTitleList': {
        const accountId = client.accountId || 10001;
        const titleRows = db.getAccountTitles(accountId);
        const titleIds = titleRows.map(t => t.title_id);
        sendResponse(client, msgId!, 'lq.ResTitleList', { error: {}, titleList: titleIds });
        break;
      }

      case '.lq.Lobby.modifyNickname':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.updateClientValue':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.notifyClientMessage':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.fetchActivity':
        sendResponse(client, msgId!, 'lq.ResActivityList', { activityList: [] });
        break;

      case '.lq.Lobby.fetchAnnouncement':
        sendResponse(client, msgId!, 'lq.ResAnnouncement', { announcements: [] });
        break;

      case '.lq.Lobby.readyRoom': {
        const accountId = client.accountId || 10001;
        const roomId = payload.room_id || 1;
        const room = rooms.get(roomId);
        const ready = payload.ready !== false;

        if (room) {
          const player = room.players.find(p => p.accountId === accountId);
          if (player) player.ready = ready;

          sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });

          // Broadcast ready state to all players in room (simplified: just notify this client)
          sendNotify(client, '.lq.NotifyRoomPlayerReady', 'lq.NotifyRoomPlayerReady', {
            accountId: accountId,
            ready,
            roomId: roomId,
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResCommon', { error: { code: 2002 } });
        }
        break;
      }

      case '.lq.Lobby.startRoom': {
        const accountId = client.accountId || 10001;
        const roomId = payload.room_id || 1;
        const room = rooms.get(roomId);

        if (room && room.ownerId === accountId) {
          room.gameStarted = true;

          // Auto-fill with AI bots if not enough players
          while (room.players.length < room.maxPlayerCount) {
            const botId = 20001 + room.players.length;
            room.players.push({
              accountId: botId,
              nickname: `AI_${room.players.length}`,
              avatarId: 400101,
              ready: true,
            });
          }

          sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });

          // Send NotifyRoomGameStart
          sendNotify(client, '.lq.NotifyRoomGameStart', 'lq.NotifyRoomGameStart', {
            gameUrl: GAME_SERVER_URL,
            connectToken: `local-connect-token-${accountId}`,
            gameUuid: `local-game-uuid-${roomId}`,
            location: 'local',
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResCommon', { error: { code: 2003 } });
        }
        break;
      }

      case '.lq.Lobby.addRoomRobot': {
        const roomId = payload.room_id || 1;
        const room = rooms.get(roomId);

        if (room && !room.gameStarted && room.players.length < room.maxPlayerCount) {
          const botId = 20001 + room.players.length;
          room.players.push({
            accountId: botId,
            nickname: `AI_${room.players.length}`,
            avatarId: 400101,
            ready: true,
          });

          sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });

          // Notify player update
          sendNotify(client, '.lq.NotifyRoomPlayerUpdate', 'lq.NotifyRoomPlayerUpdate', {
            room: {
              roomId: room.roomId,
              ownerId: room.ownerId,
              state: 1,
              players: room.players.map(p => ({
                accountId: p.accountId,
                nickname: p.nickname,
                avatarId: p.avatarId,
              })),
              maxPlayerCount: room.maxPlayerCount,
              mode: { mode: room.mode, detailRule: room.detailRule },
              publicLive: room.publicLive,
            },
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResCommon', { error: { code: 2004 } });
        }
        break;
      }

      case '.lq.Lobby.fetchGameRecord': {
        const uuid = payload.game_uuid || '';
        const record = getRecord(uuid);
        if (record) {
          sendResponse(client, msgId!, 'lq.ResGameRecord', {
            error: {},
            record: {
              uuid: record.uuid,
              startTime: record.startTime,
              endTime: record.endTime,
              players: record.players.map(p => ({
                accountId: p.accountId,
                nickname: p.nickname,
                seat: p.seat,
                totalPoint: p.score - 25000,
              })),
              config: record.config,
            },
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResGameRecord', {
            error: { code: 3001 },
          });
        }
        break;
      }

      case '.lq.Lobby.fetchGameRecordList': {
        const records = getRecordList();
        sendResponse(client, msgId!, 'lq.ResGameRecordList', {
          error: {},
          recordList: records.map(r => ({
            uuid: r.uuid,
            startTime: r.startTime,
            endTime: r.endTime,
            players: r.players.map(p => ({
              accountId: p.accountId,
              nickname: p.nickname,
              seat: p.seat,
            })),
          })),
        });
        break;
      }

      case '.lq.Lobby.startUnifiedMatch': {
        const accountId = client.accountId || 10001;
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        // Simulate match found after 1 second
        setTimeout(() => {
          sendNotify(client, '.lq.NotifyMatchGameStart', 'lq.NotifyMatchGameStart', {
            gameUrl: GAME_SERVER_URL,
            connectToken: `local-connect-token-${accountId}`,
            gameUuid: `local-game-uuid-${Date.now()}`,
            matchModeId: payload.match_mode_id || 1,
            location: 'local',
          });
        }, 1000);
        break;
      }

      case '.lq.Lobby.cancelUnifiedMatch':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.fetchDailyTask':
        sendResponse(client, msgId!, 'lq.ResDailyTask', {
          error: {},
          tasks: [],
          refreshCount: 0,
        });
        break;

      case '.lq.Lobby.fetchReviveCoinInfo':
        sendResponse(client, msgId!, 'lq.ResReviveCoinInfo', { error: {} });
        break;

      case '.lq.Lobby.fetchCommentSetting':
        sendResponse(client, msgId!, 'lq.ResCommentSetting', {
          error: {},
          commentSetting: { commentAllowType: 0 },
        });
        break;

      case '.lq.Lobby.shopPurchase':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: { code: 4001 } });
        break;

      case '.lq.Lobby.readMail':
      case '.lq.Lobby.deleteMail':
      case '.lq.Lobby.receiveAchievementReward':
      case '.lq.Lobby.updateReadComment':
      case '.lq.Lobby.receiveMultiMailReward':
      case '.lq.Lobby.readAllMail':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.fetchReviveCurrencyInfo':
        sendResponse(client, msgId!, 'lq.ResReviveCoinInfo', {
          error: {},
          reviveCurrency: 0,
        });
        break;

      case '.lq.Lobby.fetchActivityInterval':
        sendResponse(client, msgId!, 'lq.ResFetchActivityInterval', {
          error: {},
          intervals: [],
        });
        break;

      case '.lq.Lobby.fetchSelfRoom':
        sendResponse(client, msgId!, 'lq.ResSelfRoom', {
          error: {},
          room: null,
        });
        break;

      case '.lq.Lobby.modifyRoom':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.kickRoomPlayer':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.voteRoomNext':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.createGameObserveAuth': {
        const accountId = client.accountId || 10001;
        const token = createObserveToken(null); // null because we don't have the game WS here
        sendResponse(client, msgId!, 'lq.ResCreateGameObserveAuth', {
          error: {},
          token,
          location: 'local',
        });
        break;
      }

      case '.lq.Lobby.refreshGameObserveAuth': {
        sendResponse(client, msgId!, 'lq.ResRefreshGameObserveAuth', {
          error: {},
          ttl: 3600,
        });
        break;
      }

      case '.lq.Lobby.createCustomizedContest': {
        const accountId = client.accountId || 10001;
        const contestId = `${nextContestId++}`;
        const contestName = payload.contest_name || `Contest ${contestId}`;
        const contest: ContestState = {
          contestId,
          contestName,
          ownerId: accountId,
          players: [accountId],
          state: 'waiting',
          gameRule: payload.game_rule || {},
        };
        contests.set(contestId, contest);

        sendResponse(client, msgId!, 'lq.ResCreateCustomizedContest', {
          error: {},
          contestId: contestId,
        });
        break;
      }

      case '.lq.Lobby.fetchCustomizedContestList':
        sendResponse(client, msgId!, 'lq.ResFetchCustomizedContestList', {
          error: {},
          contests: [],
        });
        break;

      case '.lq.Lobby.fetchCustomizedContestByContestId': {
        const contestId = payload.contest_id || '';
        const contest = contests.get(contestId);
        if (contest) {
          sendResponse(client, msgId!, 'lq.ResFetchCustomizedContestByContestId', {
            error: {},
            contest: {
              base: {
                uniqueId: parseInt(contest.contestId),
                contestId: contest.contestId,
                contestName: contest.contestName,
                state: contest.state === 'waiting' ? 1 : contest.state === 'playing' ? 2 : 3,
                creatorId: contest.ownerId,
                createTime: Math.floor(Date.now() / 1000),
                open: true,
                contestType: 1,
              },
              detail: {},
            },
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResFetchCustomizedContestByContestId', {
            error: { code: 7001 },
          });
        }
        break;
      }

      case '.lq.Lobby.enterCustomizedContest': {
        const accountId = client.accountId || 10001;
        const contestId = payload.contest_id || '';
        const contest = contests.get(contestId);
        if (contest && contest.state === 'waiting') {
          if (!contest.players.includes(accountId)) {
            contest.players.push(accountId);
          }
          sendResponse(client, msgId!, 'lq.ResEnterCustomizedContest', {
            error: {},
            contest: {
              base: {
                uniqueId: parseInt(contest.contestId),
                contestId: contest.contestId,
                contestName: contest.contestName,
                state: 1,
                creatorId: contest.ownerId,
                createTime: Math.floor(Date.now() / 1000),
                open: true,
                contestType: 1,
              },
              detail: {},
            },
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResEnterCustomizedContest', {
            error: { code: 7002 },
          });
        }
        break;
      }

      case '.lq.Lobby.leaveCustomizedContest': {
        const accountId = client.accountId || 10001;
        const contestId = payload.contest_id || '';
        const contest = contests.get(contestId);
        if (contest) {
          contest.players = contest.players.filter(p => p !== accountId);
        }
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
      }

      case '.lq.Lobby.signupCustomizedContest': {
        const accountId = client.accountId || 10001;
        const contestId = payload.contest_id || '';
        const contest = contests.get(contestId);
        if (contest && !contest.players.includes(accountId)) {
          contest.players.push(accountId);
        }
        sendResponse(client, msgId!, 'lq.ResSignupCustomizedContest', { error: {} });
        break;
      }

      case '.lq.Lobby.startCustomizedContest': {
        const accountId = client.accountId || 10001;
        const contestId = payload.contest_id || '';
        const contest = contests.get(contestId);
        if (contest && contest.ownerId === accountId) {
          contest.state = 'playing';
          sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });

          // Notify all players
          sendNotify(client, '.lq.NotifyCustomContestSystemMsg', 'lq.NotifyCustomContestSystemMsg', {
            contestId: contestId,
            msgType: 1, // game_start
          });
        } else {
          sendResponse(client, msgId!, 'lq.ResCommon', { error: { code: 7003 } });
        }
        break;
      }

      case '.lq.Lobby.stopCustomizedContest': {
        const accountId = client.accountId || 10001;
        const contestId = payload.contest_id || '';
        const contest = contests.get(contestId);
        if (contest && contest.ownerId === accountId) {
          contest.state = 'finished';
        }
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
      }

      case '.lq.Lobby.fetchCustomizedContestAuthInfo':
        sendResponse(client, msgId!, 'lq.ResFetchCustomizedContestAuthInfo', {
          error: {},
          observerLevel: 0,
        });
        break;

      case '.lq.Lobby.fetchCustomizedContestOnlineInfo':
        sendResponse(client, msgId!, 'lq.ResFetchCustomizedContestOnlineInfo', {
          error: {},
          playerCount: 0,
          observerCount: 0,
        });
        break;

      case '.lq.Lobby.fetchCustomizedContestGameRecords':
        sendResponse(client, msgId!, 'lq.ResFetchCustomizedContestGameRecords', {
          error: {},
          records: [],
        });
        break;

      case '.lq.Lobby.fetchCustomizedContestGameLiveList':
        sendResponse(client, msgId!, 'lq.ResFetchCustomizedContestGameLiveList', {
          error: {},
          liveList: [],
        });
        break;

      case '.lq.Lobby.joinCustomizedContestChatRoom':
        sendResponse(client, msgId!, 'lq.ResJoinCustomizedContestChatRoom', {
          error: {},
          chatRoom: '',
        });
        break;

      case '.lq.Lobby.leaveCustomizedContestChatRoom':
      case '.lq.Lobby.followCustomizedContest':
      case '.lq.Lobby.unfollowCustomizedContest':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      case '.lq.Lobby.fetchContestTeamRank':
        sendResponse(client, msgId!, 'lq.ResFetchContestTeamRank', { error: {}, ranks: [] });
        break;

      case '.lq.Lobby.fetchContestTeamMember':
        sendResponse(client, msgId!, 'lq.ResFetchContestTeamMember', { error: {}, members: [] });
        break;

      case '.lq.Lobby.fetchContestTeamPlayerRank':
      case '.lq.Lobby.fetchContestPlayerRank':
        sendResponse(client, msgId!, 'lq.ResFetchContestPlayerRank', { error: {}, ranks: [] });
        break;

      case '.lq.Lobby.fetchManagerCustomizedContestList':
        sendResponse(client, msgId!, 'lq.ResFetchManagerCustomizedContestList', {
          error: {},
          contests: [],
        });
        break;

      case '.lq.Lobby.fetchManagerCustomizedContest':
        sendResponse(client, msgId!, 'lq.ResFetchManagerCustomizedContest', {
          error: {},
          contest: null,
        });
        break;

      case '.lq.Lobby.updateManagerCustomizedContest':
      case '.lq.Lobby.generateContestManagerLoginCode':
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;

      // ─── Additional RPC handlers ───
      case '.lq.Lobby.fetchQuestionnaireList':
        sendResponse(client, msgId!, 'lq.ResFetchQuestionnaireList', {
          error: {},
          list: [],
          finishedList: [],
        });
        break;

      case '.lq.Lobby.fetchChallengeInfo':
        sendResponse(client, msgId!, 'lq.ResFetchChallengeInfo', {
          error: {},
        });
        break;

      case '.lq.Lobby.fetchChallengeSeason':
        sendResponse(client, msgId!, 'lq.ResChallengeSeasonInfo', {
          error: {},
        });
        break;

      case '.lq.Lobby.fetchSeerReportList':
        sendResponse(client, msgId!, 'lq.ResFetchSeerReportList', {
          error: {},
        });
        break;

      case '.lq.Lobby.fetchAchievementRate':
        sendResponse(client, msgId!, 'lq.ResFetchAchievementRate', {
          error: {},
        });
        break;

      case '.lq.Lobby.fetchRollingNotice':
        sendResponse(client, msgId!, 'lq.ResFetchRollingNotice', {
          error: {},
        });
        break;

      case '.lq.Lobby.fetchAccountInfoExtra':
        sendResponse(client, msgId!, 'lq.ResFetchAccountInfoExtra', {
          error: {},
        });
        break;

      default:
        // Unknown method - send generic success response
        console.log(`[lobby] Unhandled method: ${methodName}, sending empty response`);
        sendResponse(client, msgId!, 'lq.ResCommon', { error: {} });
        break;
    }
  }
}

function sendResponse(client: LobbyClient, msgId: number, typeName: string, payload: any): void {
  try {
    const frame = buildResponse(msgId, typeName, payload);
    console.log(`[lobby] Sending response: ${typeName}, msgId=${msgId}, frame size=${frame.length}`);
    client.ws.send(frame);
  } catch (e) {
    console.error(`[lobby] Error encoding response ${typeName}:`, e);
    console.error(`[lobby] Failed payload keys:`, Object.keys(payload || {}));
    // Try to send a minimal error response so the client doesn't hang
    try {
      const frame = buildResponse(msgId, typeName, { error: {} });
      client.ws.send(frame);
    } catch (e2) {
      console.error(`[lobby] Even minimal response failed for ${typeName}:`, e2);
    }
  }
}

function sendNotify(client: LobbyClient, methodName: string, typeName: string, payload: any): void {
  try {
    const frame = buildNotify(methodName, typeName, payload);
    console.log(`[lobby] Sending notify: ${methodName} (${typeName}), frame size=${frame.length}`);
    client.ws.send(frame);
  } catch (e) {
    console.error(`[lobby] Error encoding notify ${typeName}:`, e);
    console.error(`[lobby] Failed payload keys:`, Object.keys(payload || {}));
  }
}

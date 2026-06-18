/**
 * Mahjong Soul Private Server - Main Entry Point
 *
 * Starts all server components:
 * 1. Resource/Config HTTP server (port 8440)
 * 2. Lobby WebSocket server (port 8441)
 * 3. Game WebSocket server (port 8443)
 * 4. MITM Proxy server (port 23410) - optional
 */

import { startLobbyServer } from './lobby/server';
import { startGameServer } from './game/server';
import { startResourceServer } from './resource/server';
import { startMITMProxy } from './proxy/mitm-proxy';
import { loadConfig, getConfig } from './shared/config';
import { initDatabase, closeDatabase } from './shared/database';
import { loadGameData } from './shared/game-data';

async function main() {
  console.log('========================================');
  console.log('  Mahjong Soul Private Server v0.2.0');
  console.log('  Database + Game Data Version');
  console.log('========================================');
  console.log();

  try {
    // Load configuration
    const config = loadConfig();
    console.log(`[main] Config loaded: host=${config.server.host}, lobby=${config.server.lobby_port}, game=${config.server.game_port}`);

    // Initialize database
    initDatabase();
    console.log('[main] Database initialized');

    // Load game data from extracted JSON files
    loadGameData();
    console.log('[main] Game data loaded');

    // Start resource server
    startResourceServer();

    // Start lobby server (initializes protobuf)
    await startLobbyServer();

    // Start game server
    await startGameServer();

    // Start MITM proxy (optional)
    startMITMProxy();

    console.log();
    console.log('All servers started successfully!');
    console.log();
    console.log('Server endpoints:');
    console.log(`  Resource/Config:  http://${config.server.host}:${config.server.resource_port}`);
    console.log(`  Lobby WebSocket:  ws://${config.server.host}:${config.server.lobby_port}`);
    console.log(`  Game WebSocket:   ws://${config.server.host}:${config.server.game_port}`);
    console.log(`  MITM Proxy:       http://${config.server.host}:${config.server.proxy_port}`);
    console.log();
    console.log('Game config:');
    console.log(`  Init Gold: ${config.game.init_gold}, Diamond: ${config.game.init_diamond}, VIP: ${config.game.init_vip}`);
    console.log(`  Unlock all: chars=${config.game.unlock_all_characters}, skins=${config.game.unlock_all_skins}, items=${config.game.unlock_all_items}, titles=${config.game.unlock_all_titles}`);
    console.log();
    console.log('To connect the game client:');
    console.log('  1. Add to hosts file: 127.0.0.1 mjusgs.mahjongsoul.com');
    console.log('  2. Or configure client to use proxy at 127.0.0.1:23410');
    console.log();
  } catch (e) {
    console.error('Failed to start servers:', e);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[main] Shutting down...');
  closeDatabase();
  process.exit(0);
});

main();

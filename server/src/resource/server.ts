/**
 * Resource/Configuration HTTP server.
 *
 * Provides game configuration, CDN responses, and serves asset bundles.
 * When CDN domains are redirected to localhost via hosts file,
 * this server responds with minimal config that skips updates.
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import fs from 'fs';
import { getConfig } from '../shared/config';

const RESOURCE_PORT = getConfig().server.resource_port;

// Game data directory - configurable via config/default.json or environment variable
// Set GAME_DATA_DIR env var, or game_data_dir in config, or default to relative path
const GAME_DATA_DIR = process.env.GAME_DATA_DIR
  || getConfig().server.game_data_dir
  || path.resolve(process.cwd(), '..', 'game', 'Jantama_MahjongSoul_Data');
const STREAMING_DIR = path.join(GAME_DATA_DIR, 'StreamingAssets', 'StandaloneWindows');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const BUNDLE_HASH_PATH = path.join(PUBLIC_DIR, 'app', 'v3', 'release', 'ab', 'StandaloneWindows', 'bundle_hash.txt');

const app = express();

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith('/app/')) {
    console.log(`[resource] GET ${req.path}`);
  }
  next();
});

// Game configuration endpoint
app.get('/config', (req, res) => {
  res.json({
    version: '4.0.26',
    lobby_url: 'ws://127.0.0.1:8441',
    game_url: 'ws://127.0.0.1:8443',
    resource_url: 'http://127.0.0.1:8440',
  });
});

/**
 * ClientBundleSettings - intercepted from CDN
 * Return minimal config that tells client to use local assets only.
 */
app.get('/app/v3/release/clientBundleSettings/:name', (req, res) => {
  console.log(`[resource] ClientBundleSettings request: ${req.params.name}`);
  res.json({
    warehouses: [
      {
        name: "release",
        urls: [
          {
            url: `http://127.0.0.1:${RESOURCE_PORT}`,
            weight: 100000,
            TIMEOUT: 600000,
            Priority: 100,
            FASTTIMEOUT: 10000,
          }
        ],
        clientBundleSettings: "/app/v3/release/clientBundleSettings/",
        warehouseSettingPath: "/app/v3/release/warehouseSettings/chs_t-release.json",
      }
    ],
  });
});

/**
 * WarehouseSettings - intercepted from CDN
 * Return minimal config pointing to local server.
 */
app.get('/app/v3/release/warehouseSettings/:name', (req, res) => {
  console.log(`[resource] WarehouseSettings request: ${req.params.name}`);
  res.json({
    urls: [
      {
        url: `http://127.0.0.1:${RESOURCE_PORT}`,
        weight: 100000,
        TIMEOUT: 600000,
        Priority: 100,
        FASTTIMEOUT: 10000,
      }
    ],
    bundlePath: "/app/v3/release/ab/",
  });
});

/**
 * Bundle hash - return the generated hash file
 * This tells the client which bundles exist and their hashes.
 */
app.get('/app/v3/release/ab/StandaloneWindows/bundle_hash.txt', (req, res) => {
  console.log('[resource] Bundle hash request');
  res.sendFile(BUNDLE_HASH_PATH, (err) => {
    if (err) {
      console.error('[resource] Bundle hash file not found, returning empty');
      res.type('text/plain').send('');
    }
  });
});

/**
 * Serve asset bundles and config files from the StandaloneWindows directory.
 * Supports both flat filenames (encoded names like $0qqs0@...) and
 * subdirectory paths (like scenes/lobby/main.majset).
 *
 * The client requests bundles using encoded filenames from bundle_hash.txt,
 * which are all flat files in the StreamingAssets directory.
 */
app.get('/app/v3/release/ab/StandaloneWindows/*', (req, res) => {
  const wildcardPath = (req.params as any)[0]; // Everything after StandaloneWindows/
  if (!wildcardPath) {
    res.status(400).json({ error: 'Bad request' });
    return;
  }

  let filePath: string;
  try {
    filePath = decodeURIComponent(wildcardPath);
  } catch {
    filePath = wildcardPath;
  }

  // 1. Try serving from public directory first (AssetBundleConfig.json, etc.)
  const publicPath = path.join(PUBLIC_DIR, 'app', 'v3', 'release', 'ab', 'StandaloneWindows', filePath);
  if (fs.existsSync(publicPath)) {
    console.log(`[resource] Serving from public: ${filePath}`);
    res.sendFile(publicPath);
    return;
  }

  // 2. Try serving directly from StreamingAssets (flat .majset files with encoded names)
  const streamingPath = path.join(STREAMING_DIR, filePath);
  if (fs.existsSync(streamingPath)) {
    console.log(`[resource] Serving from StreamingAssets: ${filePath}`);
    res.sendFile(streamingPath);
    return;
  }

  // 3. For subdirectory paths, try replacing / with _ (Unity AB naming convention)
  //    e.g., "scenes/lobby/main.majset" -> "scenes_lobby_main.majset"
  if (filePath.includes('/')) {
    const flatName = filePath.replace(/\//g, '_');
    const flatPath = path.join(STREAMING_DIR, flatName);
    if (fs.existsSync(flatPath)) {
      console.log(`[resource] Serving flat path (${filePath} -> ${flatName})`);
      res.sendFile(flatPath);
      return;
    }
  }

  // 4. For paths without .majset extension, try appending it
  if (!filePath.endsWith('.majset')) {
    const majsetPath = path.join(STREAMING_DIR, filePath + '.majset');
    if (fs.existsSync(majsetPath)) {
      console.log(`[resource] Serving with .majset appended: ${filePath}`);
      res.sendFile(majsetPath);
      return;
    }
  }

  console.error(`[resource] Not found: ${filePath}`);
  res.status(404).json({ error: 'Not found' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Proxy CDN resource requests to official CDN
app.use('/resources', createProxyMiddleware({
  target: 'https://mahjongsoul.game.yo-star.com',
  changeOrigin: true,
  pathRewrite: {
    '^/resources': '',
  },
  onError: (err: Error, req: any, res: any) => {
    console.error('[resource] Proxy error:', err.message);
    res.status(502).json({ error: 'Proxy error' });
  },
}));

export function startResourceServer(): void {
  app.listen(RESOURCE_PORT, () => {
    console.log(`[resource] Resource server started on port ${RESOURCE_PORT}`);
    console.log(`[resource] StreamingAssets dir: ${STREAMING_DIR}`);
    console.log(`[resource] Public dir: ${PUBLIC_DIR}`);
  });
}

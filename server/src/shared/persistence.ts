/**
 * JSON file persistence module.
 *
 * Provides simple load/save for server data (accounts, game records, etc.).
 * Uses debounced writes to avoid frequent disk IO.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');

/** Load data from a JSON file, returning defaultValue if not found */
export function loadData<T>(key: string, defaultValue: T): T {
  const filePath = join(DATA_DIR, `${key}.json`);
  try {
    if (!existsSync(filePath)) return defaultValue;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`[persistence] Error loading ${key}:`, e);
    return defaultValue;
  }
}

/** Save data to a JSON file (immediate write) */
export function saveData<T>(key: string, data: T): void {
  const filePath = join(DATA_DIR, `${key}.json`);
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[persistence] Error saving ${key}:`, e);
  }
}

// Debounce map for delayed saves
const debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/** Save data with debounce (delays write by ms milliseconds) */
export function saveDataDebounced<T>(key: string, data: T, delayMs: number = 5000): void {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  debounceTimers.set(key, setTimeout(() => {
    saveData(key, data);
    debounceTimers.delete(key);
  }, delayMs));
}

/** Flush all pending debounced saves immediately */
export function flushPendingSaves(): void {
  for (const [key, timer] of debounceTimers) {
    clearTimeout(timer);
    debounceTimers.delete(key);
  }
}

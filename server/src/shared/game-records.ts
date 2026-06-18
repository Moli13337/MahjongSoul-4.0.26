/**
 * Shared game record storage - used by both lobby and game servers.
 *
 * Game server saves records on game end; lobby server reads them for fetchGameRecord/List.
 * Records are persisted to disk via the persistence module.
 */

import { loadData, saveDataDebounced } from './persistence';

export interface GameRecordPlayer {
  accountId: number;
  nickname: string;
  score: number;
  seat: number;
}

export interface GameRecordData {
  uuid: string;
  startTime: number;
  endTime: number;
  players: GameRecordPlayer[];
  config: any;
}

const STORAGE_KEY = 'game-records';

// Load records from disk on startup
let records: Map<string, GameRecordData> = new Map();
let recordList: GameRecordData[] = [];

function initializeFromDisk(): void {
  const data = loadData<{ records: GameRecordData[] }>(STORAGE_KEY, { records: [] });
  if (data.records && data.records.length > 0) {
    for (const r of data.records) {
      records.set(r.uuid, r);
    }
    recordList = data.records;
    console.log(`[game-records] Loaded ${recordList.length} records from disk`);
  }
}

// Initialize on module load
initializeFromDisk();

function persistToDisk(): void {
  saveDataDebounced(STORAGE_KEY, { records: recordList }, 5000);
}

export function saveRecord(data: GameRecordData): void {
  records.set(data.uuid, data);
  recordList.unshift(data);
  // Keep only last 100 records
  if (recordList.length > 100) {
    const removed = recordList.pop();
    if (removed) records.delete(removed.uuid);
  }
  persistToDisk();
}

export function getRecord(uuid: string): GameRecordData | undefined {
  return records.get(uuid);
}

export function getRecordList(): GameRecordData[] {
  return recordList.slice(0, 20);
}

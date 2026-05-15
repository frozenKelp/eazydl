import { spawn, type ChildProcess } from 'child_process';
import { execFile as execFileCallback } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { db, markUntrackedInFlightDownloads, queries, type DownloadRow } from './db/database.js';
import { cleanFilename, resolveFuckingFastDownloadInfo } from './scraper.js';
import { cleanUrl, HttpError, isPublicHttpUrl } from './security.js';
import { FUCKINGFAST_HOSTS, PROGRESS_DB_WRITE_INTERVAL_MS, START_RESOLVE_CONCURRENCY } from './config.js';

const execFile = promisify(execFileCallback);
const RPC_URL = 'http://localhost:6800/jsonrpc';

type ProgressCallback = (snap: ProgressSnapshot) => Promise<void>;

type AriaDownload = {
  gid: string;
  status: string;
  completedLength: string;
  totalLength: string;
  downloadSpeed: string;
  connections?: string;
  errorMessage?: string;
  errorCode?: string;
  files?: Array<{ path: string }>;
};

export interface ProgressSnapshot {
  id: number;
  gid: string;
  filename: string;
  status: string;
  bytes_downloaded: number;
  total_bytes: number;
  progress: number;
  speed: number;
  connections: number;
  error: string | null;
}

const STATUS_MAP: Record<string, string> = {
  active: 'downloading',
  waiting: 'queued',
  paused: 'paused',
  error: 'failed',
  complete: 'completed',
  removed: 'pending',
};

const RECOVERABLE_PARTIAL_ERRORS = [
  'invalid range header',
  'no uri available',
];

const ARIA_PROGRESS_KEYS = [
  'gid',
  'status',
  'completedLength',
  'totalLength',
  'downloadSpeed',
  'connections',
  'errorMessage',
  'errorCode',
  'files',
];

let rpcIdCounter = 1;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const id = String(rpcIdCounter++);
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!resp.ok) throw new Error(`RPC HTTP ${resp.status}`);
  const data = await resp.json() as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

function parseAriaInt(value: string | undefined): number {
  return Number.parseInt(value ?? '0', 10) || 0;
}

async function findAria2c(): Promise<string> {
  try {
    const { stdout } = await execFile(process.platform === 'win32' ? 'where' : 'which', ['aria2c']);
    const first = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch {
    // Fall through
  }
  throw new Error(
    'aria2c executable not found.\n' +
    'Install it first:\n' +
    '  Ubuntu/Debian: sudo apt install aria2\n' +
    '  macOS:         brew install aria2\n' +
    '  Windows:       https://aria2.github.io/',
  );
}

export class Aria2Service {
  private process: ChildProcess | null = null;
  private ownsProcess = false;
  private gidMap = new Map<number, string>();
  private revMap = new Map<string, number>();
  private outputPathMap = new Map<number, string>();
  private claimedOutputPaths = new Set<string>();
  private callbacks = new Map<number, ProgressCallback>();
  private cache = new Map<number, ProgressSnapshot>();
  private terminalSince = new Map<number, number>();
  private terminalNotified = new Set<number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollRunning = false;
  private pollFailures = 0;

  private startingDownloads = new Set<number>();
  private cancelledStarts = new Set<number>();
  private activeResolves = 0;
  private resolveQueue: Array<() => void> = [];

  isRunning = false;
  maxConcurrent = 3;
  connectionsPerFile = 4;
  readonly terminalCacheMs = 10000;

  async start(maxConcurrent = 3, connectionsPerFile = 4): Promise<void> {
    this.maxConcurrent = maxConcurrent;
    this.connectionsPerFile = connectionsPerFile;

    try {
      await rpc('aria2.getGlobalStat');
      this.isRunning = true;
      this.ownsProcess = false;
      await this.setMaxConcurrent(maxConcurrent);
      this.startPollTimer();
      console.log('Reused existing aria2c daemon on port 6800.');
      return;
    } catch {
      // Start our own daemon below
    }

    const aria2cBin = await findAria2c();
    this.process = spawn(aria2cBin, [
      '--enable-rpc',
      '--rpc-listen-all=false',
      '--rpc-listen-port=6800',
      '--rpc-allow-origin-all=true',
      `--max-concurrent-downloads=${maxConcurrent}`,
      '--continue=true',
      '--auto-file-renaming=true',
      '--allow-overwrite=false',
      '--quiet=true',
    ], { stdio: 'ignore', windowsHide: true });
    this.ownsProcess = true;

    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      try {
        await rpc('aria2.getGlobalStat');
        this.isRunning = true;
        this.pollFailures = 0;
        this.startPollTimer();
        console.log('aria2c subprocess started; RPC ready.');
        return;
      } catch {
        continue;
      }
    }

    this.process.kill();
    this.process = null;
    this.ownsProcess = false;
    throw new Error('aria2c started but its RPC server timed out after 3 s.');
  }

  async shutdown(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ownsProcess) {
      try {
        await rpc('aria2.shutdown');
      } catch {
        // Ignore shutdown races
      }
    }
    this.process?.kill();
    this.process = null;
    this.ownsProcess = false;
  }

  markInFlightUnavailable(message: string): void {
    markUntrackedInFlightDownloads(message);
    for (const row of queries.getAllDownloads.all()) {
      if (['downloading', 'queued'].includes(row.status)) {
        this.setTransientStatus(row.id, 'failed', message);
      }
    }
  }

  async restoreTrackedDownloads(): Promise<void> {
    if (!this.isRunning) return;

    const rows = queries.getDownloadsWithGid.all()
      .filter(row => ['downloading', 'queued', 'paused'].includes(row.status));
    if (!rows.length) return;

    const ariaRows = await this.loadAriaDownloads();
    const byGid = new Map(ariaRows.map(row => [row.gid, row]));
    const clearMissing = db.prepare<unknown, [string | null, number]>(
      `UPDATE downloads SET status=CASE WHEN status IN ('downloading', 'queued') THEN 'pending' ELSE status END,
                            gid=NULL,
                            error_message=COALESCE(?, error_message)
       WHERE id=?`,
    );

    let restored = 0;
    for (const row of rows) {
      if (!row.gid) continue;
      const ariaRow = byGid.get(row.gid);
      if (!ariaRow) {
        const message = ['downloading', 'queued'].includes(row.status)
          ? 'aria2c no longer tracks this download after restart.'
          : null;
        clearMissing.run(message, row.id);
        continue;
      }

      this.gidMap.set(row.id, row.gid);
      this.revMap.set(row.gid, row.id);
      this.callbacks.set(row.id, this.dbProgressCallback(row.id));
      if (ariaRow.files?.[0]?.path) {
        const outputPath = path.resolve(ariaRow.files[0].path);
        this.outputPathMap.set(row.id, outputPath);
        this.claimedOutputPaths.add(outputPath);
      }
      this.cache.set(row.id, this.snapshotFromAria(ariaRow, row.id));
      restored++;
    }

    if (restored) await this.syncAll();
  }

  private startPollTimer(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.pollLoop().catch(err => {
        console.warn('Poll loop failed:', err);
      });
    }, 1000);
  }

  private async pollLoop(): Promise<void> {
    if (!this.isRunning || this.pollRunning) return;
    if (this.process && this.ownsProcess && this.process.exitCode !== null) {
      await this.markUnavailable('aria2c subprocess exited');
      return;
    }
    this.pollRunning = true;
    try {
      await this.syncAll();
      this.pollFailures = 0;
    } catch (err) {
      this.pollFailures++;
      console.warn(`Poll loop aria2c error (${this.pollFailures}/3):`, err);
      if (this.pollFailures >= 3) await this.markUnavailable('aria2c RPC stopped responding');
    } finally {
      this.pollRunning = false;
    }
  }

  private async markUnavailable(reason: string): Promise<void> {
    console.warn(`${reason}; marking aria2c offline.`);
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.process?.kill();
    this.process = null;
    this.ownsProcess = false;
    this.pollFailures = 0;

    for (const snap of this.cache.values()) {
      if (['downloading', 'queued'].includes(snap.status)) {
        snap.status = 'failed';
        snap.speed = 0;
        snap.error = reason;
        const cb = this.callbacks.get(snap.id);
        if (cb) {
          try {
            await cb({ ...snap });
          } catch (err) {
            console.debug(`unavailable callback error for dl_id=${snap.id}:`, err);
          }
        }
      }
    }
  }

  private async loadAriaDownloads(): Promise<AriaDownload[]> {
    const active = await rpc('aria2.tellActive', [ARIA_PROGRESS_KEYS]) as AriaDownload[];
    const waiting = await rpc('aria2.tellWaiting', [0, 1000, ARIA_PROGRESS_KEYS]) as AriaDownload[];
    const stopped = await rpc('aria2.tellStopped', [0, 1000, ARIA_PROGRESS_KEYS]) as AriaDownload[];
    return [...active, ...waiting, ...stopped];
  }

  private snapshotFromAria(dl: AriaDownload, dlId: number): ProgressSnapshot {
    const status = STATUS_MAP[dl.status] ?? dl.status;
    const error = dl.errorMessage
      ? dl.errorMessage
      : dl.errorCode
        ? `Error code ${dl.errorCode}`
        : status === 'failed'
          ? 'Download failed'
          : null;
    const cachedFilename = this.cache.get(dlId)?.filename ?? '';
    const ariaFilename = dl.files?.[0]?.path ? path.basename(dl.files[0].path) : '';
    const bytesDownloaded = parseAriaInt(dl.completedLength);
    const totalBytes = parseAriaInt(dl.totalLength);
    return {
      id: dlId,
      gid: dl.gid,
      filename: cachedFilename || ariaFilename,
      status,
      bytes_downloaded: bytesDownloaded,
      total_bytes: totalBytes,
      progress: totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 10000) / 100 : 0,
      speed: parseAriaInt(dl.downloadSpeed),
      connections: parseAriaInt(dl.connections),
      error,
    };
  }

  private async syncAll(): Promise<void> {
    const all = await this.loadAriaDownloads();
    const seenGids = new Set(all.map(dl => dl.gid));

    for (const dl of all) {
      const dlId = this.revMap.get(dl.gid);
      if (dlId === undefined) continue;

      const snap = this.snapshotFromAria(dl, dlId);
      const status = snap.status;
      this.cache.set(dlId, snap);

      const isTerminal = ['completed', 'failed', 'pending'].includes(status);
      if (isTerminal) {
        if (!this.terminalSince.has(dlId)) this.terminalSince.set(dlId, Date.now());
      } else {
        this.terminalSince.delete(dlId);
        this.terminalNotified.delete(dlId);
      }

      const shouldNotify = !isTerminal || !this.terminalNotified.has(dlId);
      if (shouldNotify) {
        const cb = this.callbacks.get(dlId);
        if (cb) {
          try {
            await cb({ ...snap });
            if (isTerminal) this.terminalNotified.add(dlId);
          } catch (err) {
            console.debug(`on_update callback error for dl_id=${dlId}:`, err);
          }
        }
      }

      if (isTerminal) {
        const since = this.terminalSince.get(dlId) ?? Date.now();
        if (Date.now() - since >= this.terminalCacheMs) this.clean(dlId, dl.gid);
      }
    }

    for (const [dlId, gid] of this.gidMap) {
      if (seenGids.has(gid)) continue;
      const old = this.cache.get(dlId);
      const snap: ProgressSnapshot = {
        id: dlId,
        gid,
        filename: old?.filename ?? '',
        status: 'failed',
        bytes_downloaded: old?.bytes_downloaded ?? 0,
        total_bytes: old?.total_bytes ?? 0,
        progress: old?.progress ?? 0,
        speed: 0,
        connections: 0,
        error: 'aria2c no longer tracks this download',
      };
      const cb = this.callbacks.get(dlId);
      if (cb) {
        try {
          await cb(snap);
        } catch (err) {
          console.debug(`missing-gid callback error for dl_id=${dlId}:`, err);
        }
      }
      this.clean(dlId, gid);
    }
  }

  async enqueue(
    dlId: number,
    url: string,
    outputPath: string,
    onUpdate?: ProgressCallback,
    freshStart = false,
  ): Promise<string> {
    if (!this.isRunning) throw new Error('aria2c is not running. Check server logs.');
    if (this.gidMap.has(dlId)) throw new Error('Download is already queued in aria2c.');

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (freshStart) this.discardPartialFiles(outputPath);

    const connections = Math.max(1, Math.min(16, this.connectionsPerFile));
    const gid = await rpc('aria2.addUri', [
      [url],
      {
        dir: path.dirname(outputPath),
        out: path.basename(outputPath),
        continue: freshStart ? 'false' : 'true',
        split: String(connections),
        'min-split-size': '1M',
        'max-connection-per-server': String(connections),
      },
    ]) as string;

    this.gidMap.set(dlId, gid);
    this.revMap.set(gid, dlId);
    this.outputPathMap.set(dlId, outputPath);
    this.claimedOutputPaths.add(path.resolve(outputPath));
    this.terminalSince.delete(dlId);
    this.terminalNotified.delete(dlId);
    if (onUpdate) this.callbacks.set(dlId, onUpdate);

    db.prepare<unknown, [string, number]>(
      `UPDATE downloads SET gid=? WHERE id=?`,
    ).run(gid, dlId);

    this.cache.set(dlId, {
      id: dlId,
      gid,
      filename: path.basename(outputPath),
      status: 'queued',
      bytes_downloaded: 0,
      total_bytes: 0,
      progress: 0,
      speed: 0,
      connections: 0,
      error: null,
    });
    return gid;
  }

  private discardPartialFiles(outputPath: string): void {
    for (const filePath of [outputPath, `${outputPath}.aria2`]) {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.rmSync(filePath);
      } catch (err) {
        console.warn(`Could not remove partial download file ${filePath}:`, err);
      }
    }
  }

  private uniqueOutputPath(outputPath: string): string {
    const resolved = path.resolve(outputPath);
    const dir = path.dirname(resolved);
    const ext = path.extname(resolved);
    const stem = path.basename(resolved, ext);

    for (let n = 0; n < 10000; n++) {
      const candidate = n === 0
        ? resolved
        : path.join(dir, `${stem} (${n + 1})${ext}`);
      if (this.claimedOutputPaths.has(candidate)) continue;
      if (fs.existsSync(candidate) || fs.existsSync(`${candidate}.aria2`)) continue;
      this.claimedOutputPaths.add(candidate);
      return candidate;
    }

    const fallback = path.join(dir, `${stem}-${Date.now()}${ext}`);
    this.claimedOutputPaths.add(fallback);
    return fallback;
  }

  async pause(dlId: number): Promise<boolean> {
    if (!this.isRunning) throw new Error('aria2c is not running');
    const gid = this.gidMap.get(dlId);
    if (!gid) return false;
    try {
      await rpc('aria2.pause', [gid]);
      const snap = this.cache.get(dlId);
      if (snap) {
        snap.status = 'paused';
        snap.speed = 0;
      }
      return true;
    } catch (err) {
      console.warn(`pause(${dlId}) failed:`, err);
      throw err;
    }
  }

  async resume(dlId: number): Promise<boolean> {
    if (!this.isRunning) throw new Error('aria2c is not running');
    const gid = this.gidMap.get(dlId);
    if (!gid) return false;
    await rpc('aria2.unpause', [gid]);
    const snap = this.cache.get(dlId);
    if (snap) snap.status = 'downloading';
    return true;
  }

  async stop(dlId: number): Promise<void> {
    const gid = this.gidMap.get(dlId);
    if (gid && this.isRunning) {
      try {
        await rpc('aria2.remove', [gid]);
      } catch (err) {
        console.warn(`stop(${dlId}) aria2c remove failed:`, err);
      }
    }
    this.clean(dlId, gid ?? null);
  }

  private clean(dlId: number, gid: string | null): void {
    const outputPath = this.outputPathMap.get(dlId);
    if (outputPath) this.claimedOutputPaths.delete(path.resolve(outputPath));
    this.gidMap.delete(dlId);
    if (gid) this.revMap.delete(gid);
    this.outputPathMap.delete(dlId);
    this.callbacks.delete(dlId);
    this.cache.delete(dlId);
    this.terminalSince.delete(dlId);
    this.terminalNotified.delete(dlId);
  }

  async setMaxConcurrent(n: number): Promise<void> {
    this.maxConcurrent = Math.max(1, n);
    if (!this.isRunning) return;
    try {
      await rpc('aria2.changeGlobalOption', [{ 'max-concurrent-downloads': String(this.maxConcurrent) }]);
    } catch (err) {
      console.warn('setMaxConcurrent RPC failed:', err);
    }
  }

  setConnectionsPerFile(n: number): void {
    this.connectionsPerFile = Math.max(1, Math.min(16, n));
  }

  getProgress(dlId: number): ProgressSnapshot | undefined {
    return this.cache.get(dlId);
  }

  allProgress(): ProgressSnapshot[] {
    return [...this.cache.values()].map(snap => ({ ...snap }));
  }

  async globalStats(): Promise<Record<string, unknown>> {
    if (!this.isRunning) return { aria2_running: false };
    try {
      const s = await rpc('aria2.getGlobalStat') as {
        downloadSpeed: string;
        uploadSpeed: string;
        numActive: string;
        numWaiting: string;
        numStoppedTotal: string;
      };
      return {
        aria2_running: true,
        download_speed: parseAriaInt(s.downloadSpeed),
        upload_speed: parseAriaInt(s.uploadSpeed),
        num_active: parseAriaInt(s.numActive),
        num_waiting: parseAriaInt(s.numWaiting),
        num_stopped: parseAriaInt(s.numStoppedTotal),
      };
    } catch (err) {
      console.warn('aria2c stats unavailable:', err);
      return { aria2_running: false };
    }
  }

  // Download service integration
  needsFreshStart(message: string | null | undefined): boolean {
    const text = (message ?? '').toLowerCase();
    return RECOVERABLE_PARTIAL_ERRORS.some(marker => text.includes(marker));
  }

  private acquireResolveSlot(): Promise<void> {
    if (this.activeResolves < START_RESOLVE_CONCURRENCY) {
      this.activeResolves++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.resolveQueue.push(() => {
        this.activeResolves++;
        resolve();
      });
    });
  }

  private releaseResolveSlot(): void {
    this.activeResolves = Math.max(0, this.activeResolves - 1);
    const next = this.resolveQueue.shift();
    if (next) next();
  }

  private dbProgressCallback(
    dlId: number,
    getLastWrite = () => 0,
    setLastWrite: (value: number) => void = () => undefined,
  ): ProgressCallback {
    return async (snap: ProgressSnapshot): Promise<void> => {
      const now = Date.now();
      const isTerminal = ['completed', 'failed', 'paused'].includes(snap.status);
      if (!isTerminal && now - getLastWrite() < PROGRESS_DB_WRITE_INTERVAL_MS) return;
      setLastWrite(now);

      db.prepare<unknown, [string, number, number, string, string, string | null, string | null, string | null, number]>(`
        UPDATE downloads
        SET status=?,
            bytes_downloaded=?,
            total_bytes=?,
            filename=COALESCE(NULLIF(?, ''), filename),
            completed_at=CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
            error_message=CASE WHEN ? IS NOT NULL THEN ? ELSE error_message END,
            gid=CASE WHEN ? IN ('completed', 'failed', 'pending') THEN NULL ELSE gid END
        WHERE id=?
      `).run(
        snap.status,
        snap.bytes_downloaded,
        snap.total_bytes,
        cleanFilename(snap.filename) ?? '',
        snap.status,
        snap.error,
        snap.error?.slice(0, 500) ?? null,
        snap.status,
        dlId,
      );
    };
  }

  private setTransientStatus(
    dlId: number,
    status: 'queued' | 'failed' | 'pending',
    message: string | null = null,
  ): void {
    const old = this.cache.get(dlId);
    this.cache.set(dlId, {
      id: dlId,
      gid: old?.gid ?? '',
      filename: old?.filename ?? '',
      status,
      bytes_downloaded: old?.bytes_downloaded ?? 0,
      total_bytes: old?.total_bytes ?? 0,
      progress: old?.progress ?? 0,
      speed: 0,
      connections: 0,
      error: message,
    });
    if (['failed', 'pending'].includes(status)) {
      const timer = setTimeout(() => {
        const snap = this.cache.get(dlId);
        if (snap?.status === status && !snap.gid) this.cache.delete(dlId);
      }, this.terminalCacheMs);
      if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }
  }

  releaseStartingDownload(dlId: number): void {
    if (this.cancelledStarts.has(dlId) && !this.gidMap.has(dlId)) {
      this.cache.delete(dlId);
    }
    this.startingDownloads.delete(dlId);
    this.cancelledStarts.delete(dlId);
  }

  cancelStartingDownload(dlId: number): void {
    if (this.startingDownloads.has(dlId)) this.cancelledStarts.add(dlId);
  }

  startWasCancelled(dlId: number): boolean {
    return this.cancelledStarts.has(dlId);
  }

  isStartingDownload(dlId: number): boolean {
    return this.startingDownloads.has(dlId);
  }

  async queueDownloadStart(
    dl: DownloadRow,
    basePath: string,
    allowPaused = false,
  ): Promise<'queued' | 'already_running' | 'completed' | 'paused' | 'skipped'> {
    if (!this.isRunning) throw new HttpError(503, 'aria2c is not running. See server logs.');

    let live = this.getProgress(dl.id);
    const isStarting = this.isStartingDownload(dl.id);
    let effectiveStatus = live?.status ?? dl.status;

    if (isStarting || (live && ['downloading', 'queued'].includes(effectiveStatus))) {
      return 'already_running';
    }
    if (live && ['failed', 'pending'].includes(effectiveStatus)) {
      await this.stop(dl.id);
      live = undefined;
    }
    if (['downloading', 'queued'].includes(effectiveStatus) && !live && !isStarting) {
      effectiveStatus = 'pending';
    }
    if (effectiveStatus === 'completed') return 'completed';
    if (effectiveStatus === 'paused' && !allowPaused) return 'paused';
    if (!['pending', 'failed', 'paused'].includes(effectiveStatus)) return 'skipped';

    const freshStart = effectiveStatus === 'failed' ||
      this.needsFreshStart(live?.error ?? dl.error_message);

    db.prepare<unknown, [number, number]>(`
      UPDATE downloads
      SET status='queued',
          gid=NULL,
          error_message=NULL,
          bytes_downloaded=CASE WHEN ? THEN 0 ELSE bytes_downloaded END
      WHERE id=?
    `).run(freshStart ? 1 : 0, dl.id);

    this.cancelledStarts.delete(dl.id);
    this.startingDownloads.add(dl.id);
    this.cache.set(dl.id, {
      id: dl.id,
      gid: '',
      filename: cleanFilename(dl.filename) ?? '',
      status: 'queued',
      bytes_downloaded: freshStart ? 0 : dl.bytes_downloaded,
      total_bytes: dl.total_bytes,
      progress: dl.total_bytes > 0 ? Math.round(((freshStart ? 0 : dl.bytes_downloaded) / dl.total_bytes) * 10000) / 100 : 0,
      speed: 0,
      connections: 0,
      error: null,
    });

    const listRow = db.prepare<{ name: string }, [number]>(
      `SELECT name FROM link_lists WHERE id=?`,
    ).get(dl.list_id);
    const listName = listRow?.name ?? 'default';

    this.resolveAndStart(dl.id, basePath, listName, freshStart).catch(err => {
      console.error(`resolveAndStart failed for dl_id=${dl.id}:`, err);
    });

    return 'queued';
  }

  private async resolveAndStart(
    dlId: number,
    basePath: string,
    listName: string,
    freshStart = false,
  ): Promise<void> {
    let actualUrl: string | null = null;
    let outputPath: string | null = null;
    let lastDbWrite = 0;

    try {
      await this.acquireResolveSlot();
      try {
        const dl = queries.getDownloadById.get(dlId);
        if (!dl || dl.status !== 'queued' || this.startWasCancelled(dlId)) return;

        try {
          const sourceUrl = await cleanUrl(dl.source_url, FUCKINGFAST_HOSTS, 'download link');
          const resolved = await resolveFuckingFastDownloadInfo(sourceUrl);
          if (!(await isPublicHttpUrl(resolved.url))) {
            throw new Error('Resolved download URL is not public HTTP(S).');
          }

          actualUrl = resolved.url;
          const filename = cleanFilename(dl.filename) ??
            cleanFilename(resolved.filename) ??
            cleanFilename(actualUrl) ??
            `file_${dlId}`;
          outputPath = this.uniqueOutputPath(path.join(basePath, this.safeListName(listName), filename));
          const outputFilename = path.basename(outputPath);

          const latest = queries.getDownloadById.get(dlId);
          if (!latest || latest.status !== 'queued' || this.startWasCancelled(dlId)) return;
          db.prepare<unknown, [string, string, number]>(
            `UPDATE downloads SET resolved_url=?, filename=? WHERE id=?`,
          ).run(actualUrl, outputFilename, dlId);
        } catch (err) {
          if (!this.startWasCancelled(dlId)) {
            const msg = err instanceof Error ? err.message : String(err);
            db.prepare<unknown, [string, number]>(
              `UPDATE downloads SET status='failed', error_message=? WHERE id=?`,
            ).run(msg.slice(0, 500), dlId);
            this.setTransientStatus(dlId, 'failed', msg.slice(0, 500));
          }
          return;
        }
      } finally {
        this.releaseResolveSlot();
      }

      if (!actualUrl || !outputPath) return;
      const onUpdate = this.dbProgressCallback(dlId, () => lastDbWrite, value => {
        lastDbWrite = value;
      });

      if (this.startWasCancelled(dlId)) return;
      await this.enqueue(dlId, actualUrl, outputPath, onUpdate, freshStart);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Unexpected start task failure for dl_id=${dlId}:`, err);
      if (!this.startWasCancelled(dlId)) {
        db.prepare<unknown, [string, number]>(
          `UPDATE downloads SET status='failed', error_message=? WHERE id=?`,
        ).run(msg.slice(0, 500), dlId);
      }
    } finally {
      if (outputPath && !this.outputPathMap.has(dlId)) {
        this.claimedOutputPaths.delete(path.resolve(outputPath));
      }
      this.releaseStartingDownload(dlId);
    }
  }

  private safeListName(name: string): string {
    return name.replace(/[^a-zA-Z0-9 _-]/g, '_').replace(/^[_. ]+|[_. ]+$/g, '') || 'default';
  }
}

export const aria2 = new Aria2Service();

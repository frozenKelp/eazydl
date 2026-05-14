import { spawn, type ChildProcess } from 'child_process';
import { execFile as execFileCallback } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);
const RPC_URL = 'http://localhost:6800/jsonrpc';

type ProgressCallback = (snap: ProgressSnapshot) => Promise<void>;

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
    // Fall through to the helpful error below.
  }
  throw new Error(
    'aria2c executable not found.\n' +
    'Install it first:\n' +
    '  Ubuntu/Debian: sudo apt install aria2\n' +
    '  macOS:         brew install aria2\n' +
    '  Windows:       https://aria2.github.io/',
  );
}

class Aria2Manager {
  private process: ChildProcess | null = null;
  private ownsProcess = false;
  private gidMap = new Map<number, string>();
  private revMap = new Map<string, number>();
  private callbacks = new Map<number, ProgressCallback>();
  private cache = new Map<number, ProgressSnapshot>();
  private terminalSince = new Map<number, number>();
  private terminalNotified = new Set<number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollRunning = false;
  private pollFailures = 0;

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
      // Start our own daemon below.
    }

    const aria2cBin = await findAria2c();
    this.process = spawn(aria2cBin, [
      '--enable-rpc',
      '--rpc-listen-all=false',
      '--rpc-listen-port=6800',
      '--rpc-allow-origin-all=true',
      `--max-concurrent-downloads=${maxConcurrent}`,
      '--continue=true',
      '--auto-file-renaming=false',
      '--allow-overwrite=true',
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
        // Ignore shutdown races.
      }
    }
    this.process?.kill();
    this.process = null;
    this.ownsProcess = false;
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

  private async syncAll(): Promise<void> {
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
    const keys = ['gid', 'status', 'completedLength', 'totalLength', 'downloadSpeed', 'connections', 'errorMessage', 'errorCode', 'files'];
    const active = await rpc('aria2.tellActive', [keys]) as AriaDownload[];
    const waiting = await rpc('aria2.tellWaiting', [0, 1000, keys]) as AriaDownload[];
    const stopped = await rpc('aria2.tellStopped', [0, 1000, keys]) as AriaDownload[];
    const all = [...active, ...waiting, ...stopped];
    const seenGids = new Set(all.map(dl => dl.gid));

    for (const dl of all) {
      const dlId = this.revMap.get(dl.gid);
      if (dlId === undefined) continue;

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
      const snap: ProgressSnapshot = {
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

    // FuckingFast frequently mishandles bounded range requests, so a single
    // connection is more reliable than segmented downloads for this host.
    const connections = 1;
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
    this.terminalSince.delete(dlId);
    this.terminalNotified.delete(dlId);
    if (onUpdate) this.callbacks.set(dlId, onUpdate);

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

  async resume(dlId: number): Promise<void> {
    if (!this.isRunning) return;
    const gid = this.gidMap.get(dlId);
    if (!gid) return;
    await rpc('aria2.unpause', [gid]);
    const snap = this.cache.get(dlId);
    if (snap) snap.status = 'downloading';
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
    this.gidMap.delete(dlId);
    if (gid) this.revMap.delete(gid);
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
}

export const dm = new Aria2Manager();

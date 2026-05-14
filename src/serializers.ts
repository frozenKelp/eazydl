import { queries, type DownloadRow, type LinkListRow } from './db/database.js';
import { dm } from './downloader.js';
import { cleanFilename } from './scraper.js';

export function downloadToDict(d: DownloadRow): Record<string, unknown> {
  const live = dm.getProgress(d.id);
  const bytesDownloaded = live?.bytes_downloaded ?? d.bytes_downloaded ?? 0;
  const totalBytes = live?.total_bytes ?? d.total_bytes ?? 0;
  const status = live?.status ?? d.status;
  return {
    id: d.id,
    url: d.source_url,
    filename: cleanFilename(d.filename) ??
      cleanFilename(live?.filename) ??
      d.filename ??
      live?.filename ??
      '',
    status,
    bytes_downloaded: bytesDownloaded,
    total_bytes: totalBytes,
    progress: live?.progress ?? (totalBytes ? bytesDownloaded / totalBytes * 100 : 0),
    speed: live?.speed ?? 0,
    connections: live?.connections ?? 0,
    gid: live?.gid ?? '',
    error_message: live?.error ?? (status === 'failed' ? d.error_message : '') ?? '',
  };
}

export function listToDict(lst: LinkListRow, includeDownloads = false): Record<string, unknown> {
  const rows = queries.getDownloadsForList.all(lst.id);
  const downloads = rows.map(downloadToDict);
  const totalBytes = downloads.reduce((sum, d) => sum + Number(d.total_bytes ?? 0), 0);
  const bytesDownloaded = downloads.reduce((sum, d) => sum + Number(d.bytes_downloaded ?? 0), 0);
  const completed = downloads.filter(d => d.status === 'completed').length;
  const data: Record<string, unknown> = {
    id: lst.id,
    name: lst.name,
    source_url: lst.source_url ?? '',
    image_url: lst.image_url ?? '',
    description: lst.description ?? '',
    size: lst.size ?? '',
    categories: (lst.categories ?? '').split('|').filter(Boolean),
    created_at: lst.created_at,
    count: rows.length,
    completed,
    dl_ids: rows.map(d => d.id),
    total_bytes: totalBytes,
    bytes_downloaded: bytesDownloaded,
  };
  if (includeDownloads) data.downloads = downloads;
  return data;
}

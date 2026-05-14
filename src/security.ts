import { lookup } from 'dns/promises';
import net from 'net';
import path from 'path';

const PRIVATE_RANGES = [
  /^0\./,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
];

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (!net.isIP(ip)) return true;
  const normalized = ip.toLowerCase();
  return PRIVATE_RANGES.some(range => range.test(normalized));
}

export async function isPublicHttpUrl(
  rawUrl: string,
  allowedHosts?: Set<string>,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL((rawUrl ?? '').trim());
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (allowedHosts && !allowedHosts.has(host)) return false;

  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && !addresses.some(address => isPrivateAddress(address.address));
  } catch {
    return false;
  }
}

export async function isPublicImageUrl(rawUrl: string): Promise<boolean> {
  return isPublicHttpUrl(rawUrl);
}

export async function cleanUrl(
  rawUrl: string,
  allowedHosts?: Set<string>,
  label = 'URL',
): Promise<string> {
  const url = (rawUrl ?? '').trim();
  if (!(await isPublicHttpUrl(url, allowedHosts))) {
    throw new HttpError(400, `Unsupported ${label}.`);
  }
  return url;
}

export function cleanDownloadPath(rawPath: string): string {
  const text = String(rawPath ?? '').trim().replace(/\x00/g, '');
  if (!text) throw new HttpError(400, 'download_path cannot be empty.');
  if (text.length > 500) throw new HttpError(400, 'download_path is too long.');
  return path.resolve(text.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? ''));
}

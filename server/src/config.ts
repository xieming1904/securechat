import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
// works from both src/ (tsx) and dist/src/ (compiled)
const serverRoot = here.includes(`${path.sep}dist${path.sep}`) ? path.resolve(here, '../..') : path.resolve(here, '..');

/** Version from the root package.json (shipped in the deploy package). */
export const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(serverRoot, '..', 'package.json'), 'utf8')).version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

function parseTrustProxy(v: string | undefined): boolean | string {
  if (v === undefined || v === '') return 'loopback';
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export interface AppConfig {
  dataDir: string;
  webDist: string;
  trustProxy: boolean | string;
  cookieSecure: boolean;
  ipv6Prefix: number;
  allowlistIdleDays: number;
  sessionDays: number;
  gateMaxFails: number;
  gateWindowMs: number;
  gateBlockMs: number;
  gatePermanentAfter: number;
  /** coturn: comma-separated turn:/turns:/stun: URLs, and the shared REST-auth secret */
  turnUrls: string[];
  turnSecret: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: process.env.DATA_DIR ?? path.resolve(serverRoot, 'data'),
    webDist: process.env.WEB_DIST ?? path.resolve(serverRoot, '../web/dist'),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    cookieSecure: process.env.COOKIE_SECURE !== '0',
    ipv6Prefix: Number(process.env.IPV6_PREFIX ?? 64),
    allowlistIdleDays: Number(process.env.ALLOWLIST_IDLE_DAYS ?? 90),
    sessionDays: 30,
    gateMaxFails: 5,
    gateWindowMs: 10 * 60_000,
    gateBlockMs: 60 * 60_000,
    gatePermanentAfter: 20,
    turnUrls: (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    turnSecret: process.env.TURN_SECRET ?? '',
    ...overrides,
  };
}

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST || '127.0.0.1'; // v0.7: private by default (Nginx in front)

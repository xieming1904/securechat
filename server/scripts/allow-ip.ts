/** Emergency access: npm run allow-ip -- <ip> [备注] */
import net from 'node:net';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createCtx } from '../src/context.js';
import { allowIp } from '../src/gate.js';
import { ipKey } from '../src/util.js';

const ip = process.argv[2];
if (!ip || !net.isIP(ip)) {
  console.error('用法: npm run allow-ip -- <ip> [备注]');
  process.exit(1);
}
const config = loadConfig();
const db = openDb(config.dataDir);
const key = ipKey(ip, config.ipv6Prefix);
allowIp(createCtx(db, config), key, 'cli', process.argv[3] ?? '命令行添加');
console.log(`✔ 已放行 ${key}`);
db.close();

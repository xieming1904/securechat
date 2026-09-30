/**
 * Consistent online snapshot of the SQLite database (safe while the server is running).
 *   node server/dist/scripts/backup-db.js <dest.db>
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';

const dest = process.argv[2];
if (!dest) {
  console.error('用法: backup-db <目标文件.db>');
  process.exit(1);
}
const src = path.join(loadConfig().dataDir, 'app.db');
const db = new Database(src, { readonly: true, fileMustExist: true });
await db.backup(dest);
db.close();
console.log(`✔ 数据库快照 → ${dest}`);

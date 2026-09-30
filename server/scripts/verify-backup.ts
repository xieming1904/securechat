/**
 * Restore drill: open a backup snapshot and check it is complete and usable.
 *   node server/dist/scripts/verify-backup.js <snapshot-dir>
 * The snapshot dir contains app.db and blobs/ exactly like the live data dir.
 * Exit code 0 = restorable, 1 = problem found.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: verify-backup <快照目录>');
  process.exit(1);
}
const problems: string[] = [];
const db = new Database(path.join(dir, 'app.db'), { readonly: true, fileMustExist: true });
const integrity = (db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check;
if (integrity !== 'ok') problems.push(`数据库完整性检查失败: ${integrity}`);
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const version = db.pragma('user_version', { simple: true });
const stats = { 结构版本: version, 用户: count('users'), 聊天: count('chats'), 消息: count('messages'), 附件: count('blobs') };
const blobIds = db.prepare('SELECT id, size FROM blobs').all() as { id: string; size: number }[];
let missing = 0;
for (const b of blobIds) {
  const f = path.join(dir, 'blobs', b.id);
  if (!fs.existsSync(f)) missing++;
}
if (missing) problems.push(`${missing} 个附件文件缺失`);
db.close();
console.log('备份内容:', JSON.stringify(stats));
if (problems.length) {
  console.error('✘ 备份有问题:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('✔ 备份完整，可以恢复');

/**
 * First-time setup / recovery:
 *   npm run init -- --password <访问密码> [--origin https://chat.example.com]
 * - sets (or changes) the site access password
 * - creates a one-time admin registration invite; opening the link also allow-lists your IP
 */
import { loadConfig } from '../src/config.js';
import { openDb, setSetting } from '../src/db.js';
import { createCtx } from '../src/context.js';
import { createInvite } from '../src/invites.js';
import { hashPassword, initSodium } from '../src/sodium.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

await initSodium();
const config = loadConfig();
const db = openDb(config.dataDir);
const ctx = createCtx(db, config);

const password = arg('password');
if (password) {
  if (password.length < 8) {
    console.error('访问密码至少 8 位');
    process.exit(1);
  }
  setSetting(db, 'gate_password_hash', hashPassword(password));
  console.log('✔ 访问密码已设置');
}

const hasAdmin = db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get();
if (!hasAdmin || process.argv.includes('--admin-invite')) {
  const origin = (arg('origin') ?? process.env.PUBLIC_ORIGIN ?? 'https://your-domain').replace(/\/$/, '');
  const inv = createInvite(ctx, { kind: 'register', maxUses: 1, expiresInHours: 24, grantsAdmin: true, note: '管理员初始化' });
  console.log('\n管理员注册链接（24 小时内有效，仅可使用一次；打开即自动放行你的 IP）：');
  console.log(`  ${origin}/i/${inv.token}`);
  console.log(`或在验证页输入邀请码：${inv.code}\n`);
} else {
  console.log('已存在管理员账号。如需额外的管理员邀请，请加 --admin-invite');
}
db.close();

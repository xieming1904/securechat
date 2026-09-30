import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';
const BASE = 'http://localhost:3100';
const adminLink = fs.readFileSync(new URL('./.tmp/init.txt', import.meta.url), 'utf8').match(/http:\/\/\S+\/i\/\S+/)[0];
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const mk = async (ip, w = 1200, h = 780) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip }, viewport: { width: w, height: h }, colorScheme: process.env.COLOR_SCHEME || 'light', locale: 'zh-CN', permissions: ['microphone'] });
  const p = await ctx.newPage();
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`[${ip} console]`, m.text()));
  p.on('pageerror', (e) => console.log(`[${ip} pageerror]`, e.message));
  return p;
};
const shot = (p, n) => p.screenshot({ path: `e2e/.tmp/shots/${n}.png` });
const step = (s) => console.log('▶', s);
const expect1 = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: expected ${want}, got ${got}`);
};

/** Fill the registration form, copy the 24 words, pass the word check. Returns the recovery phrase. */
async function registerVia(p, username, nick, pw, shotName) {
  await p.fill('input[placeholder^="用户名"]', username);
  await p.fill('input[placeholder^="昵称"]', nick);
  await p.fill('input[placeholder^="密码"]', pw);
  await p.fill('input[placeholder="确认密码"]', pw);
  if (shotName) await shot(p, shotName);
  await p.click('button:has-text("下一步")');
  await p.locator('ol.words li').first().waitFor();
  const words = await p.locator('ol.words li').evaluateAll((els) => els.map((e) => e.childNodes[1].textContent.trim()));
  if (words.length !== 24) throw new Error('expected 24 recovery words');
  if (shotName) await shot(p, shotName + '-words');
  await p.check('label.check input');
  await p.click('button:has-text("下一步")');
  for (const input of await p.locator('input[placeholder^="第 "]').all()) {
    const n = Number((await input.getAttribute('placeholder')).match(/\d+/)[0]);
    await input.fill(words[n - 1]);
  }
  await p.click('button:has-text("创建账号")');
  await p.getByText('还没有聊天').or(p.locator('.chat-item').first()).waitFor({ timeout: 30000 });
  return words.join(' ');
}


// 1. stranger sees only the gate
const X = await mk('10.9.9.9', 420, 700);
await X.goto(BASE + '/');
await X.getByText('访问验证').waitFor();
await shot(X, '01-gate');
await X.fill('#pw', 'wrong-password');
await X.click('#f button');
await X.getByText('密码或邀请码错误').waitFor();
step('gate rejects wrong password');

// 2. admin registers via the one-time link
const A = await mk('10.0.0.1');
await A.goto(adminLink);
await A.getByText('创建管理员账号').waitFor({ timeout: 15000 });
await registerVia(A, 'alice', '爱丽丝', 'alice-password-1', '02-register-admin');
step('admin registered');

// 3. admin creates a registration invite
await A.click('button[aria-label="菜单"]');
await A.click('text=管理后台');
await A.click('.tabs >> text=注册邀请');
await A.locator('label.field:has-text("可用次数") select').selectOption('5');
await A.fill('input[placeholder="备注（给谁的）"]', '给朋友们');
await A.click('button:has-text("生成邀请")');
const link = await A.locator('.copy-field input').first().inputValue();
await shot(A, '03-admin-invite');
step('invite: ' + link);

// 4. Bob opens the invite link from a new IP → gate passes → registers
const B = await mk('10.0.0.2');
await B.goto(link);
await B.getByRole('heading', { name: '注册' }).waitFor({ timeout: 15000 });
await registerVia(B, 'bob', '鲍勃', 'bob-password-12');
step('bob registered');

// 5. Alice starts an encrypted direct chat
await A.click('button[aria-label="返回"]');
await A.click('button[aria-label="菜单"]');
await A.click('text=新建私聊');
await A.fill('input[placeholder^="对方的用户名"]', 'bob');
await A.click('button:has-text("开始加密聊天")');
await A.locator('.chat-head .chat-title', { hasText: '鲍勃' }).waitFor();
await A.getByText('消息和附件在你的设备上加密').waitFor();
await A.fill('textarea', '你好 Bob，这条消息是端到端加密的 🔐');
await A.keyboard.press('Enter');
await A.fill('textarea', '第二条：https://example.com');
await A.keyboard.press('Enter');

await B.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))').waitFor({ timeout: 10000 });
await shot(B, '04-bob-list-unread');
await B.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))').click();
await B.locator('.messages .text', { hasText: '你好 Bob，这条消息是端到端加密的' }).first().waitFor();
await B.fill('textarea', '收到！');
await B.keyboard.press('Enter');
await A.locator('.messages .text', { hasText: '收到！' }).first().waitFor({ timeout: 10000 });
await A.locator('.ticks.read').first().waitFor({ timeout: 10000 });
step('messages exchanged, read receipts shown');

// reply
await A.locator('.bubble', { hasText: '收到！' }).click({ button: 'right' });
await A.click('.ctx-menu >> text=回复');
await A.fill('textarea', '好的 👍');
await A.keyboard.press('Enter');
await B.locator('.bubble .quote', { hasText: '收到！' }).waitFor();
await shot(A, '05-alice-chat');
await shot(B, '06-bob-chat');

// 6. Bob unilaterally deletes Alice's message for both sides
await B.locator('.bubble', { hasText: '第二条' }).click({ button: 'right' });
await B.click('.ctx-menu >> text=删除');
await B.getByText('同时为 爱丽丝 删除').waitFor();
await shot(B, '07-delete-dialog');
await B.click('.modal button:has-text("删除")');
await A.locator('.bubble', { hasText: '第二条' }).waitFor({ state: 'detached', timeout: 10000 });
step('bob deleted alice message for both');

// edit
await A.locator('.bubble', { hasText: '好的 👍' }).click({ button: 'right' });
await A.click('.ctx-menu >> text=编辑');
await A.fill('textarea', '好的 👍（已修改）');
await A.keyboard.press('Enter');
await B.locator('.messages .text', { hasText: '好的 👍（已修改）' }).first().waitFor({ timeout: 10000 });
await B.locator('.meta', { hasText: '已编辑' }).waitFor();
step('edit synced');

// ---- encrypted attachments ----
const photo = await A.screenshot({ clip: { x: 0, y: 0, width: 360, height: 240 } }); // a real PNG to send
await A.locator('input[type=file]').setInputFiles([
  { name: 'photo.png', mimeType: 'image/png', buffer: photo },
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('机密笔记：明天 9 点见') },
]);
await A.getByText('发送 2 个文件').waitFor();
await A.getByText('图片会重新编码以去除拍摄位置等元数据').waitFor();
await A.fill('.modal input[placeholder^="添加说明"]', '看看这两个文件');
await shot(A, '14-send-files');
await A.click('.modal button:has-text("发送")');
await B.locator('.messages .media img').first().waitFor({ timeout: 15000 });
await B.locator('.messages .file-card', { hasText: 'notes.txt' }).waitFor({ timeout: 15000 });
await B.locator('.messages .text', { hasText: '看看这两个文件' }).waitFor();
// full image decrypts in the lightbox
await B.locator('.messages .media').first().click();
await B.locator('.lightbox img').waitFor({ timeout: 10000 });
const natural = await B.locator('.lightbox img').evaluate((img) => img.naturalWidth);
if (natural < 100) throw new Error('lightbox image did not decode');
await shot(B, '15-lightbox');
await B.keyboard.press('Escape');
// file download decrypts to the original bytes
const [download] = await Promise.all([B.waitForEvent('download'), B.locator('.messages .file-card', { hasText: 'notes.txt' }).click()]);
const got = fs.readFileSync(await download.path(), 'utf8');
if (got !== '机密笔记：明天 9 点见') throw new Error('downloaded file differs: ' + got);
step('encrypted image + file sent, previewed and downloaded');

// voice message (fake microphone)
await A.click('button[aria-label="录制语音"]');
await A.getByText('正在录音').waitFor();
await A.waitForTimeout(1500);
await A.click('button[aria-label="发送语音"]');
await B.locator('.messages .voice-btn').last().waitFor({ timeout: 15000 });
await B.locator('.messages .voice-btn').last().click();
await B.locator('.messages audio').last().waitFor({ state: 'attached', timeout: 10000 });
step('voice message recorded, sent and played');

// ---- reactions, pins, markdown ----
await B.locator('.bubble', { hasText: '好的 👍（已修改）' }).click({ button: 'right' });
await B.click('.quick-reactions button:has-text("❤️")');
await A.locator('.bubble', { hasText: '好的 👍（已修改）' }).locator('.reaction', { hasText: '❤️' }).waitFor({ timeout: 10000 });
await A.locator('.bubble', { hasText: '你好 Bob，这条消息是端到端加密的' }).click({ button: 'right' });
await A.click('.ctx-menu >> text=置顶');
await B.locator('.pinned-bar', { hasText: '你好 Bob' }).waitFor({ timeout: 10000 });
await A.fill('textarea', '**重点** 和 ||剧透内容|| 还有 `code`');
await A.keyboard.press('Enter');
await B.locator('.messages .text b', { hasText: '重点' }).waitFor({ timeout: 10000 });
await B.locator('.messages .spoiler', { hasText: '剧透内容' }).waitFor();
await shot(B, '16-reactions-pins-markdown');
step('reactions, pins and markdown sync');

// forward the photo from Bob's chat into … (group created later) — forward to the same chat list target


// 7. group with invite link
await A.click('button[aria-label="菜单"]');
await A.click('text=新建群组');
await A.fill('input[placeholder^="群名称"]', '周末爬山');
await A.fill('input[placeholder^="添加成员"]', 'bob');
await A.click('.modal button:has-text("添加")');
await A.locator('.chip', { hasText: '鲍勃' }).waitFor();
await A.click('button:has-text("创建群组")');
await A.locator('.chat-head .chat-title', { hasText: '周末爬山' }).waitFor(); // wait until the new chat is open
await A.fill('textarea', '大家好，这是加密群聊');
await A.keyboard.press('Enter');
await B.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click();
try {
  await B.locator('.messages .text', { hasText: '大家好，这是加密群聊' }).first().waitFor({ timeout: 10000 });
} catch (e) {
  await shot(B, 'debug-bob-group');
  await shot(A, 'debug-alice-group');
  throw e;
}
step('group chat works');

// group invite link → Carol (new user) → join request → Alice's client signs her in automatically
await A.click('button[aria-label="聊天信息"]');
await A.click('.info-panel >> text=邀请链接');
await A.click('.modal button:has-text("生成新链接")');
const groupLink = await A.locator('.modal .copy-field input').first().inputValue();
await A.click('.modal button[aria-label="关闭"]');
await A.click('.info-panel button[aria-label="关闭"]');
const Cp = await mk('10.0.0.3');
await Cp.goto(link); // registration invite first (Carol is a new user)
await Cp.getByRole('heading', { name: '注册' }).waitFor({ timeout: 15000 });
const carolWords = await registerVia(Cp, 'carol', '卡罗尔', 'carol-password-1');
await Cp.goto(groupLink);
await Cp.click('button:has-text("申请加入")');
await Cp.getByText('已申请加入').waitFor();
await Cp.click('button:has-text("返回聊天列表")');
try {
  await Cp.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click({ timeout: 20000 });
} catch (e) {
  await shot(Cp, 'debug-carol');
  await shot(A, 'debug-alice');
  throw e;
}
await Cp.fill('textarea', '我是卡罗尔，刚加入');
await Cp.keyboard.press('Enter');
await A.locator('.messages .text', { hasText: '我是卡罗尔，刚加入' }).first().waitFor({ timeout: 10000 });
// Carol can't read what was said before she joined
if (await Cp.locator('.messages .text', { hasText: '大家好，这是加密群聊' }).count()) throw new Error('newcomer saw old message');
await A.click('button[aria-label="聊天信息"]');
await A.getByText('成员签名已验证').waitFor({ timeout: 15000 }).catch(async (e) => { await shot(A, 'fail-info'); throw e; });
await shot(A, '12-group-info');
await A.click('.info-panel button[aria-label="关闭"]');
step('group invite → admin-signed join works; newcomer sees only new messages');

// @mention: Bob is looking at another chat when Alice mentions him in the group
await B.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))').click();
await A.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click();
await A.locator('textarea').pressSequentially('@鲍');
await A.locator('.mention-list button', { hasText: '鲍勃' }).waitFor();
await A.keyboard.press('Enter'); // pick the suggestion
await A.locator('textarea').pressSequentially('周六几点出发？');
await A.keyboard.press('Enter');
await B.locator('.chat-item:has(.chat-title:text-is("周末爬山")) .mention-badge').waitFor({ timeout: 10000 });
await B.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click();
await B.locator('.bubble.mentions-me .mention', { hasText: '@鲍勃' }).waitFor();
step('@mention highlights and badges');

// forward Alice's photo from the direct chat into the group
await B.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))').click();
await B.locator('.messages .media').first().click({ button: 'right' });
await B.click('.ctx-menu >> text=转发');
await B.locator('.modal .chat-item', { hasText: '周末爬山' }).click();
await A.locator('.messages .fwd', { hasText: '转发自 爱丽丝' }).waitFor({ timeout: 15000 });
await A.locator('.messages .media img').last().waitFor({ timeout: 15000 });
step('forwarded encrypted photo re-uploaded into the group');

// Carol forgets her password → recovers with the 24 words on a new device
const Cr = await mk('10.0.0.3');
await Cr.goto(BASE + '/');
await Cr.click('text=忘记密码？用恢复词找回');
await Cr.fill('input[placeholder="用户名"]', 'carol');
await Cr.fill('textarea', carolWords);
await shot(Cr, '13-recover');
await Cr.click('button:has-text("验证恢复词")');
await Cr.fill('input[placeholder^="新密码"]', 'carol-new-password');
await Cr.fill('input[placeholder="确认新密码"]', 'carol-new-password');
await Cr.click('button:has-text("保存并登录")');
await Cr.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click({ timeout: 20000 });
await Cr.locator('.messages .text', { hasText: '我是卡罗尔，刚加入' }).first().waitFor({ timeout: 10000 });
// the old device was signed out
await Cp.reload();
await Cp.getByRole('heading', { name: '登录' }).waitFor({ timeout: 10000 });
step('recovery words restore the account; old sessions revoked');

// info panel + safety number
await A.locator('.chat-item:has(.chat-title:text-is("鲍勃"))').click();
await A.click('button[aria-label="聊天信息"]');
await A.click('text=查看安全码');
await A.locator('pre.safety').waitFor();
const safeA = (await A.locator('pre.safety').innerText()).replace(/\s/g, '');
await shot(A, '08-safety-number');
await A.click('.modal button[aria-label="关闭"]');
await B.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))').click();
await B.click('button[aria-label="聊天信息"]');
await B.click('text=查看安全码');
await B.locator('pre.safety').waitFor();
const safeB = (await B.locator('pre.safety').innerText()).replace(/\s/g, '');
if (safeA !== safeB || safeA.length !== 60) throw new Error('safety numbers differ');
step('safety numbers match');
await B.click('.modal button[aria-label="关闭"]');

// 8. reload: identity restored from IndexedDB, messages decrypt again
await A.reload();
await A.locator('.chat-item:has(.chat-title:text-is("鲍勃"))').click();
await A.locator('.messages .text', { hasText: '你好 Bob，这条消息是端到端加密的' }).first().waitFor({ timeout: 10000 });
step('reload keeps keys');

// ---- local encrypted search ----
await A.fill('.search input', '端到端');
await A.locator('.chat-item.hit mark', { hasText: '端到端' }).first().waitFor({ timeout: 10000 });
await shot(A, '17-search');
await A.locator('.chat-item.hit').first().click();
await A.locator('.msg-row.flash').waitFor({ timeout: 10000 });
await A.fill('.search input', '');
// the index lives encrypted in IndexedDB: no plaintext in the stored records
const leaked = await A.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('securechat', 1); r.onsuccess = () => res(r.result); });
  const all = await new Promise((res) => { const t = db.transaction('kv').objectStore('kv').getAll(); t.onsuccess = () => res(t.result); });
  const enc = new TextDecoder();
  return all.some((v) => v && v.ct && enc.decode(new Uint8Array(v.ct)).includes('端到端'));
});
if (leaked) throw new Error('plaintext found in IndexedDB');
step('local search finds messages; the index is encrypted at rest');

// deleting a message removes it from the search index too
await A.fill('.search input', '剧透内容');
await A.locator('.chat-item.hit').first().waitFor({ timeout: 10000 });
await A.fill('.search input', '');
await A.locator('.chat-item:has(.chat-title:text-is("鲍勃"))').click();
await A.locator('.bubble', { hasText: '重点' }).click({ button: 'right' });
await A.click('.ctx-menu >> text=删除');
await A.click('.modal button:has-text("删除")');
await A.locator('.bubble', { hasText: '重点' }).waitFor({ state: 'detached' });
await A.fill('.search input', '剧透内容');
await A.getByText('没有找到。只能搜索本机已缓存的消息。').waitFor({ timeout: 10000 });
await A.fill('.search input', '');
step('deleted messages disappear from the local index');

// ---- offline read-only mode (service worker + encrypted cache) ----
await A.reload(); // make sure the service worker controls the page and has cached the shell
await A.locator('.chat-item').first().waitFor();
await A.waitForTimeout(1500);
await A.context().setOffline(true);
await A.reload();
await A.getByText('离线模式：显示本机加密缓存，文字消息联网后自动发出').waitFor({ timeout: 15000 });
await A.locator('.chat-item:has(.chat-title:text-is("鲍勃"))').click();
await A.locator('.messages .text', { hasText: '你好 Bob，这条消息是端到端加密的' }).waitFor({ timeout: 10000 });
await shot(A, '18-offline');
await A.fill('.composer textarea', '离线时写的消息');
await A.keyboard.press('Enter');
await A.locator('.msg-row.mine .ticks.queued').first().waitFor({ timeout: 10000 });
await A.context().setOffline(false);
await A.getByText('离线模式：显示本机加密缓存，文字消息联网后自动发出').waitFor({ state: 'detached', timeout: 20000 });
await A.locator('.chat-item').first().waitFor({ timeout: 15000 });
step('offline read-only mode from the encrypted cache, back online automatically');

// ---- regenerate recovery words ----
await B.click('button[aria-label="菜单"]');
await B.click('text=设置');
await B.click('.modal .tabs >> text=安全');
await B.click('button:has-text("重新生成恢复词")');
await B.fill('input[placeholder="输入当前密码以确认"]', 'bob-password-12');
await B.click('.modal button:has-text("下一步")');
await B.locator('.modal ol.words li').first().waitFor();
await B.check('.modal label.check:has-text("我已经抄写好了") input');
await B.click('button:has-text("确认启用新恢复词")');
await B.getByText('新的恢复词已生效').waitFor({ timeout: 15000 });
await B.click('.modal .tabs >> text=通知与存储');
await B.getByText('推送通知').waitFor();
await shot(B, '19-settings-notify');
await B.click('.modal button[aria-label="关闭"]');
step('recovery words regenerated; notification settings shown');

// 9. new device for Bob (same IP) → login → keys restored from encrypted backup
const B2 = await mk('10.0.0.2');
await B2.goto(BASE + '/');
await B2.getByRole('heading', { name: '登录' }).waitFor();
await B2.fill('input[placeholder="用户名"]', 'bob');
await B2.fill('input[placeholder="密码"]', 'bob-password-12');
await B2.click('button:has-text("登录")');
await B2.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))').click();
await B2.locator('.messages .text', { hasText: '你好 Bob，这条消息是端到端加密的' }).first().waitFor({ timeout: 15000 });
step('second device decrypts history');

// 10. mobile layout
const M = await mk('10.0.0.1', 390, 780);
await M.goto(BASE + '/');
await M.getByRole('heading', { name: '登录' }).waitFor();
await M.fill('input[placeholder="用户名"]', 'alice');
await M.fill('input[placeholder="密码"]', 'alice-password-1');
await M.click('button:has-text("登录")');
await M.locator('.chat-item').first().waitFor();
await shot(M, '09-mobile-list');
await M.locator('.chat-item:has(.chat-title:text-is("鲍勃"))').click();
await M.locator('.messages .text', { hasText: '收到！' }).first().waitFor();
await shot(M, '10-mobile-chat');

// ================================================================ v0.3.0 features
const openChatWith = async (p, title) => {
  await p.locator(`.chat-item:not(.secret-item):has(.chat-title:text-is("${title}"))`).click();
  await p.locator('.chat-head .chat-title', { hasText: title }).waitFor();
};
// dismiss "new login" banners (from the extra devices opened above) so they don't cover the chat
for (const p of [A, B]) {
  while (await p.locator('.login-alert .btn.secondary').count()) await p.locator('.login-alert .btn.secondary').first().click();
}
await openChatWith(A, '鲍勃');
await openChatWith(B, '爱丽丝');
await B.locator('.messages .text', { hasText: '离线时写的消息' }).waitFor({ timeout: 30000 });
step('offline outbox delivered after reconnect');

// ---- encrypted poll ----
await A.click('button[aria-label="发起投票"]');
await A.fill('.modal input[placeholder^="例如"]', '周六去哪爬山？');
await A.fill('.modal input[placeholder="选项 1"]', '香山');
await A.fill('.modal input[placeholder="选项 2"]', '百望山');
await A.fill('.modal input[placeholder="选项 3"]', '凤凰岭');
await shot(A, '20-create-poll');
await A.click('.modal button:has-text("发送投票")');
await B.locator('.poll-q', { hasText: '周六去哪爬山？' }).waitFor({ timeout: 15000 });
await B.locator('.poll-opt', { hasText: '凤凰岭' }).last().click();
await A.locator('.poll', { hasText: '周六去哪爬山？' }).last().getByText('1 人已投').waitFor({ timeout: 15000 });
await A.locator('.poll').last().locator('.poll-opt', { hasText: '香山' }).click();
await B.locator('.poll').last().getByText('2 人已投').waitFor({ timeout: 15000 });
await shot(B, '21-poll');
A.once('dialog', (d) => d.accept());
await A.locator('.poll').last().locator('button:has-text("结束投票")').click();
await B.locator('.poll').last().getByText('投票已结束').waitFor({ timeout: 15000 });
if (!(await B.locator('.poll').last().locator('.poll-opt').first().isDisabled())) throw new Error('closed poll still votable');
step('encrypted poll: votes sync, creator closes it');

// ---- encrypted draft sync between Bob's devices ----
await B2.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click();
await B.fill('.composer textarea', '这是一条还没写完的草稿');
await B2.locator('.chat-item:has(.chat-title:text-is("爱丽丝")) .draft-label').waitFor({ timeout: 15000 });
await B2.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))', { hasText: '这是一条还没写完的草稿' }).waitFor();
await shot(B2, '22-draft-synced');
await B.fill('.composer textarea', '');
await B2.locator('.chat-item:has(.chat-title:text-is("爱丽丝")) .draft-label').waitFor({ state: 'detached', timeout: 15000 });
step('drafts sync (encrypted) across devices');

// ---- scheduled message ----
await A.fill('.composer textarea', '这是一条定时消息');
await A.click('button[aria-label="定时发送"]');
await A.locator('.modal .sched-presets button').first().click();
await A.locator('.sched-bar', { hasText: '1 条定时消息待发送' }).waitFor({ timeout: 10000 });
if (await B.locator('.messages .text', { hasText: '这是一条定时消息' }).count()) throw new Error('scheduled message arrived early');
await A.click('.sched-bar');
await A.locator('.modal .sched-item', { hasText: '这是一条定时消息' }).waitFor();
await shot(A, '23-scheduled-list');
await A.click('.modal .sched-item button:has-text("立即发送")');
await B.locator('.messages .text', { hasText: '这是一条定时消息' }).waitFor({ timeout: 15000 });
await A.click('.modal button[aria-label="关闭"]');
await A.locator('.sched-bar').waitFor({ state: 'detached', timeout: 10000 });
step('scheduled message stored encrypted, sent on demand');

// ---- merged forward ("chat history") ----
await A.locator('.bubble', { hasText: '这是一条定时消息' }).last().click({ button: 'right' });
await A.click('.ctx-menu >> text=选择');
await A.locator('.msg-row', { hasText: '离线时写的消息' }).last().click();
await A.click('.select-bar button:has-text("转发")');
if (!(await A.locator('.modal label.check:has-text("合并为一条") input').isChecked())) throw new Error('merge should default on');
await A.click('.modal .forward-list .chat-item:has(.chat-title:text-is("周末爬山"))');
await B.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click();
await B.locator('.bundle-card').last().waitFor({ timeout: 15000 });
await B.locator('.bundle-card').last().click();
await B.locator('.modal .bundle-item', { hasText: '离线时写的消息' }).waitFor();
await B.locator('.modal .bundle-item', { hasText: '这是一条定时消息' }).waitFor();
await shot(B, '24-bundle');
await B.click('.modal button[aria-label="关闭"]');
step('merged forward as one encrypted chat-history message');

// ---- signed group settings ----
const openInfo = async (p) => {
  if (!(await p.locator('.info-panel').isVisible())) await p.click('button[aria-label="聊天信息"]');
  await p.locator('.info-panel').waitFor();
};
await openInfo(B);
try {
  await B.getByText('设置已签名').waitFor({ timeout: 10000 });
} catch (e) {
  await shot(B, 'debug-settings');
  console.log(await B.locator('.info-panel').innerText());
  throw e;
}
await B.click('.info-panel button[aria-label="关闭"]');
await A.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').click();
await openInfo(A);
await A.getByText('设置已签名').waitFor({ timeout: 10000 });
await A.click('.info-panel button[aria-label="关闭"]');
step('group settings are signed by the admin and verified');

// ---- 1:1 voice call (WebRTC, fake media devices) ----
await openChatWith(A, '鲍勃');
await openChatWith(B, '爱丽丝');
await A.click('button[aria-label="语音通话"]');
await B.locator('.call-overlay').getByText('邀请你语音通话…').waitFor({ timeout: 15000 });
await shot(B, '25-incoming-call');
await B.click('.call-overlay button[aria-label="接听"]');
await A.locator('.call-overlay .call-status', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
await B.locator('.call-overlay .call-status', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
await A.waitForTimeout(2500);
await shot(A, '26-call-active');
await A.click('.call-overlay button[aria-label="挂断"]');
await B.locator('.call-overlay').waitFor({ state: 'detached', timeout: 15000 });
await B.locator('.call-log', { hasText: '通话时长' }).last().waitFor({ timeout: 15000 });
step('end-to-end encrypted voice call connects; call log posted');

// ---- large file: chunked streaming upload + ranged download ----
const bigPath = new URL('./.tmp/big.bin', import.meta.url).pathname;
{
  const fd = fs.openSync(bigPath, 'w');
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 96; i++) {
    block.fill(i);
    fs.writeSync(fd, block);
  }
  fs.closeSync(fd);
}
await A.locator('input[type=file]').setInputFiles(bigPath);
await A.getByText('发送 1 个文件').waitFor();
await A.click('.modal button:has-text("发送")');
await B.locator('.messages .file-card', { hasText: 'big.bin' }).last().waitFor({ timeout: 120000 });
await B.locator('.messages .file-card', { hasText: 'big.bin' }).last().getByText('96.0 MB').waitFor({ timeout: 120000 });
// wait until the upload finished (the card stops showing a percentage)
await A.locator('.msg-row.mine .ticks .lucide-check, .msg-row.mine .ticks .lucide-check-check').last().waitFor({ timeout: 180000 });
console.log('  showSaveFilePicker in test browser:', await B.evaluate(() => typeof window.showSaveFilePicker));
await B.evaluate(() => { window.showSaveFilePicker = undefined; }); // headless has no real save dialog: test the Blob fallback
const [bigDl] = await Promise.all([B.waitForEvent('download', { timeout: 180000 }), B.locator('.messages .file-card', { hasText: 'big.bin' }).last().click()]);
const bigOut = await bigDl.path();
const bigGot = fs.readFileSync(bigOut);
if (bigGot.length !== 96 * 1024 * 1024 || bigGot[0] !== 0 || bigGot[bigGot.length - 1] !== 95) throw new Error('large file mismatch');
step('96 MB file: streamed encryption, chunked upload, ranged download + decrypt');

// ---- v0.5: a large upload continues after a page reload (nothing re-uploaded) ----
{
  const offs = [];
  const slow = async (r) => {
    offs.push(Number(new URL(r.request().url()).searchParams.get('offset')));
    await new Promise((res) => setTimeout(res, 600));
    await r.continue().catch(() => undefined);
  };
  await A.route('**/api/uploads/*?offset=*', slow);
  await A.locator('input[type=file]').first().setInputFiles(bigPath);
  await A.getByText('发送 1 个文件').waitFor();
  await A.click('.modal button:has-text("发送")');
  while (offs.length < 4) await new Promise((r) => setTimeout(r, 100)); // 3 parts accepted, the 4th in flight
  await A.unroute('**/api/uploads/*?offset=*', slow);
  await A.reload();
  await A.getByText('个大文件上传被中断').first().waitFor({ timeout: 20000 });
  await openChatWith(A, '鲍勃');
  await A.locator('.resume-bar').waitFor();
  await shot(A, '44-upload-resume');
  const after = [];
  const note = (req) => req.url().includes('/api/uploads/') && req.method() === 'PUT' && after.push(Number(new URL(req.url()).searchParams.get('offset')));
  A.on('request', note);
  const [chooser] = await Promise.all([A.waitForEvent('filechooser'), A.click('.resume-bar button:has-text("选择同一文件继续")')]);
  await chooser.setFiles(bigPath);
  await A.locator('.resume-bar').waitFor({ state: 'detached', timeout: 10000 });
  await B.locator('.messages .file-card', { hasText: 'big.bin' }).nth(1).waitFor({ timeout: 180000 });
  await A.locator('.msg-row.mine .ticks .lucide-check, .msg-row.mine .ticks .lucide-check-check').last().waitFor({ timeout: 180000 });
  A.off('request', note);
  if (!(after[0] > 0)) throw new Error('resume restarted from 0: ' + after.slice(0, 3));
  console.log(`  resumed at ${(after[0] / 1048576).toFixed(0)} MB`);
  const [dl2] = await Promise.all([B.waitForEvent('download', { timeout: 180000 }), B.locator('.messages .file-card', { hasText: 'big.bin' }).last().click()]);
  const got2 = fs.readFileSync(await dl2.path());
  if (got2.length !== 96 * 1024 * 1024 || got2[0] !== 0 || got2[50 * 1048576] !== 50 || got2[got2.length - 1] !== 95) throw new Error('resumed file mismatch');
}
step('large upload resumed after a page reload; the file decrypts intact');

// ================================================================ v0.4 features
const hotp = (secretB32, counter) => {
  const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const bytes = [];
  for (const ch of secretB32.replace(/=+$/, '')) { val = (val << 5) | A32.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
};
const step30 = () => Math.floor(Date.now() / 30000);
const closeInfo = async (p) => { if (await p.locator('.info-panel').isVisible()) await p.click('.info-panel button[aria-label="关闭"]'); };

// ---- contact nickname (end-to-end encrypted, synced to my other devices) ----
await openChatWith(A, '鲍勃');
await openInfo(A);
await A.click('.info-panel >> text=添加备注名和备注');
await A.fill('.info-panel input[placeholder="只有你自己能看到"]', '老鲍');
await A.fill('.info-panel textarea', '大学同学');
await A.click('.info-panel button:has-text("保存")');
await A.locator('.sidebar .chat-item .chat-title', { hasText: '老鲍' }).waitFor({ timeout: 10000 }).catch(async (e) => { await shot(A, 'fail-alias'); throw e; });
await M.locator('.chat-title:visible', { hasText: '老鲍' }).first().waitFor({ timeout: 15000 }); // synced to Alice's phone
await shot(A, '31-contact-alias');
await A.click('.info-panel .info-row:has-text("老鲍")');
await A.fill('.info-panel input[placeholder="只有你自己能看到"]', '');
await A.fill('.info-panel textarea', '');
await A.click('.info-panel button:has-text("保存")');
await A.locator('.sidebar .chat-item .chat-title', { hasText: '鲍勃' }).first().waitFor({ timeout: 10000 });
await closeInfo(A);
step('contact nickname + note (encrypted vault, synced)');

// ---- block ----
await openChatWith(B, '爱丽丝');
await openInfo(B);
B.once('dialog', (d) => d.accept());
await B.click('.info-panel >> text=屏蔽此人');
await B.locator('.blocked-bar').waitFor({ timeout: 10000 });
await closeInfo(B);
await A.fill('.composer textarea', '你能收到吗？');
await A.keyboard.press('Enter');
await A.getByText('消息无法送达：对方已拒收你的消息').waitFor({ timeout: 10000 });
await shot(B, '32-blocked');
await B.click('.blocked-bar button:has-text("取消屏蔽")');
await B.locator('.blocked-bar').waitFor({ state: 'detached', timeout: 10000 });
step('block / unblock enforced by the server');

// ---- saved messages ----
await A.locator('.bubble', { hasText: '这是一条定时消息' }).last().click({ button: 'right' });
await A.click('.ctx-menu >> text=收藏');
await A.getByText('已收藏').first().waitFor({ timeout: 10000 });
await A.click('button[aria-label="菜单"]');
await A.click('.dropdown >> text=收藏夹');
await A.locator('.modal .saved-item', { hasText: '这是一条定时消息' }).waitFor({ timeout: 10000 });
await shot(A, '33-saved');
await A.click('.modal button[aria-label="关闭"]');
step('saved messages (encrypted, personal)');

// ---- stickers ----
await A.locator('input[type=file]').first().setInputFiles([{ name: 'cat.png', mimeType: 'image/png', buffer: photo }]);
await A.getByText('发送 1 个文件').waitFor();
await A.click('.modal button:has-text("发送")');
await A.locator('.msg-row.mine:has(.media img)').last().waitFor({ timeout: 20000 });
await A.locator('.msg-row.mine:has(.media img)').last().click({ button: 'right' });
await A.click('.ctx-menu >> text=添加到贴纸');
await A.getByText('已添加到贴纸').first().waitFor({ timeout: 20000 });
await A.click('button[aria-label="贴纸"]');
await A.locator('.sticker-picker .sticker-cell:not(.add) img').first().waitFor({ timeout: 15000 });
await shot(A, '34-sticker-picker');
await A.locator('.sticker-picker .sticker-cell:not(.add)').first().click();
await B.locator('.sticker-msg img').last().waitFor({ timeout: 20000 });
step('personal sticker pack; sticker sent and shown');

// ---- two-step verification (Carol) ----
await Cr.click('button[aria-label="菜单"]');
await Cr.click('.dropdown >> text=设置');
await Cr.click('.modal .tabs >> text=安全');
await Cr.click('.modal button:has-text("设置验证器 App")');
const secret = await Cr.locator('.modal .copy-field input').first().inputValue();
await Cr.fill('.modal input.pin-input', hotp(secret, step30()));
await Cr.click('.modal button:has-text("确认开启")');
await Cr.locator('.modal .recovery-codes code').first().waitFor({ timeout: 10000 });
await shot(Cr, '35-2fa-codes');
await Cr.click('.modal button:has-text("我已保存好")');
await Cr.click('.modal button[aria-label="关闭"]');
const C2 = await mk('10.0.0.3');
await C2.goto(BASE + '/');
await C2.fill('input[placeholder="用户名"]', 'carol');
await C2.fill('input[placeholder="密码"]', 'carol-new-password');
await C2.click('button:has-text("登录")');
await C2.locator('.modal input.pin-input').waitFor({ timeout: 15000 });
await shot(C2, '36-2fa-prompt');
await C2.fill('.modal input.pin-input', '000000');
await C2.click('.modal button:has-text("验证")');
await C2.getByText('验证码不正确，请重试').waitFor({ timeout: 10000 });
await C2.fill('.modal input.pin-input', hotp(secret, step30() + 1)); // the enabling code can't be replayed
await C2.click('.modal button:has-text("验证")');
await C2.locator('.chat-item:has(.chat-title:text-is("周末爬山"))').waitFor({ timeout: 20000 });
step('two-step verification: enable, wrong code rejected, login with code');

// ---- v0.5 passkey as the second factor (Bob), with a virtual authenticator ----
const virtualAuth = async (p) => {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
};
const vaB = await virtualAuth(B);
await B.click('button[aria-label="菜单"]');
await B.click('.dropdown >> text=设置');
await B.click('.modal .tabs >> text=安全');
await B.fill('.modal input[aria-label="通行密钥名称"]', '我的电脑');
await B.click('.modal button:has-text("添加通行密钥")');
// the first method needs the password again when the session isn't fresh
await Promise.race([B.locator('.modal .recovery-codes code').first().waitFor({ timeout: 15000 }), B.locator('.modal input[placeholder="登录密码"]').waitFor({ timeout: 15000 })]);
if (await B.locator('.modal input[placeholder="登录密码"]').count()) {
  await B.fill('.modal input[placeholder="登录密码"]', 'bob-password-12');
  await B.click('.modal button:has-text("确认")');
  await B.getByText('密码已确认').first().waitFor({ timeout: 15000 });
  await B.click('.modal button:has-text("添加通行密钥")');
}
await B.locator('.modal .recovery-codes code').first().waitFor({ timeout: 15000 });
await B.click('.modal button:has-text("我已保存好")');
await B.locator('.modal .pk-row', { hasText: '我的电脑' }).waitFor({ timeout: 10000 });
await shot(B, '45-passkey-settings');
await B.click('.modal button[aria-label="关闭"]');
// log in on a new device that has the same passkey (like a synced passkey / a phone nearby)
const { credentials } = await vaB.cdp.send('WebAuthn.getCredentials', { authenticatorId: vaB.authenticatorId });
const B3 = await mk('10.0.0.2');
const vaB3 = await virtualAuth(B3);
for (const c of credentials) await vaB3.cdp.send('WebAuthn.addCredential', { authenticatorId: vaB3.authenticatorId, credential: c });
await B3.goto(BASE + '/');
await B3.fill('input[placeholder="用户名"]', 'bob');
await B3.fill('input[placeholder="密码"]', 'bob-password-12');
await B3.click('button:has-text("登录")');
await B3.locator('.modal button:has-text("使用通行密钥")').waitFor({ timeout: 15000 });
await shot(B3, '46-passkey-prompt');
await B3.click('.modal button:has-text("使用通行密钥")');
await B3.locator('.chat-item:has(.chat-title:text-is("爱丽丝"))').waitFor({ timeout: 20000 });
step('passkey: added in settings, second step of a new login');

// ---- v0.5 group voice call: 3 people, mesh, all connected ----
await openChatWith(A, '周末爬山');
await A.click('.chat-head button[aria-label="群语音通话"]');
await A.locator('.call-overlay.gc').waitFor({ timeout: 15000 });
const dbg = async (e) => {
  for (const [n, p] of [['A', A], ['B', B], ['C2', C2]]) await shot(p, 'fail-' + n);
  throw e;
};
for (const p of [A, B, C2]) while (await p.locator('.login-alert .btn.secondary').count()) await p.locator('.login-alert .btn.secondary').first().click();
await openChatWith(B, '周末爬山');
await B.locator('.gcall-bar button:has-text("加入")').click({ timeout: 15000 }).catch(dbg);
await openChatWith(C2, '周末爬山');
await C2.locator('.gcall-bar button:has-text("加入")').click({ timeout: 15000 }).catch(dbg);
for (const p of [A, B, C2])
  await p.waitForFunction(() => document.querySelectorAll('.gc-tile').length === 3 && !document.querySelector('.gc-state'), null, { timeout: 30000 });
const liveAudio = await A.evaluate(() => [...document.querySelectorAll('.call-overlay.gc audio')].filter((a) => a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live')).length);
if (liveAudio !== 2) throw new Error('group call: expected 2 remote audio streams, got ' + liveAudio);
await A.waitForTimeout(1500);
if (await A.locator('.call-overlay.gc video:not(.waiting)').count()) throw new Error('voice call shows empty video tiles');
await shot(A, '47-group-call');
// v0.7 screen share in a voice call: a canvas stands in for the screen picker
await A.evaluate(() => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    const g = c.getContext('2d');
    let n = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${n++ % 360} 70% 50%)`;
      g.fillRect(0, 0, 640, 360);
    }, 100);
    return c.captureStream(10);
  };
});
await A.click('.call-overlay.gc button[aria-label="共享屏幕"]');
await A.getByText('我（共享屏幕）').waitFor({ timeout: 10000 }).catch(dbg);
for (const p of [B, C2])
  await p
    .waitForFunction(() => [...document.querySelectorAll('.call-overlay.gc video')].some((v) => v.videoWidth > 0), null, { timeout: 20000 })
    .catch(dbg);
await B.waitForTimeout(800);
await shot(B, '54-group-screen-share');
await A.click('.call-overlay.gc button[aria-label="停止共享屏幕"]');
await B.waitForFunction(() => !document.querySelector('.call-overlay.gc video:not(.waiting)'), null, { timeout: 15000 }).catch(dbg);
await B.click('.call-overlay.gc button[aria-label="离开通话"]');
await A.waitForFunction(() => document.querySelectorAll('.gc-tile').length === 2, null, { timeout: 15000 });
await B.locator('.gcall-bar').waitFor({ timeout: 10000 }); // Bob can rejoin from the bar
await A.click('.call-overlay.gc button[aria-label="离开通话"]');
await C2.click('.call-overlay.gc button[aria-label="离开通话"]');
await B.locator('.gcall-bar').waitFor({ state: 'detached', timeout: 10000 });
await A.locator('.messages .call-log', { hasText: '群语音通话' }).filter({ hasText: '3 人' }).first().waitFor({ timeout: 15000 });
step('group voice call: 3-way mesh connects, screen share, leave / end propagate, call log posted');

// ---- group announcement + mute ----
await openChatWith(A, '周末爬山');
await openChatWith(B, '周末爬山');
await openInfo(A);
await A.click('.info-panel button:has-text("发布公告")');
await A.fill('.info-panel textarea', '周六早上 7 点地铁站集合，记得带水');
await A.click('.info-panel button:has-text("发布")');
await B.locator('.announce-bar', { hasText: '周六早上 7 点地铁站集合' }).waitFor({ timeout: 15000 });
await A.locator('.member', { hasText: '鲍勃' }).locator('select.mute-select').selectOption('3600000');
await B.getByText('你已被管理员禁言').waitFor({ timeout: 15000 });
if (await B.locator('.composer textarea').count()) throw new Error('muted member still has a composer');
await shot(B, '37-announce-muted');
await A.locator('.member', { hasText: '鲍勃' }).locator('select.mute-select').selectOption('0');
await B.locator('.composer textarea').waitFor({ timeout: 15000 });
await closeInfo(A);
step('signed group announcement; mute enforced');

// ---- export ----
await openChatWith(A, '鲍勃');
await openInfo(A);
await A.click('.info-panel >> text=导出聊天记录');
await A.click('.modal button.choice:has-text("网页")');
const [htmlDl] = await Promise.all([A.waitForEvent('download', { timeout: 60000 }), A.click('.modal button:has-text("导出")')]);
const html = fs.readFileSync(await htmlDl.path(), 'utf8');
if (!html.includes('你好 Bob，这条消息是端到端加密的') || !html.includes('Content-Security-Policy')) throw new Error('html export incomplete');
await A.click('.modal button.choice:has-text("加密存档")');
await A.fill('.modal input[placeholder^="存档密码"]', 'archive-pass-123');
await A.fill('.modal input[placeholder="再输一次"]', 'archive-pass-123');
const [arcDl] = await Promise.all([A.waitForEvent('download', { timeout: 120000 }), A.click('.modal button:has-text("导出")')]);
const arcPath = new URL('./.tmp/export.scarchive', import.meta.url).pathname;
await arcDl.saveAs(arcPath);
if (fs.readFileSync(arcPath).includes(Buffer.from('你好 Bob'))) throw new Error('archive not encrypted');
await A.click('.modal button[aria-label="关闭"]');
await closeInfo(A);
await B.click('button[aria-label="菜单"]');
await B.click('.dropdown >> text=设置');
await B.click('.modal .tabs >> text=通知与存储');
await B.locator('.modal input[type=file][accept=".scarchive"]').setInputFiles(arcPath);
await B.fill('.modal input[placeholder="存档密码"]', 'archive-pass-123');
await B.click('.modal button:has-text("打开")');
await B.locator('.modal .bundle-item', { hasText: '你好 Bob，这条消息是端到端加密的' }).first().waitFor({ timeout: 30000 });
await shot(B, '38-archive-open');
await B.keyboard.press('Escape');
await B.keyboard.press('Escape');
step('export: readable HTML (with CSP) and passphrase-encrypted archive, reopened on another account');

// ---- v0.5 chat list: pin, mute, archive, mark unread, folders (encrypted, synced) ----
const itemA = (t) => A.locator(`.sidebar .chat-item:has(.chat-title:text-is("${t}"))`);
const menuA = async (t, action) => {
  await itemA(t).click({ button: 'right' });
  await A.locator(`.ctx-menu button:text-is("${action}")`).click();
};
await menuA('周末爬山', '置顶');
await A.locator('.sidebar .chat-list .chat-item').first().locator('.chat-title', { hasText: '周末爬山' }).waitFor({ timeout: 10000 });
if (await M.locator('button[aria-label="返回"]').isVisible()) await M.click('button[aria-label="返回"]');
await M.locator('.chat-list .chat-item').first().locator('.chat-title', { hasText: '周末爬山' }).waitFor({ timeout: 15000 }); // synced to the phone
await menuA('周末爬山', '免打扰…');
await A.locator('.ctx-menu button:text-is("1 小时")').click();
await itemA('周末爬山').locator('.title-ic').waitFor({ timeout: 10000 });
await M.locator('.chat-item:has(.chat-title:text-is("周末爬山")) .title-ic').waitFor({ timeout: 15000 });
await menuA('鲍勃', '标记为未读');
await itemA('鲍勃').locator('.unread-dot').waitFor();
await A.click('.chat-tabs button:text-is("未读")');
await itemA('鲍勃').waitFor();
await shot(A, '41-chatlist-unread-tab');
await A.locator('.chat-tabs button', { hasText: '未读' }).click({ button: 'right' });
await A.click('.ctx-menu button:text-is("全部标为已读")');
await itemA('鲍勃').waitFor({ state: 'detached', timeout: 10000 });
await A.click('.chat-tabs button:text-is("全部")');
// archive: a new message from Bob brings the (not muted) chat back
await menuA('鲍勃', '归档');
await itemA('鲍勃').waitFor({ state: 'detached' });
await A.locator('.archive-row').waitFor();
await openChatWith(B, '爱丽丝');
await B.fill('.composer textarea', '归档后发来的消息');
await B.keyboard.press('Enter');
await itemA('鲍勃').waitFor({ timeout: 15000 }).catch(async (e) => {
  await shot(A, 'fail-A');
  await shot(B, 'fail-B');
  throw e;
});
await A.locator('.archive-row').waitFor({ state: 'detached', timeout: 10000 });
// folders
await A.click('button[aria-label="管理分组"]');
await A.click('.modal button:has-text("新建分组")');
await A.fill('.modal input[placeholder="例如：工作、家人"]', '工作');
await A.locator('.modal .pick-row', { hasText: '鲍勃' }).locator('input').check();
await A.click('.modal button:has-text("保存")');
await A.locator('.modal .folder-row', { hasText: '工作' }).waitFor();
await A.click('.modal button[aria-label="关闭"]');
await A.click('.chat-tabs button:text-is("工作")');
await itemA('鲍勃').waitFor();
expect1(await A.locator('.sidebar .chat-list .chat-item').count(), 1, 'folder shows only its chats');
await M.locator('.chat-tabs button:text-is("工作")').waitFor({ timeout: 15000 });
await shot(A, '42-chatlist-folder');
await A.click('.chat-tabs button:text-is("全部")');
await itemA('周末爬山').click({ button: 'right' });
await A.locator('.ctx-menu button:text-is("开启通知")').waitFor();
await A.waitForTimeout(300); // let the pop-in animation finish
await shot(A, '43-chatlist-menu');
await A.click('.ctx-menu button:text-is("开启通知")');
await menuA('周末爬山', '取消置顶');
await itemA('周末爬山').locator('.title-ic').waitFor({ state: 'detached' });
step('chat list: pin / mute / mark unread / archive / folders, synced across devices');

// ---- v0.6 encrypted avatars ----
await A.click('button[aria-label="菜单"]');
await A.click('.dropdown >> text=设置');
{
  const [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('.modal button[aria-label="更换头像"]')]);
  await fc.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: photo });
}
await A.locator('.modal .avatar-img').waitFor({ timeout: 15000 });
await A.click('.modal button[aria-label="关闭"]');
await B.locator('.sidebar .chat-item:has(.chat-title:text-is("爱丽丝")) .avatar-img').waitFor({ timeout: 20000 }); // decrypted on Bob's side
await openChatWith(A, '周末爬山');
await openInfo(A);
{
  const [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('.info-panel button[aria-label="更换群头像"]')]);
  await fc.setFiles({ name: 'group.png', mimeType: 'image/png', buffer: photo });
}
await B.locator('.sidebar .chat-item:has(.chat-title:text-is("周末爬山")) .avatar-img').waitFor({ timeout: 20000 });
await shot(B, '49-avatars');
step('end-to-end encrypted avatars: mine and the group\'s, decrypted by others');

// ---- v0.6 shared media ----
await openChatWith(A, '鲍勃');
await openInfo(A);
await A.click('.info-panel >> text=共享内容');
await A.locator('.modal .media-cell').first().waitFor({ timeout: 15000 });
await shot(A, '50-shared-media');
await A.click('.modal .tabs >> text=文件');
await A.locator('.modal .shared-row', { hasText: 'big.bin' }).first().waitFor({ timeout: 10000 });
await A.click('.modal button[aria-label="关闭"]');
await closeInfo(A);
step('shared media page: photos, files');

// ---- v0.6 personal data backup → restore into another account ----
await A.click('button[aria-label="菜单"]');
await A.click('.dropdown >> text=设置');
await A.click('.modal .tabs >> text=安全');
await A.click('.modal button:has-text("导出个人数据")');
await A.fill('.modal >> nth=-1 >> input[placeholder="口令"]', 'backup-pass-123');
await A.fill('.modal >> nth=-1 >> input[placeholder="再输入一次"]', 'backup-pass-123');
const [bk] = await Promise.all([A.waitForEvent('download', { timeout: 60000 }), A.click('.modal >> nth=-1 >> button:has-text("导出")')]);
const bkPath = await bk.path();
await A.getByText('已导出').first().waitFor({ timeout: 15000 });
await A.keyboard.press('Escape');
if (await A.locator('.modal').count()) await A.click('.modal button[aria-label="关闭"]');
await C2.click('button[aria-label="菜单"]');
await C2.click('.dropdown >> text=设置');
await C2.click('.modal .tabs >> text=安全');
await C2.click('.modal button:has-text("导入个人数据")');
await C2.locator('.modal >> nth=-1 >> input[type=file]').setInputFiles(bkPath);
await C2.fill('.modal >> nth=-1 >> input[placeholder="口令"]', 'backup-pass-123');
await C2.click('.modal >> nth=-1 >> button:has-text("打开")');
await C2.getByText('条收藏').first().waitFor({ timeout: 30000 });
await shot(C2, '51-backup-import');
await C2.click('.modal >> nth=-1 >> button:text-is("导入")');
await C2.getByText('已导入').first().waitFor({ timeout: 60000 });
if (await C2.locator('.modal').count()) await C2.click('.modal button[aria-label="关闭"]');
await C2.click('button[aria-label="菜单"]');
await C2.click('.dropdown >> text=收藏夹');
await C2.locator('.modal .saved-item', { hasText: '这是一条定时消息' }).waitFor({ timeout: 15000 }); // Alice's saved item, now Carol's
await C2.click('.modal button[aria-label="关闭"]');
step('personal data backup exported and restored into another account');

// ---- English interface ----
if (await M.locator('button[aria-label="返回"]').isVisible()) await M.click('button[aria-label="返回"]');
await M.click('button[aria-label="菜单"]');
await M.click('text=设置');
await M.click('.modal .tabs >> text=外观与快捷键');
await M.click('.modal button.choice:has-text("English")');
await M.locator('.chat-item').first().waitFor({ timeout: 15000 });
await M.click('button[aria-label="Menu"]');
await M.getByText('New group').waitFor();
await shot(M, '27-english');
await M.keyboard.press('Escape');
await M.mouse.click(200, 700); // tapping outside closes the menu
await M.locator('.dropdown').waitFor({ state: 'detached' });
if (await M.locator('button[aria-label="Back"]').isVisible()) await M.click('button[aria-label="Back"]');
await M.locator('.chat-item:has(.chat-title:text-is("鲍勃"))').click();
await M.locator('.poll').last().getByText('Poll ended').waitFor({ timeout: 15000 });
await M.locator('.poll').last().scrollIntoViewIfNeeded();
await shot(M, '28-mobile-english-poll');
await M.locator('.call-log').last().scrollIntoViewIfNeeded();
await shot(M, '29-mobile-english-calllog');
// gate page follows the chosen language too
const G = await mk('10.9.9.8', 420, 700);
await G.addInitScript(() => localStorage.setItem('securechat.prefs.v1', JSON.stringify({ lang: 'en' })));
await G.goto(BASE + '/');
await G.getByText('Access check').first().waitFor();
await shot(G, '30-gate-english');
step('English UI');

// 11. admin page lists IPs
await A.goto(BASE + '/admin');
await A.click('.tabs >> text=IP 白名单');
await A.getByText('10.0.0.2').waitFor();
await A.click('.tabs >> text=验证日志');
await A.getByText('10.9.9.9').first().waitFor();
await shot(A, '11-admin-log');
await A.click('.tabs >> text=统计');
await A.getByText('每日活跃用户（30 天）').waitFor();
await shot(A, '39-admin-stats');
await A.click('.tabs >> text=操作记录');
await A.locator('.audit-row').first().waitFor();
await shot(A, '40-admin-audit');
await A.click('.tabs >> text=备份');
await A.getByText('异地备份（未开启）').waitFor();
await shot(A, '48-admin-backup');
await A.evaluate(() => setTimeout(() => { throw new TypeError('e2e boom "private words"'); }));
await A.waitForTimeout(800);
await A.click('.tabs >> text=错误日志');
await A.getByText('e2e boom').first().waitFor({ timeout: 10000 });
if (await A.getByText('private words').count()) throw new Error('error report was not scrubbed');
await shot(A, '56-admin-errors');
step('admin pages ok (incl. anonymous error log)');

// ---- v0.7 search inside a chat: text, jump, sender filter ----
await A.goto(BASE + '/');
await openChatWith(A, '周末爬山');
await A.click('.chat-head button[aria-label="搜索聊天记录"]');
const sb = A.locator('.chat-search');
await sb.locator('input').first().fill('加');
await sb.locator('.count').filter({ hasText: /^1\/\d+$/ }).waitFor({ timeout: 10000 });
const total = Number((await sb.locator('.count').innerText()).split('/')[1]);
await sb.locator('input').first().press('Enter');
if (total > 1) await sb.locator('.count', { hasText: `2/${total}` }).waitFor();
await A.locator('.msg-row.flash, .flash').first().waitFor({ timeout: 10000 });
await shot(A, '55-chat-search');
await sb.locator('button[aria-label="筛选"]').click();
await sb.locator('select').selectOption({ label: '鲍勃' }).catch(() => sb.locator('select').selectOption({ index: 2 }));
await sb.locator('input').first().fill('');
await sb.locator('.count').filter({ hasText: /\d+\/\d+|无结果/ }).waitFor({ timeout: 10000 });
await sb.locator('button[aria-label="关闭搜索"]').click();
await sb.waitFor({ state: 'detached' });
step('search inside a chat: matches counted, Enter jumps, sender filter');

// ---- v0.7 long chats: only a window of messages is in the page; scrolling up / jumping reveals older ones ----
await A.evaluate(() => { const el = document.querySelector('.messages'); el.scrollTop = el.scrollHeight; });
await A.waitForTimeout(300);
for (let i = 1; i <= 170; i++) {
  await A.fill('textarea', `批量消息 #${i}#`);
  await A.keyboard.press('Enter');
}
await A.locator('.messages .text', { hasText: '批量消息 #170#' }).waitFor({ timeout: 30000 });
await A.waitForFunction(() => !document.querySelector('.msg-row.pending, .msg-status .spin'), null, { timeout: 30000 }).catch(() => undefined);
const rows = () => A.evaluate(() => document.querySelectorAll('.messages [id^="msg-"]').length);
const n1 = await rows();
if (n1 > 160) throw new Error('message window not applied: ' + n1 + ' rows');
await A.evaluate(() => (document.querySelector('.messages').scrollTop = 0));
await A.waitForFunction((n) => document.querySelectorAll('.messages [id^="msg-"]').length > n, n1, { timeout: 5000 }).catch(async (e) => {
  console.log(
    '  window debug:',
    n1,
    await A.evaluate(() => {
      const el = document.querySelector('.messages');
      return { rows: el.querySelectorAll('[id^="msg-"]').length, top: el.scrollTop, h: el.scrollHeight, more: !!document.querySelector('.messages .center .btn'), moreText: document.querySelector('.messages .center .btn')?.textContent, failed: document.querySelectorAll('.msg-row.failed, .msg-status .fail').length };
    }),
  );
  await shot(A, 'fail-window');
  throw e;
});
await A.evaluate(() => { const el = document.querySelector('.messages'); el.scrollTop = el.scrollHeight; });
await A.click('.chat-head button[aria-label="搜索聊天记录"]');
await A.locator('.chat-search input').first().fill('批量消息 #2#');
await A.locator('.chat-search .count', { hasText: '1/1' }).waitFor({ timeout: 10000 });
await A.locator('.messages .text', { hasText: '批量消息 #2#' }).waitFor({ timeout: 10000 });
await A.locator('.chat-search button[aria-label="关闭搜索"]').click();
if ((await rows()) <= n1) throw new Error('jumping to an old message did not reveal it');
step('long chat renders a window of messages; search jump reveals older ones');

// ---- v0.9 one self-destructing message ----
await A.goto(BASE + '/');
await openChatWith(A, '鲍勃');
await A.click('button[aria-label="限时消息"]');
await A.click('.ttl-menu >> text=1 分钟');
await A.locator('.ttl-chip').waitFor();
await A.fill('textarea', '一分钟后消失的消息');
await A.keyboard.press('Enter');
await A.locator('.ttl-chip').waitFor({ state: 'detached' });
await A.locator('.msg-row.mine', { hasText: '一分钟后消失的消息' }).locator('.meta [title="阅后即焚"]').waitFor({ timeout: 10000 });
await A.fill('textarea', '普通消息');
await A.keyboard.press('Enter');
if (await A.locator('.msg-row.mine', { hasText: '普通消息' }).last().locator('.meta [title="阅后即焚"]').count()) throw new Error('timer applied to the next message too');
step('one message with its own timer; the next one is normal');

// ---- v0.8 web code fingerprint: computed in the page, matches the build's manifest ----
// v0.9: sign the manifest the way tools/release.mjs does (if the dev release key is here), so the page can verify it
const relKey = process.env.E2E_RELEASE_KEY ?? '/home/claude/release-key/release-signing.pem';
const manifestPath = new URL('../web/dist/code-fingerprint.json', import.meta.url);
if (fs.existsSync(relKey)) {
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  man.sig = crypto.sign(null, Buffer.from(`securechat-web-code|${man.version}|${man.fingerprint}`), crypto.createPrivateKey(fs.readFileSync(relKey, 'utf8'))).toString('base64');
  fs.writeFileSync(manifestPath, JSON.stringify(man));
}
await A.goto(BASE + '/');
await A.click('button[aria-label="菜单"]');
await A.click('.dropdown >> text=设置');
await A.click('.modal .tabs >> text=安全');
await A.locator('.modal .fp-box .ok-text').first().waitFor({ timeout: 30000 });
const fpShown = (await A.locator('.modal .fp-box .safety-code').innerText()).replace(/\s/g, '');
const fpBuild = JSON.parse(fs.readFileSync(new URL('../web/dist/code-fingerprint.json', import.meta.url), 'utf8')).fingerprint.slice(0, 32).toUpperCase();
if (fpShown !== fpBuild) throw new Error(`code fingerprint differs: ${fpShown} vs ${fpBuild}`);
if (fs.existsSync(relKey)) await A.locator('.modal .fp-box', { hasText: '已由发布密钥签名' }).waitFor({ timeout: 10000 });
await A.keyboard.press('Escape');
step('web code fingerprint computed in the page matches the build');

// ---- v0.8 secret chat: X3DH + double ratchet between one device of each side ----
for (const p of [A, B, B2, B3]) while (await p.locator('.login-alert .btn.secondary').count()) await p.locator('.login-alert .btn.secondary').first().click();
await A.goto(BASE + '/');
await openChatWith(A, '鲍勃');
await A.click('button[aria-label="聊天信息"]');
await A.click('.info-panel >> text=发起私密对话');
await A.locator('.secret-view').waitFor({ timeout: 15000 });
await A.locator('.secret-view textarea').waitFor({ timeout: 30000 }).catch(async (e) => {
  await shot(A, 'fail-secret-wait');
  throw e;
});
await shot(A, '57-secret-accepted');
await A.fill('.secret-view textarea', '这是一条私密消息');
await A.keyboard.press('Enter');
// exactly one of Bob's devices took the chat; the others show that it was accepted elsewhere
let bobDev = null;
for (const p of [B, B2, B3]) {
  await p.locator('.secret-item').first().waitFor({ timeout: 20000 });
  await p.locator('.secret-item').first().click();
  if (await p.locator('.secret-view .text', { hasText: '这是一条私密消息' }).waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    if (bobDev) throw new Error('two of Bob\'s devices have the same secret chat');
    bobDev = p;
  }
}
if (!bobDev) throw new Error('no device of Bob received the secret message');
await bobDev.fill('.secret-view textarea', '收到，私密回复');
await bobDev.keyboard.press('Enter');
await A.locator('.secret-view .text', { hasText: '收到，私密回复' }).waitFor({ timeout: 15000 });
// Alice's other device doesn't have it
await M.goto(BASE + '/');
await M.locator('.chat-item').first().waitFor({ timeout: 15000 });
if (await M.locator('.secret-item').count()) throw new Error('secret chat leaked to another device');
// both sides show the same safety number
await A.click('.secret-view button[aria-label="私密对话信息"]');
await bobDev.click('.secret-view button[aria-label="私密对话信息"]');
const codeA = await A.locator('.safety-code').innerText();
if (codeA.replace(/\s/g, '').length !== 60 || codeA !== (await bobDev.locator('.safety-code').innerText())) throw new Error('secret safety numbers differ');
// disappearing: 30 s
await A.click('.modal .choice:has-text("30 秒")');
await A.keyboard.press('Escape');
await bobDev.keyboard.press('Escape');
await bobDev.locator('.secret-view .secret-event', { hasText: '30 秒' }).waitFor({ timeout: 15000 });
await A.fill('.secret-view textarea', '30 秒后消失');
await A.keyboard.press('Enter');
await bobDev.locator('.secret-view .text', { hasText: '30 秒后消失' }).waitFor({ timeout: 15000 });
await shot(bobDev, '58-secret-chat');
await bobDev.locator('.secret-view .text', { hasText: '30 秒后消失' }).waitFor({ state: 'detached', timeout: 45000 });
await A.locator('.secret-view .text', { hasText: '30 秒后消失' }).waitFor({ state: 'detached', timeout: 15000 });
// the chat survives a reload (sealed local storage) and messages keep flowing
await bobDev.reload();
await bobDev.locator('.secret-item').first().click({ timeout: 20000 });
await bobDev.locator('.secret-view .text', { hasText: '收到，私密回复' }).waitFor({ timeout: 10000 });
await bobDev.fill('.secret-view textarea', '刷新后还能发');
await bobDev.keyboard.press('Enter');
await A.locator('.secret-view .text', { hasText: '刷新后还能发' }).waitFor({ timeout: 15000 });
// an attachment (encrypted blob in the pair's direct chat, key inside the ratchet message)
await A.setInputFiles('.secret-view input[type=file]', { name: 'secret-note.txt', mimeType: 'text/plain', buffer: Buffer.from('私密附件内容') });
await bobDev.locator('.secret-view', { hasText: 'secret-note.txt' }).waitFor({ timeout: 20000 });
// v0.9: a call inside the secret chat rings only the bound device (the offer travels through the ratchet)
await A.click('.secret-view button[aria-label="私密语音通话"]');
await bobDev.locator('.call-overlay').getByText('邀请你语音通话…').waitFor({ timeout: 20000 });
for (const p of [B, B2, B3]) if (p !== bobDev && (await p.locator('.call-overlay').count())) throw new Error('secret call rang on another device');
await bobDev.locator('.call-overlay').getByText('私密通话').waitFor();
await bobDev.click('.call-overlay button[aria-label="接听"]');
await A.locator('.call-overlay .call-status', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
await bobDev.locator('.call-overlay .call-status', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: 30000 });
await shot(A, '59-secret-call');
await A.click('.call-overlay button[aria-label="挂断"]');
await bobDev.locator('.call-overlay').waitFor({ state: 'detached', timeout: 15000 });
await A.locator('.secret-view .secret-event', { hasText: '语音通话' }).last().waitFor({ timeout: 10000 });
await bobDev.locator('.secret-view .secret-event', { hasText: '语音通话' }).last().waitFor({ timeout: 10000 });
// verified mark and local pin
await A.click('.secret-view button[aria-label="私密对话信息"]');
await A.locator('.modal input[aria-label="已核对，标记为已验证"]').click();
await A.locator('.modal input[aria-label="已核对，标记为已验证"]:checked').waitFor({ timeout: 5000 });
await A.locator('.modal input[aria-label="置顶"]').click();
await A.locator('.modal input[aria-label="置顶"]:checked').waitFor({ timeout: 5000 });
await A.keyboard.press('Escape');
await A.locator('.secret-view .chat-head svg[aria-label="已验证"]').waitFor({ timeout: 5000 });
// ending it removes it on both sides
await A.click('.secret-view button[aria-label="私密对话信息"]');
await A.click('.modal button:has-text("结束私密对话")');
await A.click('.modal button:has-text("确认结束并删除")');
await A.locator('.secret-view').waitFor({ state: 'detached', timeout: 10000 });
await bobDev.locator('.secret-view .secret-status').waitFor({ timeout: 15000 });
if (await bobDev.locator('.secret-view .text', { hasText: '收到，私密回复' }).count()) throw new Error('ended secret chat kept its messages');
step('secret chat: one device each, both directions, same safety number, disappearing, survives reload, ended on both sides');

// ---- v0.6 account deletion (Bob, on the device whose passkey was last used; password + passkey) ----
while (await B3.locator('.login-alert .btn.secondary').count()) await B3.locator('.login-alert .btn.secondary').first().click();
await B3.click('button[aria-label="菜单"]');
await B3.click('.dropdown >> text=设置');
await B3.click('.modal .tabs >> text=安全');
await B3.click('.modal button:has-text("注销账号…")');
const del = B3.locator('.modal').last();
await del.locator('label:has-text("输入你的用户名") input').fill('bob');
await del.locator('label:has-text("登录密码") input').fill('bob-password-12');
await del.locator('label.check input').check();
await shot(B3, '52-delete-account');
await del.locator('button:has-text("用通行密钥确认并注销")').click();
await B3.getByRole('heading', { name: '登录' }).waitFor({ timeout: 30000 }).catch(async (e) => {
  await shot(B3, 'fail-delete');
  throw e;
});
await A.goto(BASE + '/');
await A.locator('.sidebar .chat-item:has(.chat-title:text-is("已注销账号"))').click({ timeout: 20000 });
await A.getByText('对方已注销账号').first().waitFor({ timeout: 10000 });
await A.locator('.messages .text', { hasText: '你好 Bob，这条消息是端到端加密的' }).first().waitFor({ timeout: 15000 });
await shot(A, '53-deleted-peer');
step('account deletion: signed out everywhere, history kept for others, shown as deleted');

await browser.close();
console.log('ALL E2E STEPS PASSED');

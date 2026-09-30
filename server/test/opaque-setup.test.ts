import { describe, expect, it } from 'vitest';
import * as opaque from '@serenity-kit/opaque';
import { createInvite } from '../src/invites.js';
import { Client, makeApp } from './helpers.js';
import { buildApp } from '../src/app.js';

describe('OPAQUE server key', () => {
  it('refuses to start with a different OPAQUE_SERVER_SETUP once accounts exist', async () => {
    const env = await makeApp();
    const inv = createInvite(env.ctx, { kind: 'register', maxUses: 1 });
    const c = new Client(env.app, '10.1.1.1');
    await c.post('/api/gate/invite', { invite: inv.token });
    await c.register(inv.token, 'someone', 'some-password-1');
    await env.app.close();

    await opaque.ready;
    process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
    try {
      await expect(buildApp({ dataDir: env.dataDir, webDist: '/nonexistent' })).rejects.toThrow(/OPAQUE_SERVER_SETUP/);
    } finally {
      delete process.env.OPAQUE_SERVER_SETUP;
    }
    // the original key still works
    const again = await buildApp({ dataDir: env.dataDir, webDist: '/nonexistent', cookieSecure: false, trustProxy: 'loopback' });
    const c2 = new Client(again.app, '10.1.1.1');
    expect((await c2.login('someone', 'some-password-1')).status).toBe(200);
    await again.app.close();
  });
});

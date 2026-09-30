import { buildApp } from './app.js';
import { HOST, PORT } from './config.js';

const { app } = await buildApp();
await app.listen({ port: PORT, host: HOST });

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    // never hang on shutdown (open WebSockets could otherwise keep close() pending): hard exit after 5 s
    setTimeout(() => process.exit(0), 5000).unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

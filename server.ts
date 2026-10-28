import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { loadBackendEnv } from './src/backend/config/env.ts';
import { BackendGateway } from './src/backend/db/gateway.ts';
import { createRuntimeGateway } from './src/backend/db/runtimeGatewayFactory.ts';
import { createBackendApiRouter } from './src/backend/app.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const envConfig = loadBackendEnv();
  const gateway: BackendGateway = await createRuntimeGateway(
    envConfig,
    path.join(__dirname, '.data', 'quizpocket-pg')
  );

  const app = express();

  app.disable('x-powered-by');

  // Mount authoritative QuizPocket backend API under /api
  app.use(
    '/api',
    createBackendApiRouter({
      gateway,
      cronSecret: envConfig.cronSecret,
    })
  );

  // Run an every-30-second background sweep to finalize expired attempts automatically.
  if (!envConfig.isSupabaseConfigured || envConfig.supabaseServiceRoleKey) {
    const timer = setInterval(async () => {
      try {
        await gateway.finalizeExpiredAttemptsSweep(200);
      } catch (err) {
        console.error('Background attempt expiry sweep failed:', err);
      }
    }, 30_000);
    timer.unref();
  }

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(envConfig.port, '0.0.0.0', () => {
    console.log(`QuizPocket server listening on http://0.0.0.0:${envConfig.port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start QuizPocket server:', err);
  process.exit(1);
});

import express from 'express';
import serverless from 'serverless-http';
import { loadBackendEnv } from '../../src/backend/config/env.ts';
import { SupabaseBackendGateway } from '../../src/backend/db/supabaseGateway.ts';
import { createBackendApiRouter } from '../../src/backend/app.ts';

const envConfig = loadBackendEnv();
const gateway = new SupabaseBackendGateway(envConfig);
const app = express();

app.disable('x-powered-by');
app.use(
  '/api',
  createBackendApiRouter({
    gateway,
    cronSecret: envConfig.cronSecret,
  })
);

const expressHandler = serverless(app);
const functionPathPrefix = '/.netlify/functions/api';

export const handler = (event: any, context: any) => {
  const requestPath = event?.path;
  if (typeof requestPath !== 'string' || !requestPath.startsWith(functionPathPrefix)) {
    return expressHandler(event, context);
  }

  const suffix = requestPath.slice(functionPathPrefix.length);
  const normalizedPath =
    suffix === '/api' || suffix.startsWith('/api/')
      ? suffix
      : `/api${suffix || '/'}`;

  return expressHandler({ ...event, path: normalizedPath }, context);
};

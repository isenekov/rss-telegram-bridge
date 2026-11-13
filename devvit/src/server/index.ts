import { getRequestListener } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { app } from './app.ts';

createServer(getRequestListener(app.fetch)).listen(getServerPort());

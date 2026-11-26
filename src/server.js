import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChainStore } from './core/store.js';
import { RollingRollout } from './core/rollout.js';
import { pluginRegistry } from './plugins/index.js';
import { seedChains } from './config/chains.js';
import { createAdminHandler } from './admin.js';
import { handleGatewayRequest } from './gateway.js';
import { startUpstream } from './upstream.js';
import { sendError } from './core/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 9001);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function createApp({ upstreamPort = UPSTREAM_PORT } = {}) {
  const store = new ChainStore(pluginRegistry, seedChains);
  store.activeId = 'chain-a'; // 初始活动链（已确认）
  const rollout = new RollingRollout(store);
  const adminHandler = createAdminHandler({ store, rollout });
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/admin')) return await adminHandler(req, res);

      // 调试页静态资源
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const file = path.join(__dirname, '..', 'public', 'index.html');
        res.writeHead(200, { 'content-type': MIME['.html'] });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === 'GET' && req.url.startsWith('/static/')) {
        const name = path.basename(req.url);
        const file = path.join(__dirname, '..', 'public', name);
        if (!fs.existsSync(file)) {
          res.writeHead(404);
          return res.end('not found');
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'text/plain' });
        return res.end(fs.readFileSync(file));
      }

      // 数据面
      return await handleGatewayRequest(req, res, { store, rollout, upstreamBase });
    } catch (err) {
      sendError(res, err);
    }
  });

  return { server, store, rollout };
}

async function main() {
  await startUpstream(UPSTREAM_PORT);
  const { server, store } = createApp();
  server.listen(PORT, () => {
    console.log(`[gateway] data+admin on http://127.0.0.1:${PORT}`);
    console.log(`[gateway] debug page     http://127.0.0.1:${PORT}/`);
    console.log(`[upstream] mock on       http://127.0.0.1:${UPSTREAM_PORT}`);
    console.log(`[gateway] active chain   ${store.active().revLabel}`);
  });
}

// 仅在直接运行时启动；被测试 import 时不自动监听
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

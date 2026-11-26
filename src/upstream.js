import http from 'node:http';

/**
 * 本地 mock 上游（独立端口）。
 *  - POST /echo            回显网关转来的 body（观察字段移除/协议转换结果）
 *  - POST /users           返回用户对象（自动补齐 ssn/internal 字段，供移除插件演示）
 *  - GET  /users/:id       同上
 *  - GET  /stream/users    SSE：发 3 条事件后关闭（演示流内链绑定）
 */
export function startUpstream(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://upstream.local');

    const readBody = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (chunks.length === 0) return {};
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return {};
      }
    };

    if (req.method === 'POST' && url.pathname === '/echo') {
      const body = await readBody();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ upstream: 'mock', received: body }));
    }

    if (req.method === 'POST' && url.pathname === '/users') {
      const body = await readBody();
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        upstream: 'mock',
        user: {
          id: 42,
          name: body?.user?.name ?? 'anonymous',
          age: body?.user?.age ?? null,
          role: body?.user?.role ?? 'guest',
          ssn: '111-22-3333',
          internal: { debug: true, token: 'upstream-secret' },
        },
      }));
    }

    const m = url.pathname.match(/^\/users\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        upstream: 'mock',
        user: {
          id: m[1],
          name: 'alice',
          age: 30,
          role: 'member',
          ssn: '111-22-3333',
          internal: { debug: true, token: 'upstream-secret' },
        },
      }));
    }

    if (req.method === 'GET' && url.pathname === '/stream/users') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = [
        { id: 1, name: 'alice', age: 30, role: 'member', ssn: '111-22-3333', internal: { debug: true } },
        { id: 2, name: 'bob', age: 17, role: 'guest', ssn: '222-33-4444', internal: { debug: true } },
        { id: 3, name: 'carol', age: 41, role: 'admin', ssn: '333-44-5555', internal: { debug: false } },
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= base.length) {
          clearInterval(timer);
          return res.end();
        }
        const item = base[i++];
        res.write(`id:${item.id}\nevent:user\ndata:${JSON.stringify(item)}\n\n`);
      }, 300);
      req.on('close', () => clearInterval(timer));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

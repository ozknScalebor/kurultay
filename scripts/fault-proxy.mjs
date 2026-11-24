// Fault-injecting proxy for the bench: forwards OpenAI-compatible chat requests to the real
// providers (routed by model id) and makes ONE model fail mid-task – after `after` of its
// requests it either stops answering (mode "hang": the connection stays open, nothing comes
// back) or answers 503 (mode "error"). Every agent in the bench talks to the same proxy, so
// Kurultay and Qwen Code meet the same failure at the same point of their work.
//
//   const p = await startFaultProxy({ routes: { 'glm-5.3-flash': { base, key }, … }, faulty: 'glm-5.3-flash', mode: 'hang', after: 3 });
//   p.url → http://127.0.0.1:<port>/v1 · p.stats → { requests, faulted } · await p.close()
/* global fetch, Buffer, AbortController */
import { createServer } from 'node:http';

export async function startFaultProxy({ routes, faulty, mode = 'hang', after = 3, port = 0 }) {
  const stats = { requests: 0, faulted: 0, byModel: {} };
  let faultyCount = 0;
  const hanging = new Set();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && /\/models\/?$/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: Object.keys(routes).map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (req.method !== 'POST' || !/\/chat\/completions\/?$/.test(req.url ?? '')) {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      const model = String(JSON.parse(raw.toString('utf8') || '{}').model ?? '');
      const route = routes[model];
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `unknown model ${model}` } }));
        return;
      }
      stats.requests++;
      stats.byModel[model] = (stats.byModel[model] ?? 0) + 1;
      if (model === faulty && ++faultyCount > after) {
        stats.faulted++;
        if (mode === 'error') {
          res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Service Unavailable (injected by the bench)', type: 'server_error' } }));
          return;
        }
        // hang: keep the connection open and never answer – until the client gives up
        hanging.add(res);
        req.on('close', () => hanging.delete(res));
        return;
      }
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const up = await fetch(`${route.base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${route.key}`, 'content-type': 'application/json', accept: req.headers.accept ?? '*/*' },
        body: raw,
        signal: ac.signal,
      });
      const headers = { 'content-type': up.headers.get('content-type') ?? 'application/json' };
      const ra = up.headers.get('retry-after');
      if (ra) headers['retry-after'] = ra;
      res.writeHead(up.status, headers);
      if (up.body) for await (const chunk of up.body) res.write(chunk);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `proxy: ${e?.message ?? e}` } }));
      else res.end();
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    stats,
    /** every agent run starts with a healthy model that fails after `after` requests */
    reset: () => {
      faultyCount = 0;
      for (const h of hanging) h.destroy();
      hanging.clear();
    },
    close: () =>
      new Promise((r) => {
        for (const h of hanging) h.destroy();
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

/** "${NVIDIA_API_KEY}" → the variable's value (the bench configs refer to keys this way). */
export function resolveKey(apiKey) {
  const m = /^\$\{([A-Z0-9_]+)(?::-([^}]*))?\}$/.exec(apiKey ?? '');
  return m ? (process.env[m[1]] ?? m[2] ?? '') : (apiKey ?? '');
}

/**
 * From a Kurultay config: the proxy routes, and the same config pointed at the proxy. Each
 * endpoint keeps its own (dummy) key so per-key limits stay separate inside Kurultay.
 */
export function viaProxy(config, proxyUrl) {
  const routes = {};
  const eps = [...(config.endpoints ?? []), ...(config.helper ? [config.helper] : [])];
  for (const ep of eps) for (const m of ep.models ?? []) routes[m] = { base: ep.baseUrl, key: resolveKey(ep.apiKey) };
  const point = (ep) => ({ ...ep, baseUrl: proxyUrl, apiKey: `proxy-${ep.name}` });
  return { routes, config: { ...config, endpoints: (config.endpoints ?? []).map(point), ...(config.helper ? { helper: point(config.helper) } : {}) } };
}

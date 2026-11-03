// Actual Next HTTP routes, restricted to a previously approved disposable local stack.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = process.env.SOKUPA_LOCAL_STACK_ROOT;
if (!root || !path.basename(root).startsWith('sokupa-real-supabase-')) throw Error('Explicit disposable root required');
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) if (fs.existsSync(name)) throw Error('Environment files are not allowed');
const stateFile = process.env.SOKUPA_LOCAL_STATE_FILE || 'start.log';
if (!/^[a-z0-9.-]+\.log$/.test(stateFile)) throw Error('Local state filename required');
const state = fs.readFileSync(path.join(root, stateFile), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(row => row.env?.API_URL);
assert.equal(state.runtime, 'native'); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(state.env.API_URL).hostname));
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: state.env.API_URL, SUPABASE_SERVICE_ROLE_KEY: state.env.SERVICE_ROLE_KEY, SESSION_SECRET: fs.readFileSync(path.join(root, 'dispatch-key'), 'utf8'), ADMIN_LINE_USER_ID: 'local-owner', ANALYSIS_BACKGROUND_MODE: 'disabled' });
const original = global.fetch;
global.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'All nonlocal requests are refused');
  return original(input, { ...init, redirect: 'error' });
};
let handler;
const server = http.createServer((req, res) => { if (handler) return handler(req, res); res.writeHead(503); res.end(); });
(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port, app = require('next')({ dev: false, hostname: '127.0.0.1', port });
  await app.prepare(); handler = app.getRequestHandler();
  console.log(JSON.stringify({ local_history_next_ready: true, origin: `http://127.0.0.1:${port}` }));
  const shutdown = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
})().catch(error => { console.error(error.message); process.exit(1); });

// Read-only check. Secrets are read from the environment, never command arguments or output.
const origin = new URL(process.env.SOKUPA_CHECK_ORIGIN || '');
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) throw new Error('HTTPS required');
if (!process.env.CRON_SECRET) throw new Error('CRON_SECRET must be provided securely');
const response = await fetch(new URL('/api/analysis-jobs/worker-health',origin), {
  headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
});
const data = await response.json();
console.log(JSON.stringify({status:response.status,processing_ready:data.processing_ready===true}));
if (!response.ok || !data.processing_ready) process.exitCode=1;

// Verifies P1: Supabase schema is reachable — creates a session, writes a
// context entry, then reads both back using the anon key.
import { readFileSync } from 'node:fs';

function loadEnv(path) {
  const env = {};
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = loadEnv(new URL('../.env', import.meta.url));
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function main() {
  const sessionRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ surface: 'web', user_id: 'test-user' }),
  });
  if (!sessionRes.ok) {
    throw new Error(`session insert failed: ${sessionRes.status} ${await sessionRes.text()}`);
  }
  const [session] = await sessionRes.json();
  console.log('Created session:', session);

  const entryRes = await fetch(`${SUPABASE_URL}/rest/v1/context_entries`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      session_id: session.id,
      companion: 'klimt',
      role: 'user',
      content: 'P1 verification test entry',
      metadata: { test: true },
    }),
  });
  if (!entryRes.ok) {
    throw new Error(`context entry insert failed: ${entryRes.status} ${await entryRes.text()}`);
  }
  const [entry] = await entryRes.json();
  console.log('Created context entry:', entry);

  const readRes = await fetch(
    `${SUPABASE_URL}/rest/v1/context_entries?session_id=eq.${session.id}&select=*`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (!readRes.ok) {
    throw new Error(`read back failed: ${readRes.status} ${await readRes.text()}`);
  }
  const rows = await readRes.json();
  console.log('Read back context_entries for session:', rows);

  console.log('\nP1 CONFIRMED: Supabase read/write working.');
}

main().catch((err) => {
  console.error('P1 verification FAILED:', err.message);
  process.exit(1);
});

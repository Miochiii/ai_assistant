// Local task grants: window identities, actions and expiry. This is an
// accident boundary, not a signature against arbitrary same-user code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ACTIONS = new Set(['activate', 'observe', 'click', 'replay', 'scroll', 'key', 'text', 'chord', 'drag']);
const WINDOW_KEYS = ['hwnd', 'pid', 'class_name', 'title'];

export class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function grantDir(root) { return join(root, 'runtime', 'authorizations'); }

function valid(grant) {
  if (!grant || grant.schema_version !== 1 || typeof grant.grant_id !== 'string') return false;
  if (!Array.isArray(grant.actions) || !grant.actions.length
    || grant.actions.some(action => !ACTIONS.has(action))) return false;
  if (!Array.isArray(grant.windows) || !grant.windows.length) return false;
  if (Number.isNaN(Date.parse(grant.expires_at))) return false;
  return true;
}

export function activeGrants({ root = ROOT, session } = {}) {
  const directory = grantDir(root);
  if (!existsSync(directory)) return [];
  const now = Date.now();
  const grants = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    let grant;
    try { grant = JSON.parse(readFileSync(join(directory, name), 'utf8')); } catch { continue; }
    if (!valid(grant) || Date.parse(grant.expires_at) <= now) continue;
    if (session !== undefined && grant.harness_session
      && grant.harness_session !== session) continue;
    grants.push(grant);
  }
  return grants.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

export function grantCovers(grant, window, action, programId) {
  if (!grant.actions.includes(action)) return false;
  if (!grant.windows.some(candidate => WINDOW_KEYS.every(key => candidate[key] === window[key]))) return false;
  if (programId !== undefined && Array.isArray(grant.program_ids) && grant.program_ids.length
    && !grant.program_ids.includes(programId)) return false;
  return true;
}

export function selectGrant({ window, action, session, programId, root = ROOT }) {
  for (const grant of activeGrants({ root, session })) {
    if (grantCovers(grant, window, action, programId)) return grant;
  }
  throw new AuthorizationError('AUTHORIZATION_REQUIRED',
    `No active task grant covers ${action} on this window; authorize it once before acting`);
}

export function selectGrantForHwnd({ hwnd, action, session, root = ROOT }) {
  for (const grant of activeGrants({ root, session })) {
    if (grant.actions.includes(action) && grant.windows.some(window => window.hwnd === hwnd)) return grant;
  }
  throw new AuthorizationError('AUTHORIZATION_REQUIRED',
    `No active task grant covers ${action} on hwnd ${hwnd}; authorize it once before acting`);
}

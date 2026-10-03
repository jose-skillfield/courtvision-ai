// Session history in localStorage. Every access is guarded: private windows and blocked
// storage simply mean history isn't kept.

const KEY = 'courtvision.sessions.v1';
const SETTINGS_KEY = 'courtvision.settings.v1';

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const loadSessions = () => read(KEY, []);
export const clearSessions = () => write(KEY, []);

/** Saves a session's shot summaries (no video frames). Keeps the last 50 sessions. */
export function saveSession(session) {
  const all = loadSessions().filter((s) => s.id !== session.id);
  all.push(session);
  write(KEY, all.slice(-50));
}

export const loadSettings = (defaults) => ({ ...defaults, ...read(SETTINGS_KEY, {}) });
export const saveSettings = (s) => write(SETTINGS_KEY, s);

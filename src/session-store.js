// src/session-store.js
const fs = require('fs');
const path = require('path');

const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

// { agentKey: { sessionId: string, lastActivity: number, threadId: string|null } }
let sessions = {};

function load() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[session-store] 로드 실패:', e.message);
    sessions = {};
  }
}

function save() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (e) {
    console.error('[session-store] 저장 실패:', e.message);
  }
}

function get(agentKey) {
  return sessions[agentKey] || null;
}

function set(agentKey, data) {
  sessions[agentKey] = { ...sessions[agentKey], ...data, lastActivity: Date.now() };
  save();
}

function updateActivity(agentKey) {
  if (sessions[agentKey]) {
    sessions[agentKey].lastActivity = Date.now();
    save();
  }
}

function clearSession(agentKey) {
  if (sessions[agentKey]) {
    sessions[agentKey].sessionId = null;
    save();
  }
}

function getAll() {
  return { ...sessions };
}

load();

module.exports = { load, save, get, set, updateActivity, clearSession, getAll };

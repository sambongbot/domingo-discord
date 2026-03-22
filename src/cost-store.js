// src/cost-store.js
// 에이전트별 토큰/비용 추적 (session-store.js 패턴)
const fs = require('fs');
const path = require('path');

const COSTS_FILE = path.join(__dirname, '..', 'data', 'costs.json');
const RETENTION_DAYS = 90;

// { agentKey: { total: {...}, daily: { "YYYY-MM-DD": {...} }, lastUpdated: ISO } }
let costs = {};

function load() {
  try {
    if (fs.existsSync(COSTS_FILE)) {
      costs = JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[cost-store] 로드 실패:', e.message);
    costs = {};
  }
}

function save() {
  try {
    fs.writeFileSync(COSTS_FILE, JSON.stringify(costs, null, 2));
  } catch (e) {
    console.error('[cost-store] 저장 실패:', e.message);
  }
}

function emptyStats() {
  return { turns: 0, duration_ms: 0, requests: 0, input_tokens: 0, output_tokens: 0 };
}

function addStats(target, source) {
  target.turns += source.turns || 0;
  target.duration_ms += source.duration_ms || 0;
  target.requests += source.requests || 0;
  target.input_tokens += source.input_tokens || 0;
  target.output_tokens += source.output_tokens || 0;
}

// result 이벤트에서 비용 데이터 추출 → 누적
function record(agentKey, resultEvent) {
  if (!costs[agentKey]) {
    costs[agentKey] = { total: emptyStats(), daily: {}, lastUpdated: null };
  }

  const agent = costs[agentKey];
  const today = new Date().toISOString().split('T')[0];

  if (!agent.daily[today]) {
    agent.daily[today] = emptyStats();
  }

  const increment = {
    turns: resultEvent.num_turns || 0,
    duration_ms: resultEvent.duration_ms || 0,
    requests: 1,
    input_tokens: resultEvent.usage?.input_tokens || resultEvent.input_tokens || 0,
    output_tokens: resultEvent.usage?.output_tokens || resultEvent.output_tokens || 0,
  };

  addStats(agent.total, increment);
  addStats(agent.daily[today], increment);
  agent.lastUpdated = new Date().toISOString();

  // 90일 지난 daily 정리
  pruneOldDays(agent);

  save();
}

function pruneOldDays(agent) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  for (const day of Object.keys(agent.daily)) {
    if (day < cutoffStr) {
      delete agent.daily[day];
    }
  }
}

// 에이전트별 or 전체 요약
function getSummary(agentKey) {
  if (agentKey) {
    return costs[agentKey] || null;
  }
  return { ...costs };
}

// 이번 달 요약
function getMonthly() {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const result = {};

  for (const [key, agent] of Object.entries(costs)) {
    const monthly = emptyStats();
    for (const [day, stats] of Object.entries(agent.daily || {})) {
      if (day.startsWith(monthPrefix)) {
        addStats(monthly, stats);
      }
    }
    result[key] = monthly;
  }

  return result;
}

function getAll() {
  return { ...costs };
}

load();

module.exports = { load, save, record, getSummary, getMonthly, getAll };

// src/thread-manager.js

// 에이전트별 활성 스레드 추적
// agentKey → { threadId, thread (Discord.ThreadChannel), createdAt, title }
const activeThreads = new Map();

/**
 * 에이전트의 활성 스레드를 가져오거나, 없으면 새로 생성
 * @param {TextChannel} channel - Discord 채널
 * @param {string} agentKey - 에이전트 키 (sambong, jangyoungsil, munsu)
 * @param {string} agentName - 에이전트 표시 이름 (삼봉, 장영실, 박문수)
 * @param {string} [title] - 스레드 제목 (없으면 자동 생성)
 * @returns {Promise<ThreadChannel>}
 */
async function getOrCreateThread(channel, agentKey, agentName, title) {
  // 1. 활성 스레드가 있으면 반환
  const existing = activeThreads.get(agentKey);
  if (existing?.thread && !existing.thread.archived) {
    return existing.thread;
  }

  // 2. 새 스레드 생성
  const now = new Date();
  const threadName = title || `${agentName} — ${now.getMonth()+1}/${now.getDate()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

  const thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 60, // 60분 미활동 시 아카이브
    reason: `${agentName} 작업 스레드`,
  });

  activeThreads.set(agentKey, {
    threadId: thread.id,
    thread,
    createdAt: Date.now(),
    title: threadName,
  });

  return thread;
}

/**
 * 현재 활성 스레드를 아카이브하고 새 스레드 생성
 * @param {TextChannel} channel
 * @param {string} agentKey
 * @param {string} agentName
 * @param {string} title
 * @returns {Promise<ThreadChannel>}
 */
async function newThread(channel, agentKey, agentName, title) {
  // 기존 스레드 아카이브
  const existing = activeThreads.get(agentKey);
  if (existing?.thread && !existing.thread.archived) {
    try {
      await existing.thread.setArchived(true);
    } catch (e) {
      console.error(`[thread-manager] 아카이브 실패 (${agentKey}):`, e.message);
    }
  }
  activeThreads.delete(agentKey);

  // 새 스레드 생성
  return getOrCreateThread(channel, agentKey, agentName, title);
}

/**
 * 에이전트의 활성 스레드 가져오기 (없으면 null)
 */
function getThread(agentKey) {
  const entry = activeThreads.get(agentKey);
  return entry?.thread || null;
}

/**
 * 모든 활성 스레드 정보
 */
function getStatus() {
  const status = {};
  for (const [key, entry] of activeThreads) {
    status[key] = {
      threadId: entry.threadId,
      title: entry.title,
      createdAt: entry.createdAt,
      archived: entry.thread?.archived || false,
    };
  }
  return status;
}

module.exports = { getOrCreateThread, newThread, getThread, getStatus };

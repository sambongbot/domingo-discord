// src/chat-scheduler.js
// 대화방 자동 스케줄러
// 1) 아침/저녁 정기 대화
// 2) 1~3시간 랜덤 간격으로 자율 대화

const config = require('./config');

let chatEngine = null;
let scheduleTimer = null;
let autoTimer = null;
let running = false;

const SCHEDULE_TOPICS = {
  morning: '오늘 전하를 위해 어떤 일을 할 수 있을까?',
  evening: '오늘 하루 어땠나?',
};

const AUTO_TOPICS = [
  '전하의 사업을 더 성장시키려면 어떻게 해야 할까?',
  '요즘 AI 업계 동향이 어떤 것 같아?',
  '우리 왕국에서 개선할 점이 있을까?',
  '전하께 좋은 아이디어를 제안하고 싶은 게 있어?',
  '오늘 각자 뭘 하고 있었어?',
  '전하의 링크디 서비스, 어떻게 하면 더 잘 될까?',
  '우리끼리 솔직히 말해보자. 뭐가 아쉬워?',
  '전하께서 기뻐하실 만한 일을 하나씩 말해보자.',
  '최근에 재밌는 거 발견한 거 있어?',
  '서로한테 하고 싶은 말이 있으면 해봐.',
  'B2B SaaS 시장에서 우리 전략은 어떤 방향이어야 할까?',
  '전하의 경쟁사 대비 우리 강점은 뭘까?',
  '자동화할 수 있는 업무가 또 있을까?',
  '각자 전문 분야에서 전하께 조언하고 싶은 것은?',
  '이번 주에 잘한 일과 아쉬운 일을 말해보자.',
];

function init(engine) {
  chatEngine = engine;
  running = true;
  _scheduleNext();
  _scheduleAutoChat();
  console.log('[chat-scheduler] 스케줄러 시작 (정기 + 자율 대화)');
}

function stop() {
  running = false;
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  console.log('[chat-scheduler] 스케줄러 중지');
}

// ── 정기 스케줄 (아침/저녁) ──

function _scheduleNext() {
  if (!running) return;

  const now = new Date();
  const { morning, evening } = config.CHAT_CONFIG.schedule;

  const candidates = [];

  const todayMorning = new Date(now);
  todayMorning.setHours(morning, 0, 0, 0);
  if (todayMorning > now) candidates.push({ time: todayMorning, type: 'morning' });

  const todayEvening = new Date(now);
  todayEvening.setHours(evening, 0, 0, 0);
  if (todayEvening > now) candidates.push({ time: todayEvening, type: 'evening' });

  const tomorrowMorning = new Date(now);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(morning, 0, 0, 0);
  candidates.push({ time: tomorrowMorning, type: 'morning' });

  candidates.sort((a, b) => a.time - b.time);
  const next = candidates[0];
  const delay = next.time.getTime() - now.getTime();

  console.log(`[chat-scheduler] 다음 정기 대화: ${next.type} at ${next.time.toLocaleString('ko-KR')}`);

  scheduleTimer = setTimeout(async () => {
    await _triggerScheduled(next.type);
    _scheduleNext();
  }, delay);
}

async function _triggerScheduled(type) {
  if (!chatEngine || !running) return;

  const topic = SCHEDULE_TOPICS[type] || '자유 대화';
  console.log(`[chat-scheduler] 정기 대화 시작: ${type} — "${topic}"`);

  const result = await chatEngine.startConversation(topic);
  if (result.error) {
    console.log(`[chat-scheduler] 정기 대화 실패: ${result.error}`);
  }
}

// ── 자율 대화 (랜덤 간격) ──

function _scheduleAutoChat() {
  if (!running) return;

  const auto = config.CHAT_CONFIG.autoChat;
  if (!auto?.enabled) return;

  const minMs = auto.minIntervalMinutes * 60 * 1000;
  const maxMs = auto.maxIntervalMinutes * 60 * 1000;
  const delay = minMs + Math.random() * (maxMs - minMs);

  const nextTime = new Date(Date.now() + delay);
  console.log(`[chat-scheduler] 다음 자율 대화: ${nextTime.toLocaleString('ko-KR')}`);

  autoTimer = setTimeout(async () => {
    await _triggerAutoChat();
    _scheduleAutoChat(); // 다음 자율 대화 예약
  }, delay);
}

async function _triggerAutoChat() {
  if (!chatEngine || !running) return;

  // 활동 시간대 체크
  const now = new Date();
  const hour = now.getHours();
  const auto = config.CHAT_CONFIG.autoChat;
  if (hour < auto.activeHoursStart || hour >= auto.activeHoursEnd) {
    console.log(`[chat-scheduler] 활동 시간 외 (${hour}시) — 자율 대화 건너뜀`);
    return;
  }

  // 이미 대화 중이면 건너뜀
  if (chatEngine.active) {
    console.log('[chat-scheduler] 대화 진행 중 — 자율 대화 건너뜀');
    return;
  }

  const topic = AUTO_TOPICS[Math.floor(Math.random() * AUTO_TOPICS.length)];
  console.log(`[chat-scheduler] 자율 대화 시작: "${topic}"`);

  const result = await chatEngine.startConversation(topic);
  if (result.error) {
    console.log(`[chat-scheduler] 자율 대화 실패: ${result.error}`);
  }
}

// 외부 이벤트 트리거
async function triggerEvent(topic) {
  if (!chatEngine || !running) return { error: '스케줄러 비활성' };
  return chatEngine.startConversation(topic);
}

module.exports = { init, stop, triggerEvent };

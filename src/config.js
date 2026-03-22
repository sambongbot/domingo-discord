// src/config.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const os = require('os');
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const HOME_DIR = os.homedir();

// 아바타 URL — 캐릭터별 완전히 다른 스타일 (디스코드에서 즉시 구분)
const AVATARS = {
  // 삼봉: adventurer (전략가, 파란 배경)
  sambong: 'https://api.dicebear.com/9.x/adventurer/png?seed=sambong-general&size=256&backgroundColor=b6e3f4',
  // 정주영: lorelei (리서치관, 보라 배경)
  jungyoung: 'https://api.dicebear.com/9.x/lorelei/png?seed=jungyoung-scholar&size=256&backgroundColor=c0aede',
  // 척준경: pixel-art (개발자/전사, 주황 배경)
  chukgyeong: 'https://api.dicebear.com/9.x/pixel-art/png?seed=chukgyeong-blade&size=256&backgroundColor=ffdfbf',
  // 장영실: notionists (엔지니어)
  jangyoungsil: 'https://api.dicebear.com/9.x/notionists/png?seed=jangyoungsil-engineer&size=256&backgroundColor=d1d4f9',
  // 박문수: thumbs (감찰관)
  munsu: 'https://api.dicebear.com/9.x/thumbs/png?seed=munsu-inspector&size=256&backgroundColor=ffd5dc',
};

// 삼봉이 Agent tool로 부르는 서브에이전트 프로필
const SUBAGENT_PROFILES = {
  '척준경': { emoji: '⚔️', avatar: AVATARS.chukgyeong },
  '정주영': { emoji: '📊', avatar: AVATARS.jungyoung },
  '무진':   { emoji: '🗡️', avatar: null },
  '두식':   { emoji: '🏠', avatar: null },
};

const DEFAULT_HQ_AGENT = 'sambong';
// "다 나와" 류 키워드 시 소환할 에이전트
const HQ_ALL_AGENTS = ['sambong', 'jungyoung', 'chukgyeong'];
const HQ_ALL_KEYWORDS = ['셋다', '셋 다', '다 나와', '모두', '전원', '전부', '다같이', '다 같이', '너네', '너희', '협의', '회의', '셋이'];

const AGENTS = {
  sambong: {
    name: '삼봉',
    emoji: '🏯',
    agent: 'sambong',
    model: 'opus',
    cwd: HOME_DIR,
    avatar: AVATARS.sambong,
  },
  jangyoungsil: {
    name: '장영실',
    emoji: '⚙️',
    agent: 'jangyoungsil',
    model: 'sonnet',
    cwd: HOME_DIR + '/agents/jangyoungsil',
    avatar: AVATARS.jangyoungsil,
  },
  munsu: {
    name: '박문수',
    emoji: '🔍',
    agent: 'munsu',
    model: 'sonnet',
    cwd: HOME_DIR + '/agents/munsu',
    avatar: AVATARS.munsu,
  },
  // 서브에이전트: 지휘소에서 직접 호출 가능, 전용 채널 없음
  jungyoung: {
    name: '정주영',
    emoji: '📊',
    agent: 'jungyoung',
    model: 'haiku',
    cwd: HOME_DIR,
    subagent: true,
    aliases: ['주영', '정주영'],
    avatar: AVATARS.jungyoung,
  },
  chukgyeong: {
    name: '척준경',
    emoji: '⚔️',
    agent: 'chukgyeong',
    model: 'sonnet',
    cwd: HOME_DIR,
    subagent: true,
    aliases: ['준경', '척준경'],
    avatar: AVATARS.chukgyeong,
  },
};

// 대화방 설정
const CHAT_CONFIG = {
  model: 'sonnet',
  maxTurnsPerConversation: 0,   // 0 = 무제한, [대화 끝]으로만 종료
  maxConversationsPerDay: 0,    // 0 = 무제한
  cooldownMinutes: 0,
  maxDailyTurns: 0,             // 0 = 무제한
  minTurnsBeforeEnd: 100,         // [대화 끝] 허용 최소 턴 수
  minMinutesBeforeEnd: 25,        // [대화 끝] 허용 최소 경과 시간(분)
  defaultParticipants: ['sambong', 'munsu', 'jungyoung', 'chukgyeong'],
  schedule: { morning: 9, evening: 18 },
  // 자율 대화: 활동 시간대에 랜덤 간격으로 자동 시작
  autoChat: {
    enabled: true,
    activeHoursStart: 8,   // 오전 8시부터
    activeHoursEnd: 23,    // 오후 11시까지
    minIntervalMinutes: 60,  // 최소 1시간 간격
    maxIntervalMinutes: 180, // 최대 3시간 간격
  },
};

// 대화방용 가상 에이전트 설정 생성
function getChatAgentConfig(agentKey) {
  const base = AGENTS[agentKey];
  if (!base) return null;
  return {
    name: base.name,
    emoji: base.emoji,
    agent: base.agent,
    model: CHAT_CONFIG.model,
    cwd: base.cwd,
    avatar: base.avatar,
    maxTurns: 1,  // 도구 사용 차단
  };
}

let CHANNEL_MAP = {};
let COMMAND_CHANNEL_ID = null;
let SYSTEM_LOG_CHANNEL_ID = null;
let CHAT_CHANNEL_ID = null;

const MAX_CONCURRENT_PROCESSES = 5;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const THREAD_ARCHIVE_MS = 60 * 60 * 1000;
const BUFFER_FLUSH_MS = 2000;
const DISCORD_MAX_LENGTH = 1800;

module.exports = {
  DISCORD_TOKEN,
  CLAUDE_PATH,
  HOME_DIR,
  AGENTS,
  SUBAGENT_PROFILES,
  DEFAULT_HQ_AGENT,
  HQ_ALL_AGENTS,
  HQ_ALL_KEYWORDS,
  CHANNEL_MAP,
  COMMAND_CHANNEL_ID,
  SYSTEM_LOG_CHANNEL_ID,
  CHAT_CONFIG,
  CHAT_CHANNEL_ID,
  getChatAgentConfig,
  MAX_CONCURRENT_PROCESSES,
  IDLE_TIMEOUT_MS,
  THREAD_ARCHIVE_MS,
  BUFFER_FLUSH_MS,
  DISCORD_MAX_LENGTH,
  setChannelMap(map) { CHANNEL_MAP = map; module.exports.CHANNEL_MAP = map; },
  setCommandChannel(id) { COMMAND_CHANNEL_ID = id; module.exports.COMMAND_CHANNEL_ID = id; },
  setSystemLogChannel(id) { SYSTEM_LOG_CHANNEL_ID = id; module.exports.SYSTEM_LOG_CHANNEL_ID = id; },
  setChatChannel(id) { CHAT_CHANNEL_ID = id; module.exports.CHAT_CHANNEL_ID = id; },
};

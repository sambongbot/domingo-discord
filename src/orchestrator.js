const config = require('./config');
const agentRunner = require('./agent-runner');
const messageBuffer = require('./message-buffer');
const formatter = require('./discord-formatter');
const threadManager = require('./thread-manager');
const costStore = require('./cost-store');

let systemLogChannel = null;
let hqWebhook = null;

function setHQWebhook(webhook) {
  hqWebhook = webhook;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
  if (systemLogChannel) {
    systemLogChannel.send(`\`${new Date().toLocaleTimeString('ko-KR')}\` ${msg}`).catch(() => {});
  }
}

function setupEventListeners() {
  agentRunner.on('event', async (agentKey, event) => {
    // 비용 추적: result 이벤트에서 turns/duration 기록
    if (event.type === 'result' && !event.is_error) {
      costStore.record(agentKey, event);
    }

    // partial assistant 이벤트는 디버그 로그만 (너무 빈번)
    if (event.type !== 'assistant') {
      log(`[event] ${agentKey}: type=${event.type} subtype=${event.subtype || ''}`);
    }
    const formatted = formatter.formatEvent(agentKey, event);
    if (formatted) {
      if (Array.isArray(formatted)) {
        for (const item of formatted) {
          await messageBuffer.push(agentKey, item.type, item.content, item.sender);
        }
      } else {
        await messageBuffer.push(agentKey, formatted.type, formatted.content, formatted.sender);
      }
    }
  });

  agentRunner.on('spawn', (agentKey) => {
    const agent = config.AGENTS[agentKey] || agentRunner.tempAgents.get(agentKey);
    log(`${agent?.emoji || '🤖'} ${agent?.name || agentKey} 프로세스 시작`);
  });

  agentRunner.on('close', async (agentKey, code) => {
    const agent = config.AGENTS[agentKey] || agentRunner.tempAgents.get(agentKey);
    log(`[close] ${agentKey}: code=${code}`);
    await messageBuffer.flushAll(agentKey);
    if (code !== 0) {
      log(`${agent?.name || agentKey} 프로세스 비정상 종료 (code: ${code})`);
    }
  });

  agentRunner.on('lru-evict', (agentKey) => {
    const agent = config.AGENTS[agentKey] || agentRunner.tempAgents.get(agentKey);
    log(`${agent?.name || agentKey} LRU 교체 → 프로세스 종료`);
  });

  agentRunner.on('stderr', (agentKey, msg) => {
    if (msg.includes('Error') || msg.includes('error')) {
      log(`⚠️ ${agentKey} stderr: ${msg.substring(0, 200)}`);
    }
  });

  agentRunner.on('error', (agentKey, err) => {
    log(`❌ ${agentKey} 오류: ${err.message}`);
  });
}

// 핵심: 메시지를 에이전트에 전달
async function handleMessage(message, agentKey) {
  const agent = config.AGENTS[agentKey];
  if (!agent) return;

  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content) return;

  try {
    // 스레드 결정
    let thread;
    if (message.channel.isThread()) {
      thread = message.channel;
    } else {
      thread = await threadManager.getOrCreateThread(
        message.channel, agentKey, agent.name
      );
    }

    // 메시지 버퍼 초기화
    const sendFn = async (t, c) => t.send(c);
    const editFn = async (m, c) => m.edit(c);
    messageBuffer.init(agentKey, thread, sendFn, editFn);

    // Claude에 메시지 전달 (큐잉 + spawn)
    // sendMessage는 비동기 — 프로세스 완료까지 기다리지 않음 (이벤트 스트리밍으로 응답)
    agentRunner.sendMessage(agentKey, content).catch((err) => {
      log(`❌ ${agent.name} 실행 오류: ${err.message}`);
      thread.send(`❌ 오류: ${err.message}`).catch(() => {});
    });
  } catch (err) {
    log(`❌ ${agent.name} 메시지 처리 실패: ${err.message}`);
    try {
      await message.reply(`❌ 처리 중 오류: ${err.message}`);
    } catch (e) {}
  }
}

// 지휘소 메시지: 이름 감지 → 복수 에이전트 동시 호출 가능
async function handleHQMessage(message) {
  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content) return;

  // /에이전트명 접두어 → 기존 handleCommandChannelMessage 호환
  for (const [key, agent] of Object.entries(config.AGENTS)) {
    if (content.startsWith(`/${agent.name} `)) {
      await handleCommandChannelMessage(message, message.guild);
      return;
    }
  }

  // "전원 소환" 키워드 체크
  const isAllCall = config.HQ_ALL_KEYWORDS.some(kw => content.includes(kw));
  let targetAgents;

  if (isAllCall) {
    targetAgents = [...config.HQ_ALL_AGENTS];
  } else {
    // 개별 에이전트 이름 감지 (복수 매칭)
    targetAgents = [];
    for (const [key, agent] of Object.entries(config.AGENTS)) {
      const names = [agent.name, ...(agent.aliases || [])];
      if (names.some(n => content.includes(n))) {
        targetAgents.push(key);
      }
    }
    // 이름 없으면 삼봉 기본
    if (targetAgents.length === 0) {
      targetAgents.push(config.DEFAULT_HQ_AGENT);
    }
  }

  try {
    // 지휘소: 스레드 안 만들고 채널에 직접 응답
    const channel = message.channel;

    // 각 에이전트에 대해 Webhook sendFn + 메시지 전달
    for (const agentKey of targetAgents) {
      const agent = config.AGENTS[agentKey];
      if (!agent) continue;

      const sendFn = async (t, c, senderName, senderAvatar) => {
        if (hqWebhook) {
          const opts = {
            content: c,
            username: senderName || agent.name,
            avatarURL: senderAvatar || agent.avatar || undefined,
          };
          // 스레드 안이면 threadId 추가
          if (t.isThread()) opts.threadId = t.id;
          return hqWebhook.send(opts);
        }
        return t.send(c);
      };
      const editFn = async (m, c) => m.edit(c);
      messageBuffer.init(agentKey, channel, sendFn, editFn, { webhook: true });

      // HQ 컨텍스트: 역할극 방지 (각 에이전트는 자기 이름으로만 답변)
      const hqPrefix = `[지휘소 — 당신은 "${agent.name}"입니다. ${agent.name}으로만 답하세요. 다른 에이전트(${targetAgents.filter(k => k !== agentKey).map(k => config.AGENTS[k]?.name).filter(Boolean).join(', ')})는 별도 프로세스로 응답하므로 그들의 역할을 대신하지 마세요.]\n\n`;
      const hqContent = hqPrefix + content;

      log(`[HQ] ${agent.name}에게 전달: "${content.substring(0, 50)}"`);
      agentRunner.sendMessage(agentKey, hqContent).catch((err) => {
        log(`❌ ${agent.name} 실행 오류: ${err.message}`);
        channel.send(`❌ ${agent.name} 오류: ${err.message}`).catch(() => {});
      });
    }
  } catch (err) {
    log(`❌ 지휘소 메시지 처리 실패: ${err.message}`);
    await message.reply(`❌ 처리 중 오류: ${err.message}`).catch(() => {});
  }
}

// 지휘소에서 /에이전트명 메시지 전달
async function handleCommandChannelMessage(message, guild) {
  const content = message.content.trim();

  for (const [key, agent] of Object.entries(config.AGENTS)) {
    const prefix = `/${agent.name} `;
    if (content.startsWith(prefix)) {
      const agentMessage = content.substring(prefix.length).trim();
      if (!agentMessage) continue;

      const channelId = Object.entries(config.CHANNEL_MAP)
        .find(([_, v]) => v === key)?.[0];
      if (!channelId) {
        await message.reply(`❌ ${agent.name} 채널을 찾을 수 없습니다.`);
        return;
      }

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        await message.reply(`❌ ${agent.name} 채널에 접근할 수 없습니다.`);
        return;
      }

      const thread = await threadManager.getOrCreateThread(channel, key, agent.name);
      const sendFn = async (t, c) => t.send(c);
      const editFn = async (m, c) => m.edit(c);
      messageBuffer.init(key, thread, sendFn, editFn);

      agentRunner.sendMessage(key, agentMessage).catch((err) => {
        log(`❌ ${agent.name} 실행 오류: ${err.message}`);
      });

      await message.reply(`${agent.emoji} ${agent.name}에게 전달 완료`);
      return;
    }
  }
}

function setSystemLogChannel(channel) {
  systemLogChannel = channel;
}

function setupChatListeners(chatEngine) {
  chatEngine.on('conversationStart', ({ topic, participants }) => {
    const names = participants.map(k => config.AGENTS[k]?.name || k).join(', ');
    log(`🗣️ 대화 시작 — 주제: "${topic}" | 참여자: ${names}`);
  });

  chatEngine.on('turn', ({ turn, speaker }) => {
    log(`🗣️ 턴 ${turn}: ${speaker}`);
  });

  chatEngine.on('conversationEnd', ({ topic, turns, reason }) => {
    log(`🗣️ 대화 종료 — 주제: "${topic}" | ${turns}턴 | 사유: ${reason}`);
  });
}

module.exports = {
  setupEventListeners,
  setupChatListeners,
  handleMessage,
  handleCommandChannelMessage,
  handleHQMessage,
  setHQWebhook,
  setSystemLogChannel,
  log,
};

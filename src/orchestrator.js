const config = require('./config');
const agentRunner = require('./agent-runner');
const messageBuffer = require('./message-buffer');
const formatter = require('./discord-formatter');
const threadManager = require('./thread-manager');

let systemLogChannel = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
  if (systemLogChannel) {
    systemLogChannel.send(`\`${new Date().toLocaleTimeString('ko-KR')}\` ${msg}`).catch(() => {});
  }
}

function setupEventListeners() {
  agentRunner.on('event', async (agentKey, event) => {
    // partial assistant 이벤트는 디버그 로그만 (너무 빈번)
    if (event.type !== 'assistant') {
      log(`[event] ${agentKey}: type=${event.type} subtype=${event.subtype || ''}`);
    }
    const formatted = formatter.formatEvent(agentKey, event);
    if (formatted) {
      await messageBuffer.push(agentKey, formatted.type, formatted.content);
    }
  });

  agentRunner.on('spawn', (agentKey) => {
    const agent = config.AGENTS[agentKey];
    log(`${agent?.emoji || '🤖'} ${agent?.name || agentKey} 프로세스 시작`);
  });

  agentRunner.on('close', async (agentKey, code) => {
    const agent = config.AGENTS[agentKey];
    log(`[close] ${agentKey}: code=${code}`);
    await messageBuffer.flushAll(agentKey);
    if (code !== 0) {
      log(`${agent?.name || agentKey} 프로세스 비정상 종료 (code: ${code})`);
    }
  });

  agentRunner.on('lru-evict', (agentKey) => {
    const agent = config.AGENTS[agentKey];
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

module.exports = {
  setupEventListeners,
  handleMessage,
  handleCommandChannelMessage,
  setSystemLogChannel,
  log,
};

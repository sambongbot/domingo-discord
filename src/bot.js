const { Client, Events, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const config = require('./config');
const orchestrator = require('./orchestrator');
const threadManager = require('./thread-manager');
const agentRunner = require('./agent-runner');
const sessionStore = require('./session-store');
const costStore = require('./cost-store');
const messageBuffer = require('./message-buffer');
const chatEngine = require('./chat-engine');
const chatScheduler = require('./chat-scheduler');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const CATEGORY_NAME = '도밍고왕국';
const SPECIAL_CHANNELS = ['지휘소', '시스템-로그'];

// 채널 자동 생성 포함 매핑
async function autoSetupChannels(guild) {
  // 1. 카테고리 찾기 또는 생성
  let category = guild.channels.cache.find(
    ch => ch.name === CATEGORY_NAME && ch.type === ChannelType.GuildCategory
  );
  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });
    orchestrator.log(`카테고리 생성: ${CATEGORY_NAME}`);
  }

  const channelMap = {};

  // 2. 에이전트 채널 생성/매핑 (서브에이전트는 채널 없음)
  for (const [agentKey, agent] of Object.entries(config.AGENTS)) {
    if (agent.subagent) continue;
    let channel = guild.channels.cache.find(
      ch => ch.name === agent.name && ch.parentId === category.id
    );
    if (!channel) {
      channel = await guild.channels.create({
        name: agent.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `${agent.emoji} ${agent.name} 에이전트 채널`,
      });
      orchestrator.log(`채널 생성: #${agent.name}`);
    }
    channelMap[channel.id] = agentKey;
    orchestrator.log(`채널 매핑: #${channel.name} (${channel.id}) → ${agentKey}`);
  }

  // 3. 지휘소 채널
  let cmdChannel = guild.channels.cache.find(
    ch => ch.name === '지휘소' && ch.parentId === category.id
  );
  if (!cmdChannel) {
    cmdChannel = await guild.channels.create({
      name: '지휘소',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: '전체 상황 파악 & 글로벌 명령',
    });
    orchestrator.log('채널 생성: #지휘소');
  }
  config.setCommandChannel(cmdChannel.id);

  // 3-1. 지휘소 Webhook 생성 또는 기존 것 재사용
  const webhooks = await cmdChannel.fetchWebhooks();
  let hqWebhook = webhooks.find(wh => wh.name === '도밍고왕국');
  if (!hqWebhook) {
    hqWebhook = await cmdChannel.createWebhook({ name: '도밍고왕국' });
    orchestrator.log('지휘소 Webhook 생성');
  }
  orchestrator.setHQWebhook(hqWebhook);

  // 4. 시스템 로그 채널
  let logChannel = guild.channels.cache.find(
    ch => ch.name === '시스템-로그' && ch.parentId === category.id
  );
  if (!logChannel) {
    logChannel = await guild.channels.create({
      name: '시스템-로그',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: '봇 상태, 에러, 프로세스 알림',
    });
    orchestrator.log('채널 생성: #시스템-로그');
  }
  config.setSystemLogChannel(logChannel.id);
  orchestrator.setSystemLogChannel(logChannel);

  // 5. 대화방 채널 — 가장 오래된(먼저 생성된) 채널 우선
  const allChatChannels = guild.channels.cache
    .filter(ch => ch.name === '대화방' && ch.type === ChannelType.GuildText)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  allChatChannels.forEach(ch => {
    orchestrator.log(`대화방 후보: #${ch.name} (${ch.id}) parent=${ch.parentId} created=${ch.createdAt.toISOString()}`);
  });
  let chatChannel = allChatChannels.first();
  if (!chatChannel) {
    chatChannel = await guild.channels.create({
      name: '대화방',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: '🗣️ 에이전트 자율 대화 채널',
    });
    orchestrator.log('채널 생성: #대화방');
  }
  orchestrator.log(`대화방 매핑: #대화방 (${chatChannel.id})`);
  config.setChatChannel(chatChannel.id);

  // 5-1. 대화방 Webhook
  const chatWebhooks = await chatChannel.fetchWebhooks();
  let chatWebhook = chatWebhooks.find(wh => wh.name === '대화방');
  if (!chatWebhook) {
    chatWebhook = await chatChannel.createWebhook({ name: '대화방' });
    orchestrator.log('대화방 Webhook 생성');
  }
  chatEngine.setChatChannel(chatChannel, chatWebhook);

  config.setChannelMap(channelMap);
  orchestrator.log(`채널 매핑 완료: ${Object.keys(channelMap).length}개 에이전트`);
}

client.once('clientReady', async () => {
  orchestrator.log(`봇 온라인: ${client.user.tag}`);

  const guild = client.guilds.cache.first();
  if (guild) {
    await autoSetupChannels(guild);
  }

  orchestrator.setupEventListeners();
  orchestrator.setupChatListeners(chatEngine);
  chatScheduler.init(chatEngine);
  orchestrator.log('이벤트 리스너 등록 완료 — 대기 중');
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
      // 스레드 안의 메시지 → 부모 채널 기준으로 에이전트 식별
    const channelId = message.channel.isThread()
      ? message.channel.parentId
      : message.channel.id;

    const content = message.content.trim();

    // 명령어 처리
    if (content.startsWith('/')) {
      await handleCommand(message, content, channelId);
      return;
    }

    // 대화방 메시지 — 전하 끼어들기
    if (channelId === config.CHAT_CHANNEL_ID) {
      chatEngine.injectUserMessage(message.author.displayName || message.author.username, content);
      return;
    }

    // 지휘소 메시지
    if (channelId === config.COMMAND_CHANNEL_ID) {
      await orchestrator.handleHQMessage(message);
      return;
    }

    // 에이전트 채널 메시지
    const agentKey = config.CHANNEL_MAP[channelId];
    if (agentKey) {
      await orchestrator.handleMessage(message, agentKey);
    }
  } catch (err) {
    console.error(`[bot] messageCreate 에러:`, err);
  }
});

async function handleCommand(message, content, channelId) {
  const agentKey = config.CHANNEL_MAP[channelId];
  const agent = agentKey ? config.AGENTS[agentKey] : null;

  if (content.startsWith('/새작업')) {
    if (!agentKey) return message.reply('에이전트 채널에서만 사용 가능합니다.');
    const title = content.replace('/새작업', '').trim() || null;
    const parentChannel = message.guild.channels.cache.get(channelId);
    if (parentChannel) {
      sessionStore.clearSession(agentKey);
      agentRunner.kill(agentKey);
      messageBuffer.cleanup(agentKey);
      const thread = await threadManager.newThread(parentChannel, agentKey, agent.name, title);
      await message.reply(`${agent.emoji} 새 작업 스레드: ${thread.name}`);
    }
    return;
  }

  if (content === '/리셋') {
    if (!agentKey) return message.reply('에이전트 채널에서만 사용 가능합니다.');
    sessionStore.clearSession(agentKey);
    agentRunner.kill(agentKey);
    messageBuffer.cleanup(agentKey);
    await message.reply(`${agent.emoji} ${agent.name} 세션 초기화 완료`);
    return;
  }

  if (content === '/상태') {
    const runnerStatus = agentRunner.getStatus();
    const threadStatus = threadManager.getStatus();
    const sessions = sessionStore.getAll();

    let statusMsg = '**에이전트 상태**\n';
    for (const [key, agentDef] of Object.entries(config.AGENTS)) {
      const running = runnerStatus[key];
      const thread = threadStatus[key];
      const session = sessions[key];
      statusMsg += `\n${agentDef.emoji} **${agentDef.name}**\n`;
      statusMsg += `  프로세스: ${running ? `✅ PID ${running.pid}` : '⬜ 종료됨'}\n`;
      statusMsg += `  세션: ${session?.sessionId ? session.sessionId.substring(0, 8) + '...' : '없음'}\n`;
      statusMsg += `  스레드: ${thread ? thread.title : '없음'}\n`;
    }

    const mem = process.memoryUsage();
    statusMsg += `\n**봇 메모리**: ${Math.round(mem.rss / 1024 / 1024)}MB`;

    await message.reply(statusMsg);
    return;
  }

  if (content === '/중지') {
    if (!agentKey) return message.reply('에이전트 채널에서만 사용 가능합니다.');
    agentRunner.kill(agentKey);
    messageBuffer.cleanup(agentKey);
    await message.reply(`${agent.emoji} ${agent.name} 프로세스 종료됨`);
    return;
  }

  if (content.startsWith('/대화중지') || content.startsWith('/대화 중지')) {
    await chatEngine.stopConversation('수동 중지');
    await message.reply('🗣️ 대화 중지됨');
    return;
  }

  if (content.startsWith('/대화상태') || content.startsWith('/대화 상태')) {
    const status = chatEngine.getStatus();
    let msg = '**🗣️ 대화방 상태**\n';
    if (status.active) {
      msg += `  진행 중: ✅\n`;
      msg += `  주제: ${status.topic}\n`;
      msg += `  턴: ${status.turn}턴째\n`;
      msg += `  참여자: ${status.participants.map(k => config.AGENTS[k]?.name || k).join(', ')}\n`;
    } else {
      msg += `  진행 중: ⬜\n`;
    }
    msg += `  오늘 대화: ${status.todayConversations}회\n`;
    msg += `  오늘 턴: ${status.todayTurns}턴\n`;
    await message.reply(msg);
    return;
  }

  if (content === '/비용') {
    const monthly = costStore.getMonthly();
    const now = new Date();
    const monthLabel = `${now.getFullYear()}년 ${now.getMonth() + 1}월`;

    let totalTurns = 0, totalRequests = 0, totalDuration = 0;
    let lines = [];

    for (const [key, agentDef] of Object.entries(config.AGENTS)) {
      const stats = monthly[key];
      if (!stats || stats.requests === 0) continue;

      totalTurns += stats.turns;
      totalRequests += stats.requests;
      totalDuration += stats.duration_ms;

      const durationMin = (stats.duration_ms / 60000).toFixed(1);
      let line = `${agentDef.emoji} **${agentDef.name}**\n  턴: ${stats.turns} | 요청: ${stats.requests}회 | 시간: ${durationMin}분`;
      if (stats.input_tokens > 0 || stats.output_tokens > 0) {
        const inK = (stats.input_tokens / 1000).toFixed(1);
        const outK = (stats.output_tokens / 1000).toFixed(1);
        line += ` | 토큰: ${inK}K in / ${outK}K out`;
      }
      lines.push(line);
    }

    if (lines.length === 0) {
      await message.reply(`**에이전트 사용 현황** (${monthLabel})\n\n데이터 없음`);
      return;
    }

    const totalMin = (totalDuration / 60000).toFixed(1);
    let msg = `**에이전트 사용 현황** (${monthLabel})\n\n`;
    msg += lines.join('\n\n');
    msg += `\n\n**총합**: 턴 ${totalTurns}, 요청 ${totalRequests}회, 시간 ${totalMin}분`;

    await message.reply(msg);
    return;
  }
}

client.on('error', (err) => {
  orchestrator.log(`❌ Discord 에러: ${err.message}`);
});

module.exports = client;

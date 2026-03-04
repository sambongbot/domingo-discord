const { Client, Events, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const config = require('./config');
const orchestrator = require('./orchestrator');
const threadManager = require('./thread-manager');
const agentRunner = require('./agent-runner');
const sessionStore = require('./session-store');
const messageBuffer = require('./message-buffer');

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

  // 2. 에이전트 채널 생성/매핑
  for (const [agentKey, agent] of Object.entries(config.AGENTS)) {
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
  orchestrator.log('이벤트 리스너 등록 완료 — 대기 중');
});

client.on('messageCreate', async (message) => {
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

  // 지휘소 메시지
  if (channelId === config.COMMAND_CHANNEL_ID) {
    await orchestrator.handleCommandChannelMessage(message, message.guild);
    return;
  }

  // 에이전트 채널 메시지
  const agentKey = config.CHANNEL_MAP[channelId];
  if (agentKey) {
    await orchestrator.handleMessage(message, agentKey);
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
}

client.on('error', (err) => {
  orchestrator.log(`❌ Discord 에러: ${err.message}`);
});

module.exports = client;

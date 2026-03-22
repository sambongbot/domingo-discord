// src/chat-engine.js
// 도밍고왕국 에이전트 자율 대화 엔진
// EventEmitter 기반 오케스트레이터 — 에이전트들이 대화방에서 턴 돌아가며 대화
// 전하가 끼어들면 즉시 대화 이력에 삽입, 다음 턴에서 전하 말에 응답

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const agentRunner = require('./agent-runner');
const messageBuffer = require('./message-buffer');

const STATS_PATH = path.join(__dirname, '..', 'data', 'chat-stats.json');

class ChatEngine extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.history = [];           // [{ speaker, name, text, isUser }]
    this.participants = [];
    this.topic = '';
    this.turnIndex = 0;
    this.turnCount = 0;
    this.maxTurns = 50;
    this.chatWebhook = null;
    this.chatChannel = null;
    this.lastConversationEnd = 0;
    this.responseText = '';
    this.currentAgentKey = null;
    this._eventHandler = null;
    this._closeHandler = null;
    this._pendingUserMessage = null; // 전하 메시지 대기열
  }

  setChatChannel(channel, webhook) {
    this.chatChannel = channel;
    this.chatWebhook = webhook;
  }

  // 전하가 대화방에 메시지를 보냈을 때 호출
  injectUserMessage(userName, text) {
    // 대화 이력에 즉시 삽입
    this.history.push({
      speaker: 'user',
      name: `👑 ${userName}`,
      text,
      isUser: true,
    });

    // 전하 메시지 플래그 — 다음 턴에서 최우선 응답
    this._pendingUserMessage = { name: userName, text };

    // 대화가 진행 중이 아니면 자동 시작
    if (!this.active) {
      this.startConversation(text).catch(err => {
        console.error('[chat-engine] 전하 메시지로 대화 시작 실패:', err.message);
      });
    }
  }

  async startConversation(topic, participants, options = {}) {
    if (this.active) {
      return { error: '이미 대화가 진행 중입니다.' };
    }

    // 쿨다운 체크
    const cooldownMs = config.CHAT_CONFIG.cooldownMinutes * 60 * 1000;
    if (cooldownMs > 0) {
      const elapsed = Date.now() - this.lastConversationEnd;
      if (elapsed < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        return { error: `쿨다운 중입니다. ${remaining}분 후 다시 시도하세요.` };
      }
    }

    // 일일 대화 횟수 체크
    const stats = this._loadStats();
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats[today] || { conversations: 0, turns: 0 };
    if (config.CHAT_CONFIG.maxConversationsPerDay > 0 && todayStats.conversations >= config.CHAT_CONFIG.maxConversationsPerDay) {
      return { error: `오늘 대화 횟수 한도(${config.CHAT_CONFIG.maxConversationsPerDay}회) 초과` };
    }
    if (config.CHAT_CONFIG.maxDailyTurns > 0 && todayStats.turns >= config.CHAT_CONFIG.maxDailyTurns) {
      return { error: `오늘 턴 한도(${config.CHAT_CONFIG.maxDailyTurns}턴) 초과` };
    }

    if (!this.chatChannel || !this.chatWebhook) {
      return { error: '대화방 채널이 설정되지 않았습니다.' };
    }

    this.active = true;
    // injectUserMessage에서 이미 history에 넣었을 수 있으므로, 전하 메시지가 없을 때만 초기화
    if (!this._pendingUserMessage) {
      this.history = [];
    }
    this.topic = topic || '자유 대화';
    this.participants = participants || [...config.CHAT_CONFIG.defaultParticipants];
    this.turnIndex = 0;
    this.turnCount = 0;
    this.maxTurns = options.maxTurns || config.CHAT_CONFIG.maxTurnsPerConversation;

    // 가상 에이전트 등록
    for (const agentKey of this.participants) {
      const chatKey = `chat_${agentKey}`;
      const chatConfig = config.getChatAgentConfig(agentKey);
      if (chatConfig) {
        agentRunner.registerTempAgent(chatKey, chatConfig);
      }
    }

    this.emit('conversationStart', { topic: this.topic, participants: this.participants });

    // 첫 턴 시작 (비동기)
    this._runNextTurn().catch(err => {
      console.error('[chat-engine] 첫 턴 오류:', err.message);
    });

    return { ok: true, topic: this.topic, participants: this.participants };
  }

  async stopConversation(reason = '수동 중지') {
    if (!this.active) return;

    if (this.currentAgentKey) {
      agentRunner.kill(this.currentAgentKey);
      messageBuffer.cleanup(this.currentAgentKey);
    }

    await this._endConversation(reason);
  }

  async _runNextTurn() {
    if (!this.active) return;

    // 한도 체크 (0 = 무제한)
    if (this.maxTurns > 0 && this.turnCount >= this.maxTurns) {
      await this._endConversation('최대 턴 도달');
      return;
    }
    if (config.CHAT_CONFIG.maxDailyTurns > 0) {
      const stats = this._loadStats();
      const today = new Date().toISOString().split('T')[0];
      const todayStats = stats[today] || { conversations: 0, turns: 0 };
      if (todayStats.turns >= config.CHAT_CONFIG.maxDailyTurns) {
        await this._endConversation('일일 턴 한도 초과');
        return;
      }
    }

    const agentKey = this.participants[this.turnIndex];
    const chatKey = `chat_${agentKey}`;
    const agent = config.AGENTS[agentKey];
    if (!agent) {
      await this._endConversation(`에이전트 ${agentKey} 없음`);
      return;
    }

    this.currentAgentKey = chatKey;
    this.responseText = '';

    // messageBuffer를 대화방 웹훅으로 초기화
    const webhook = this.chatWebhook;
    const sendFn = async (t, c, senderName, senderAvatar) => {
      return webhook.send({
        content: c,
        username: senderName || agent.name,
        avatarURL: senderAvatar || agent.avatar || undefined,
      });
    };
    const editFn = async (m, c) => m.edit(c);
    messageBuffer.init(chatKey, this.chatChannel, sendFn, editFn, { webhook: true });

    // 프롬프트 구성
    const prompt = this._buildPrompt(agentKey);

    this._attachListeners(chatKey);

    this.emit('turn', {
      turn: this.turnCount + 1,
      speaker: agent.name,
      agentKey,
    });

    try {
      await agentRunner.sendMessage(chatKey, prompt);
    } catch (err) {
      console.error(`[chat-engine] ${chatKey} 오류:`, err.message);
    }
  }

  _attachListeners(chatKey) {
    this._detachListeners();

    this._eventHandler = (key, event) => {
      if (key !== chatKey) return;

      if (event.type === 'stream_event' && event.event) {
        const se = event.event;
        if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
          this.responseText += se.delta.text;
        }
      }

      if (event.type === 'result' && event.result && !this.responseText) {
        this.responseText = event.result;
      }
    };

    this._closeHandler = async (key, code) => {
      if (key !== chatKey) return;
      await this._onTurnComplete();
    };

    agentRunner.on('event', this._eventHandler);
    agentRunner.on('close', this._closeHandler);
  }

  _detachListeners() {
    if (this._eventHandler) {
      agentRunner.removeListener('event', this._eventHandler);
      this._eventHandler = null;
    }
    if (this._closeHandler) {
      agentRunner.removeListener('close', this._closeHandler);
      this._closeHandler = null;
    }
  }

  async _onTurnComplete() {
    if (!this.active) return;

    this._detachListeners();

    const agentKey = this.participants[this.turnIndex];
    const agent = config.AGENTS[agentKey];
    const text = this.responseText.trim();

    if (text) {
      this.history.push({
        speaker: agentKey,
        name: agent?.name || agentKey,
        text,
      });
    }

    this.turnCount++;
    this._recordTurn();

    // 종료 조건 — 최소 턴 보호
    const minTurns = config.CHAT_CONFIG.minTurnsBeforeEnd || 8;
    if (text.includes('[대화 끝]') && this.turnCount >= minTurns) {
      await this._endConversation('자연 종료');
      return;
    }

    // 전하 메시지가 있으면 삼봉이 먼저 응답 (1순위)
    if (this._pendingUserMessage) {
      this._pendingUserMessage = null;
      // 삼봉을 다음 화자로 강제 지정
      const sambongIdx = this.participants.indexOf('sambong');
      if (sambongIdx !== -1) {
        this.turnIndex = sambongIdx;
      } else {
        this.turnIndex = (this.turnIndex + 1) % this.participants.length;
      }
    } else {
      // 일반 라운드로빈
      this.turnIndex = (this.turnIndex + 1) % this.participants.length;
    }

    // 딜레이 후 다음 턴
    setTimeout(() => this._runNextTurn(), 3000);
  }

  async _endConversation(reason) {
    this.active = false;
    this.lastConversationEnd = Date.now();

    this._detachListeners();

    for (const agentKey of this.participants) {
      const chatKey = `chat_${agentKey}`;
      agentRunner.kill(chatKey);
      messageBuffer.cleanup(chatKey);
      agentRunner.unregisterTempAgent(chatKey);
    }

    this._recordConversation();

    this.emit('conversationEnd', {
      topic: this.topic,
      turns: this.turnCount,
      reason,
      participants: this.participants,
    });

    this.currentAgentKey = null;
    this._pendingUserMessage = null;
  }

  _buildPrompt(agentKey) {
    const agent = config.AGENTS[agentKey];
    const participantList = this.participants
      .map(k => {
        const a = config.AGENTS[k];
        return a ? `${a.name}(${a.emoji})` : k;
      })
      .join(', ');

    let historyText = '';
    if (this.history.length > 0) {
      const recent = this.history.slice(-10);
      historyText = recent.map(h => `${h.name}: "${h.text}"`).join('\n');
    }

    const lastMsg = this.history.length > 0
      ? this.history[this.history.length - 1]
      : null;

    // 전하 메시지가 있으면 프롬프트에 강조
    const userMsgNote = this._pendingUserMessage
      ? `\n\n⚠️ 전하(${this._pendingUserMessage.name})께서 대화방에 직접 말씀하셨습니다. 전하의 말씀에 최우선으로 정중하게 응답하세요.`
      : '';

    let prompt = `[대화방 모드]
당신은 도밍고 왕국의 ${agent.name}입니다.
대화방에서 동료들과 자유롭게 이야기하는 시간입니다.

참여자: ${participantList}
주제: ${this.topic}${userMsgNote}
`;

    if (historyText) {
      prompt += `\n[이전 대화]\n${historyText}\n`;
    }

    prompt += `
[규칙]
- 캐릭터 유지, 1-3문장 짧게
- 도구 사용 금지 (대화만)
- 전하(오세용 대표님)께서 말씀하시면 최우선으로 응답
- 다른 사람이 한 말에 반응하기 — 동의, 반박, 추가 질문, 내 관점 제시
- 대화를 자연스럽게 이어가기. 의견만 말하고 멈추지 말 것
- 질문을 던지거나 다른 의견에 도전하며 토론을 계속하기
- 충분히 오래 대화한 후 주제가 완전히 소진되었을 때만 "[대화 끝]" 포함`;

    if (lastMsg) {
      prompt += `\n\n${lastMsg.name}의 말: "${lastMsg.text}"`;
    } else {
      prompt += '\n\n대화를 시작해주세요.';
    }

    return prompt;
  }

  // 통계
  _loadStats() {
    try {
      return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    } catch {
      return {};
    }
  }

  _saveStats(stats) {
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
  }

  _recordTurn() {
    const stats = this._loadStats();
    const today = new Date().toISOString().split('T')[0];
    if (!stats[today]) stats[today] = { conversations: 0, turns: 0 };
    stats[today].turns++;
    this._saveStats(stats);
  }

  _recordConversation() {
    const stats = this._loadStats();
    const today = new Date().toISOString().split('T')[0];
    if (!stats[today]) stats[today] = { conversations: 0, turns: 0 };
    stats[today].conversations++;
    this._saveStats(stats);
  }

  getStatus() {
    const stats = this._loadStats();
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats[today] || { conversations: 0, turns: 0 };

    return {
      active: this.active,
      topic: this.active ? this.topic : null,
      turn: this.active ? this.turnCount : null,
      participants: this.active ? this.participants : null,
      todayConversations: todayStats.conversations,
      todayTurns: todayStats.turns,
    };
  }

  _getCooldownRemaining() {
    if (this.lastConversationEnd === 0) return 0;
    const cooldownMs = config.CHAT_CONFIG.cooldownMinutes * 60 * 1000;
    if (cooldownMs === 0) return 0;
    const remaining = cooldownMs - (Date.now() - this.lastConversationEnd);
    return remaining > 0 ? Math.ceil(remaining / 60000) : 0;
  }
}

module.exports = new ChatEngine();

// src/message-buffer.js
const config = require('./config');

class MessageBuffer {
  constructor() {
    // agentKey → { buffer, lastType, discordMessage, timer, thread, sendFn, editFn, webhook, currentSender }
    this.buffers = new Map();
  }

  // thread: Discord ThreadChannel에 전송하는 함수를 인자로 받음
  // sendFn: async (thread, content, senderName?, senderAvatar?) => Discord.Message
  // editFn: async (message, content) => void
  // options: { webhook: boolean }
  init(agentKey, thread, sendFn, editFn, options = {}) {
    this.buffers.set(agentKey, {
      buffer: '',
      lastType: null,
      discordMessage: null,
      timer: null,
      thread,
      sendFn,
      editFn,
      webhook: options.webhook || false,
      currentSender: null,  // { name, avatar } — Webhook 모드에서 현재 발화자
    });
  }

  async push(agentKey, type, content, sender = null) {
    const state = this.buffers.get(agentKey);
    if (!state) return;

    // Webhook 모드: sender 변경 시 즉시 플러시 (새 아바타로 전환)
    if (state.webhook && sender && state.currentSender?.name !== sender.name) {
      await this._flush(agentKey);
      state.currentSender = sender;
    }

    // 타입 변경 시 즉시 플러시
    if (state.lastType && state.lastType !== type) {
      await this._flush(agentKey);
    }

    // tool_result는 항상 새 메시지
    if (type === 'tool_result') {
      await this._flush(agentKey);
      const truncated = content.length > config.DISCORD_MAX_LENGTH
        ? content.substring(0, config.DISCORD_MAX_LENGTH) + '\n... (생략)'
        : content;
      if (truncated.trim()) {
        await state.sendFn(
          state.thread, `\`\`\`\n${truncated}\n\`\`\``,
          state.currentSender?.name,
          state.currentSender?.avatar
        );
      }
      return;
    }

    // error도 새 메시지
    if (type === 'error') {
      await this._flush(agentKey);
      await state.sendFn(
        state.thread, `❌ ${content}`,
        state.currentSender?.name,
        state.currentSender?.avatar
      );
      return;
    }

    // system도 새 메시지
    if (type === 'system') {
      await this._flush(agentKey);
      await state.sendFn(
        state.thread, `🔄 ${content}`,
        state.currentSender?.name,
        state.currentSender?.avatar
      );
      return;
    }

    state.lastType = type;
    state.buffer += content;

    // 1800자 초과 시 플러시 후 새 메시지로
    if (state.buffer.length > config.DISCORD_MAX_LENGTH) {
      await this._flush(agentKey);
      return;
    }

    // 타이머 기반 배치
    this._scheduleFlush(agentKey);
  }

  _scheduleFlush(agentKey) {
    const state = this.buffers.get(agentKey);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => this._flush(agentKey), config.BUFFER_FLUSH_MS);
  }

  async _flush(agentKey) {
    const state = this.buffers.get(agentKey);
    if (!state || !state.buffer) return;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const content = state.buffer;
    state.buffer = '';
    state.lastType = null;

    try {
      // Webhook 모드: 항상 새 메시지 (edit 제한 때문)
      if (state.webhook) {
        await state.sendFn(
          state.thread, content,
          state.currentSender?.name,
          state.currentSender?.avatar
        );
        state.discordMessage = null;
        return;
      }

      // 일반 모드: 기존 메시지 edit 시도
      if (state.discordMessage) {
        const existing = state.discordMessage.content || '';
        const merged = existing + content;
        if (merged.length <= config.DISCORD_MAX_LENGTH) {
          await state.editFn(state.discordMessage, merged);
          return;
        }
        // 초과 시 새 메시지
      }

      // 새 메시지 전송
      const msg = await state.sendFn(state.thread, content);
      state.discordMessage = msg;
    } catch (e) {
      console.error(`[message-buffer] flush 오류 (${agentKey}):`, e.message);
      // 에러 시 새 메시지 시도
      try {
        const msg = await state.sendFn(
          state.thread, content,
          state.currentSender?.name,
          state.currentSender?.avatar
        );
        state.discordMessage = state.webhook ? null : msg;
      } catch (e2) {
        console.error(`[message-buffer] 재시도 실패:`, e2.message);
      }
    }
  }

  async flushAll(agentKey) {
    await this._flush(agentKey);
  }

  // 새 작업 시작 시 버퍼 초기화
  reset(agentKey) {
    const state = this.buffers.get(agentKey);
    if (state) {
      if (state.timer) clearTimeout(state.timer);
      state.buffer = '';
      state.lastType = null;
      state.discordMessage = null;
      state.currentSender = null;
    }
  }

  cleanup(agentKey) {
    const state = this.buffers.get(agentKey);
    if (state?.timer) clearTimeout(state.timer);
    this.buffers.delete(agentKey);
  }
}

module.exports = new MessageBuffer();

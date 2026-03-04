// src/discord-formatter.js
// Claude Code stream-json 이벤트를 Discord 마크다운으로 변환
// partial messages 지원: 블록 인덱스 추적으로 중복 방지

// 에이전트별 상태 추적
// agentKey → { blockCount, textByIndex: Map<index, lastText> }
const agentState = new Map();

function getState(agentKey) {
  if (!agentState.has(agentKey)) {
    agentState.set(agentKey, { blockCount: 0, textByIndex: new Map() });
  }
  return agentState.get(agentKey);
}

function formatEvent(agentKey, event) {
  if (!event) return null;

  // assistant 텍스트 응답 (partial messages 포함)
  if (event.type === 'assistant' && event.message?.content) {
    const state = getState(agentKey);
    const blocks = event.message.content;
    const parts = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      if (block.type === 'thinking') continue;

      if (block.type === 'text' && block.text) {
        const prevText = state.textByIndex.get(i) || '';
        if (block.text.startsWith(prevText) && block.text.length > prevText.length) {
          // 기존 텍스트에 이어붙는 partial update
          const newPart = block.text.substring(prevText.length);
          state.textByIndex.set(i, block.text);
          if (newPart.trim()) parts.push(newPart);
        } else if (block.text !== prevText) {
          // 완전히 새로운 텍스트
          state.textByIndex.set(i, block.text);
          if (block.text.trim()) parts.push(block.text);
        }
      }

      if (block.type === 'tool_use') {
        // 새 블록일 때만 포맷 (이미 처리한 인덱스는 스킵)
        if (i >= state.blockCount) {
          parts.push(formatToolUse(block));
        }
      }
    }

    // 처리된 블록 수 갱신
    state.blockCount = blocks.length;

    return parts.length > 0 ? { type: 'text', content: parts.join('\n') } : null;
  }

  // result 이벤트: 턴 완료
  if (event.type === 'result') {
    resetTracking(agentKey);

    if (event.subtype === 'error_max_turns') {
      return { type: 'error', content: '최대 턴 수 초과' };
    }
    if (event.is_error) {
      return { type: 'error', content: event.result || '알 수 없는 오류' };
    }
    return null;
  }

  // 시스템 init
  if (event.type === 'system' && event.subtype === 'init') {
    return { type: 'system', content: `세션 시작 (${event.session_id?.substring(0, 8)}...)` };
  }

  return null;
}

function formatToolUse(block) {
  const name = block.name || 'Unknown';
  const input = block.input || {};

  switch (name) {
    case 'Bash':
      return `> **Bash**\n\`\`\`bash\n${truncate(input.command || '', 800)}\n\`\`\``;
    case 'Edit':
      return `> **Edit**: \`${input.file_path || '?'}\`\n\`\`\`diff\n-${truncate(input.old_string || '', 400)}\n+${truncate(input.new_string || '', 400)}\n\`\`\``;
    case 'Write':
      return `> **Write**: \`${input.file_path || '?'}\` (${(input.content || '').length}자)`;
    case 'Read':
      return `> **Read**: \`${input.file_path || '?'}\``;
    case 'Glob':
      return `> **Glob**: \`${input.pattern || '?'}\``;
    case 'Grep':
      return `> **Grep**: \`${input.pattern || '?'}\``;
    case 'WebSearch':
      return `> **WebSearch**: "${input.query || '?'}"`;
    case 'WebFetch':
      return `> **WebFetch**: ${input.url || '?'}`;
    case 'Agent':
      return `> **Agent** (${input.name || input.subagent_type || '?'}): ${truncate(input.description || '', 100)}`;
    default:
      return `> **${name}**`;
  }
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.substring(0, max) + '\n... (생략)';
}

function resetTracking(agentKey) {
  agentState.delete(agentKey);
}

module.exports = { formatEvent, formatToolUse, truncate, resetTracking };

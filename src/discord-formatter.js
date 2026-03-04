// src/discord-formatter.js
// Claude Code stream-json 이벤트를 Discord 마크다운으로 변환
// stream_event (text_delta)로 실시간 텍스트 스트리밍
// assistant 이벤트에서 tool_use 블록 추출 (완전한 input 포함)

// 텍스트가 stream_event로 이미 스트리밍되었는지 추적
const hasStreamedText = new Map();

function formatEvent(agentKey, event) {
  if (!event) return null;

  // ── stream_event: 실시간 토큰 스트리밍 ──
  if (event.type === 'stream_event' && event.event) {
    const se = event.event;

    // 텍스트 delta → 즉시 push (버퍼가 2초 배치)
    if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
      hasStreamedText.set(agentKey, true);
      return { type: 'text', content: se.delta.text };
    }

    return null;
  }

  // ── assistant: 완성된 메시지 (턴별 1회) ──
  if (event.type === 'assistant' && event.message?.content) {
    const streamed = hasStreamedText.get(agentKey);
    hasStreamedText.delete(agentKey);

    const parts = [];
    for (const block of event.message.content) {
      if (block.type === 'thinking') continue;

      // 텍스트: stream_event로 이미 보냈으면 스킵
      if (block.type === 'text' && block.text && !streamed) {
        if (block.text.trim()) parts.push(block.text);
      }

      // tool_use: 완전한 input으로 포맷
      if (block.type === 'tool_use') {
        parts.push(formatToolUse(block));
      }
    }

    return parts.length > 0 ? { type: 'text', content: parts.join('\n') } : null;
  }

  // ── result: 턴 완료 ──
  if (event.type === 'result') {
    hasStreamedText.delete(agentKey);

    if (event.subtype === 'error_max_turns') {
      return { type: 'error', content: '최대 턴 수 초과' };
    }
    if (event.is_error) {
      return { type: 'error', content: event.result || '알 수 없는 오류' };
    }
    return null;
  }

  // ── system init ──
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
  hasStreamedText.delete(agentKey);
}

module.exports = { formatEvent, formatToolUse, truncate, resetTracking };

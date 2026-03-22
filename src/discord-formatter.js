// src/discord-formatter.js
// Claude Code stream-json 이벤트를 Discord 마크다운으로 변환
// stream_event (text_delta)로 실시간 텍스트 스트리밍
// assistant 이벤트에서 tool_use 블록 추출 (완전한 input 포함)
// 서브에이전트 (Agent tool) 감지 → sender 정보 반환

const config = require('./config');
const agentRunner = require('./agent-runner');

// 에이전트 조회: AGENTS → tempAgents 순서
function getAgent(agentKey) {
  return config.AGENTS[agentKey] || agentRunner.tempAgents.get(agentKey) || null;
}

// 텍스트가 stream_event로 이미 스트리밍되었는지 추적
const hasStreamedText = new Map();

// Agent tool_use_id → { name, emoji, avatar } (서브에이전트 추적)
const activeSubagents = new Map();

function formatEvent(agentKey, event) {
  if (!event) return null;

  // ── stream_event: 실시간 토큰 스트리밍 ──
  if (event.type === 'stream_event' && event.event) {
    const se = event.event;

    // 텍스트 delta → 즉시 push (버퍼가 2초 배치)
    if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
      hasStreamedText.set(agentKey, true);

      // 서브에이전트 텍스트인지 확인 (parent_tool_use_id)
      if (event.parent_tool_use_id) {
        const sub = activeSubagents.get(event.parent_tool_use_id);
        if (sub) {
          return { type: 'text', content: se.delta.text, sender: { name: sub.name, avatar: sub.avatar } };
        }
      }

      // 메인 에이전트 텍스트
      const agent = getAgent(agentKey);
      return { type: 'text', content: se.delta.text, sender: { name: agent?.name, avatar: agent?.avatar } };
    }

    return null;
  }

  // ── assistant: 완성된 메시지 (턴별 1회) ──
  if (event.type === 'assistant' && event.message?.content) {
    const streamed = hasStreamedText.get(agentKey);
    hasStreamedText.delete(agentKey);

    const agent = getAgent(agentKey);
    const mainSender = { name: agent?.name, avatar: agent?.avatar };
    const results = [];

    for (const block of event.message.content) {
      if (block.type === 'thinking') continue;

      // 텍스트: stream_event로 이미 보냈으면 스킵
      if (block.type === 'text' && block.text && !streamed) {
        if (block.text.trim()) {
          results.push({ type: 'text', content: block.text, sender: mainSender });
        }
      }

      // tool_use: 완전한 input으로 포맷
      if (block.type === 'tool_use') {
        const formatted = formatToolUse(block, agentKey);
        if (formatted) {
          results.push({ type: 'text', content: formatted, sender: mainSender });
        }
      }

      // tool_result: Agent tool 결과 → 서브에이전트 sender로 표시
      if (block.type === 'tool_result' && block.tool_use_id) {
        const sub = activeSubagents.get(block.tool_use_id);
        if (sub) {
          const result = typeof block.content === 'string'
            ? block.content : JSON.stringify(block.content);
          const truncated = truncate(result, 500);
          if (truncated.trim()) {
            results.push({
              type: 'text',
              content: truncated,
              sender: { name: sub.name, avatar: sub.avatar },
            });
          }
          activeSubagents.delete(block.tool_use_id);
        }
      }
    }

    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    return results;  // 배열: orchestrator에서 각각 push
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

  // ── system init: 로그에만 남기고 디스코드에는 표시 안 함 ──
  if (event.type === 'system' && event.subtype === 'init') {
    return null;
  }

  return null;
}

function formatToolUse(block, agentKey) {
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
    case 'Agent': {
      const subName = input.name || input.description || '?';
      const profile = config.SUBAGENT_PROFILES[subName] || {};
      const parentAgent = getAgent(agentKey);

      // 서브에이전트 추적 등록
      if (block.id) {
        activeSubagents.set(block.id, {
          name: subName,
          emoji: profile.emoji || '🤖',
          avatar: profile.avatar || null,
        });
      }

      const desc = truncate(input.prompt || input.description || '', 200);
      return `**${parentAgent?.name || '?'} → ${subName}:**\n> ${desc}`;
    }
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
  activeSubagents.clear();
}

module.exports = { formatEvent, formatToolUse, truncate, resetTracking };

// src/agent-runner.js
// Claude CLI 프로세스 래퍼
// 전략: 메시지마다 새 프로세스 spawn + --resume으로 세션 유지
// stream-json 출력으로 실시간 스트리밍

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');
const config = require('./config');
const sessionStore = require('./session-store');

class AgentRunner extends EventEmitter {
  constructor() {
    super();
    // agentKey → { process, idleTimer, startedAt, busy }
    this.processes = new Map();
    // 메시지 큐: agentKey → [{ text, resolve, reject }]
    this.queues = new Map();
    // 가상 에이전트 (대화방 등): key → agentConfig
    this.tempAgents = new Map();
  }

  registerTempAgent(key, agentConfig) {
    this.tempAgents.set(key, agentConfig);
  }

  unregisterTempAgent(key) {
    this.tempAgents.delete(key);
  }

  // 메시지를 에이전트에 전달 (큐잉)
  async sendMessage(agentKey, text) {
    // 큐 초기화
    if (!this.queues.has(agentKey)) {
      this.queues.set(agentKey, []);
    }

    return new Promise((resolve, reject) => {
      this.queues.get(agentKey).push({ text, resolve, reject });
      this._processQueue(agentKey);
    });
  }

  async _processQueue(agentKey) {
    const entry = this.processes.get(agentKey);
    // 이미 처리 중이면 대기
    if (entry?.busy) return;

    const queue = this.queues.get(agentKey);
    if (!queue || queue.length === 0) return;

    const { text, resolve, reject } = queue.shift();

    // LRU 교체: 다른 에이전트가 최대 수 이상이면
    const runningCount = [...this.processes.values()].filter(e => e.busy).length;
    if (runningCount >= config.MAX_CONCURRENT_PROCESSES) {
      this._killLRU(agentKey);
    }

    try {
      await this._spawnAndRun(agentKey, text);
      resolve();
    } catch (err) {
      reject(err);
    }
  }

  async _spawnAndRun(agentKey, text) {
    const agent = config.AGENTS[agentKey] || this.tempAgents.get(agentKey);
    if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

    const session = sessionStore.get(agentKey);
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', agent.model,
      '--agent', agent.agent,
      '--dangerously-skip-permissions',
      '--append-system-prompt', `CRITICAL: 당신은 "${agent.name}" 에이전트입니다. --agent ${agent.agent} 프로필을 따르세요. 다른 캐릭터(삼봉 등) 설정은 무시하세요.`,
    ];

    // maxTurns 지원 (대화방: 도구 사용 차단)
    if (agent.maxTurns) {
      args.push('--max-turns', String(agent.maxTurns));
    }

    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
    }

    // 프롬프트는 인자로 전달
    args.push(text);

    // Claude Code 중첩 방지
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

    console.log(`[${new Date().toISOString()}] [spawn] ${agentKey}: ${config.CLAUDE_PATH} ${args.join(' ').substring(0, 200)}`);

    return new Promise((resolve, reject) => {
      const child = spawn(config.CLAUDE_PATH, args, {
        cwd: agent.cwd,
        env: cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const entry = {
        process: child,
        idleTimer: null,
        startedAt: Date.now(),
        busy: true,
      };
      this.processes.set(agentKey, entry);
      this.emit('spawn', agentKey);

      // NDJSON 파서
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          // result 이벤트는 비용 추적용으로 전체 필드 확인 (500자)
          const logLimit = event.type === 'result' ? 500 : 120;
          console.log(`[${new Date().toISOString()}] [stdout] ${agentKey}: ${line.substring(0, logLimit)}`);
          this.emit('event', agentKey, event);

          // session_id 캡처
          if (event.session_id) {
            sessionStore.set(agentKey, { sessionId: event.session_id });
          }
          sessionStore.updateActivity(agentKey);
        } catch (e) {
          // JSON 파싱 실패 — 원본 로그만
          console.log(`[${new Date().toISOString()}] [stdout] ${agentKey}: ${line.substring(0, 120)}`);
        }
      });

      child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log(`[${new Date().toISOString()}] [stderr] ${agentKey}: ${msg.substring(0, 300)}`);
          this.emit('stderr', agentKey, msg);
        }
      });

      child.on('close', (code) => {
        entry.busy = false;
        this.emit('close', agentKey, code);

        // 세션 에러 시 리셋
        if (code !== 0) {
          const session = sessionStore.get(agentKey);
          if (session?.sessionId) {
            // resume 실패 가능성 → 다음 시도 시 새 세션
            sessionStore.clearSession(agentKey);
          }
          reject(new Error(`Claude exit code ${code}`));
        } else {
          resolve();
        }

        // 큐에 남은 메시지 처리
        this._processQueue(agentKey);
      });

      child.on('error', (err) => {
        entry.busy = false;
        this.emit('error', agentKey, err);
        this.processes.delete(agentKey);
        reject(err);
      });
    });
  }

  kill(agentKey) {
    const entry = this.processes.get(agentKey);
    if (entry) {
      if (entry.process && !entry.process.killed) {
        entry.process.kill('SIGTERM');
      }
      this.processes.delete(agentKey);
      this.emit('killed', agentKey);
    }
    // 큐 비우기
    this.queues.delete(agentKey);
  }

  _killLRU(excludeKey) {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.processes) {
      if (key === excludeKey) continue;
      if (entry.busy) continue; // 바쁜 프로세스는 건드리지 않음
      const session = sessionStore.get(key);
      const lastActivity = session?.lastActivity || entry.startedAt;
      if (lastActivity < oldestTime) {
        oldestTime = lastActivity;
        oldest = key;
      }
    }
    if (oldest) {
      this.emit('lru-evict', oldest);
      this.kill(oldest);
    }
  }

  isRunning(agentKey) {
    const entry = this.processes.get(agentKey);
    return entry?.busy || false;
  }

  getStatus() {
    const status = {};
    for (const [key, entry] of this.processes) {
      const session = sessionStore.get(key);
      status[key] = {
        running: entry.busy,
        pid: entry.process?.pid || null,
        startedAt: entry.startedAt,
        sessionId: session?.sessionId || null,
        lastActivity: session?.lastActivity || null,
        queueLength: this.queues.get(key)?.length || 0,
      };
    }
    // 큐만 있고 프로세스 없는 에이전트도 표시
    for (const [key, queue] of this.queues) {
      if (!status[key] && queue.length > 0) {
        const session = sessionStore.get(key);
        status[key] = {
          running: false,
          pid: null,
          startedAt: null,
          sessionId: session?.sessionId || null,
          lastActivity: session?.lastActivity || null,
          queueLength: queue.length,
        };
      }
    }
    return status;
  }
}

module.exports = new AgentRunner();

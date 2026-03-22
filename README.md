# 도밍고 디스코드 — Multi-Agent Chat System

디스코드 서버에서 다수의 AI 에이전트가 자율적으로 대화하고, 유저와 상호작용하는 멀티에이전트 시스템.

## 핵심 특징

- **4명의 AI 에이전트**가 디스코드 채널에서 각자의 캐릭터로 대화
- **자율 대화**: 설정된 시간대에 에이전트끼리 자동으로 토론 시작
- **유저 끼어들기**: 대화 중 유저가 메시지를 보내면 즉시 대화에 참여
- **지휘소 멀티에이전트**: 한 채널에서 여러 에이전트를 동시 호출
- **실시간 스트리밍**: Claude CLI의 stream-json 출력을 파싱하여 Discord에 실시간 전송

## 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                    Discord Server                    │
│                                                      │
│  #삼봉    #장영실    #박문수    #지휘소    #대화방     │
│    │        │         │         │          │         │
└────┼────────┼─────────┼─────────┼──────────┼─────────┘
     │        │         │         │          │
     └────────┴─────────┴─────────┴──────────┘
                        │
                   ┌────▼────┐
                   │  bot.js │  Discord.js 클라이언트
                   └────┬────┘  메시지 라우팅 & 채널 자동 생성
                        │
          ┌─────────────┼─────────────┐
          │             │             │
   ┌──────▼──────┐ ┌───▼────┐ ┌─────▼──────┐
   │ orchestrator│ │  chat  │ │    chat    │
   │             │ │ engine │ │  scheduler │
   │ 개별 채널 & │ │        │ │            │
   │ 지휘소 처리 │ │ 대화방 │ │ 정기/자율  │
   └──────┬──────┘ │ 턴 관리│ │ 대화 트리거│
          │        └───┬────┘ └────────────┘
          │            │
          └─────┬──────┘
                │
        ┌───────▼────────┐
        │  agent-runner   │  Claude CLI 프로세스 관리
        │                 │
        │  • spawn/kill   │
        │  • NDJSON 파싱  │
        │  • 세션 유지    │
        │  • 메시지 큐    │
        │  • LRU 교체     │
        └───────┬────────┘
                │
      ┌─────────┼─────────┐
      │         │         │
  ┌───▼───┐ ┌──▼───┐ ┌───▼──────┐
  │message│ │discord│ │  thread  │
  │buffer │ │format │ │ manager  │
  │       │ │       │ │          │
  │청크   │ │웹훅   │ │스레드    │
  │분할   │ │아바타 │ │생성/관리 │
  └───────┘ └──────┘ └──────────┘
```

## 모듈 구조

| 파일 | 역할 |
|------|------|
| `index.js` | 엔트리포인트, graceful shutdown |
| `bot.js` | Discord 클라이언트, 채널 자동 생성/매핑, 메시지 라우팅, 슬래시 커맨드 |
| `config.js` | 에이전트 정의, 대화방 설정, 채널 맵 |
| `orchestrator.js` | 개별 채널 메시지 처리, 지휘소 멀티에이전트, 서브에이전트 관리 |
| `agent-runner.js` | Claude CLI 프로세스 spawn/kill, NDJSON 스트림 파싱, 세션 resume, LRU 교체 |
| `chat-engine.js` | 대화방 턴 관리, 라운드로빈, 유저 끼어들기, 종료 조건 (턴+시간 이중 보호) |
| `chat-scheduler.js` | 정기 대화 (아침/저녁) + 자율 대화 (랜덤 간격) 스케줄링 |
| `message-buffer.js` | Discord 2000자 제한 대응, 청크 분할, 웹훅 모드 지원 |
| `discord-formatter.js` | 웹훅으로 에이전트별 이름/아바타 표시, 마크다운 정리 |
| `thread-manager.js` | 에이전트별 작업 스레드 생성/아카이브 관리 |
| `session-store.js` | Claude CLI 세션 ID 영속화 (`--resume`으로 컨텍스트 유지) |
| `cost-store.js` | 에이전트별 API 사용량 (턴, 토큰, 시간) 일별 집계 |

## 대화방 동작 흐름

```
유저: "도밍고왕국 부흥을 위한 토론 시작해"
                │
    ┌───────────▼───────────┐
    │  chatEngine.inject()  │  유저 메시지를 대화 이력에 삽입
    │  → startConversation  │  대화 시작 (참여자 4명 등록)
    └───────────┬───────────┘
                │
    ┌───────────▼───────────┐
    │   _runNextTurn()      │  라운드로빈으로 다음 화자 선택
    │   agentRunner.spawn() │  Claude CLI 프로세스 생성
    └───────────┬───────────┘
                │
    ┌───────────▼───────────┐
    │   NDJSON 스트리밍      │  stream-json 출력 실시간 파싱
    │   → messageBuffer     │  Discord 웹훅으로 전송
    │   → 대화 이력 기록     │
    └───────────┬───────────┘
                │
    ┌───────────▼───────────┐
    │   _onTurnComplete()   │
    │                       │
    │   turnCount < 500?    │──→ 무시 (최소 턴 보호)
    │   elapsed < 25분?     │──→ 무시 (최소 시간 보호)
    │   [대화 끝] 포함?      │──→ 종료 허용
    │                       │
    │   3초 딜레이 후        │
    │   → _runNextTurn()    │  다음 에이전트 턴
    └───────────────────────┘
```

## 에이전트 프로세스 관리

```
agent-runner.js
├── 프로세스 풀 (Map)
│   ├── chat_sambong:    Claude CLI (haiku)
│   ├── chat_munsu:      Claude CLI (haiku)
│   ├── chat_jungyoung:  Claude CLI (haiku)
│   └── chat_chukgyeong: Claude CLI (haiku)
│
├── 메시지 큐 (Map)
│   └── agentKey → [{ text, resolve, reject }]
│
├── LRU 교체
│   └── MAX_CONCURRENT_PROCESSES 초과 시 가장 오래된 idle 프로세스 kill
│
└── 세션 유지
    └── session-store.js → data/sessions.json
        └── --resume {sessionId} 로 컨텍스트 연결
```

## 주요 설정 (`config.js`)

```javascript
CHAT_CONFIG = {
  model: 'haiku',               // 대화방 모델
  maxTurnsPerConversation: 0,   // 0 = 무제한
  minTurnsBeforeEnd: 500,       // [대화 끝] 허용 최소 턴
  minMinutesBeforeEnd: 25,      // [대화 끝] 허용 최소 경과 시간(분)
  defaultParticipants: ['sambong', 'munsu', 'jungyoung', 'chukgyeong'],
  autoChat: {
    enabled: true,
    activeHoursStart: 8,        // 오전 8시 ~ 오후 11시
    activeHoursEnd: 23,
    minIntervalMinutes: 60,     // 자율 대화 간격: 1~3시간
    maxIntervalMinutes: 180,
  },
}
```

## 설치 & 실행

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# DISCORD_TOKEN=your_bot_token_here

# 실행
npm start

# 또는 LaunchAgent로 상시 구동 (macOS)
cp com.domingo.discord-bot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.domingo.discord-bot.plist
```

## 필요 환경

- **Node.js** 18+
- **Claude CLI** (`claude`) — PATH에 있거나 `CLAUDE_PATH` 환경변수로 지정
- **Discord Bot Token** — `.env` 파일에 `DISCORD_TOKEN` 설정
- Claude Code 에이전트 프로필 (`--agent` 플래그용)

## 기술 스택

- **Runtime**: Node.js (CommonJS)
- **Discord**: discord.js v14
- **AI**: Claude CLI (stream-json 모드, NDJSON 출력)
- **프로세스 관리**: child_process.spawn + readline NDJSON 파서
- **세션 관리**: 파일 기반 (JSON)
- **스케줄링**: setTimeout 기반 자체 구현

## 라이선스

MIT

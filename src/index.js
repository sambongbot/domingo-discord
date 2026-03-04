const config = require('./config');
const client = require('./bot');
const agentRunner = require('./agent-runner');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function gracefulShutdown(signal) {
  log(`${signal} 수신 — 종료 중...`);

  const status = agentRunner.getStatus();
  for (const key of Object.keys(status)) {
    agentRunner.kill(key);
  }

  client.destroy();

  log('종료 완료');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log(`❌ uncaughtException: ${err.message}`);
  log(err.stack);
});
process.on('unhandledRejection', (err) => {
  log(`❌ unhandledRejection: ${err}`);
});

log('도밍고 디스코드 봇 시작...');
client.login(config.DISCORD_TOKEN).catch((err) => {
  log(`❌ 로그인 실패: ${err.message}`);
  process.exit(1);
});

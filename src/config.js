// src/config.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_PATH = '/opt/homebrew/bin/claude';
const HOME_DIR = '/Users/sambong';

const AGENTS = {
  sambong: {
    name: '삼봉',
    emoji: '🏯',
    agent: 'sambong',
    model: 'opus',
    cwd: HOME_DIR,
  },
  jangyoungsil: {
    name: '장영실',
    emoji: '⚙️',
    agent: 'jangyoungsil',
    model: 'sonnet',
    cwd: HOME_DIR,
  },
  munsu: {
    name: '박문수',
    emoji: '🔍',
    agent: 'munsu',
    model: 'sonnet',
    cwd: HOME_DIR,
  },
};

let CHANNEL_MAP = {};
let COMMAND_CHANNEL_ID = null;
let SYSTEM_LOG_CHANNEL_ID = null;

const MAX_CONCURRENT_PROCESSES = 2;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const THREAD_ARCHIVE_MS = 60 * 60 * 1000;
const BUFFER_FLUSH_MS = 2000;
const DISCORD_MAX_LENGTH = 1800;

module.exports = {
  DISCORD_TOKEN,
  CLAUDE_PATH,
  HOME_DIR,
  AGENTS,
  CHANNEL_MAP,
  COMMAND_CHANNEL_ID,
  SYSTEM_LOG_CHANNEL_ID,
  MAX_CONCURRENT_PROCESSES,
  IDLE_TIMEOUT_MS,
  THREAD_ARCHIVE_MS,
  BUFFER_FLUSH_MS,
  DISCORD_MAX_LENGTH,
  setChannelMap(map) { CHANNEL_MAP = map; module.exports.CHANNEL_MAP = map; },
  setCommandChannel(id) { COMMAND_CHANNEL_ID = id; module.exports.COMMAND_CHANNEL_ID = id; },
  setSystemLogChannel(id) { SYSTEM_LOG_CHANNEL_ID = id; module.exports.SYSTEM_LOG_CHANNEL_ID = id; },
};

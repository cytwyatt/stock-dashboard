'use strict';

const path = require('node:path');

function normalizeLLMBaseUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('invalid LLM base URL');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function createLLMConfigStore({ dataDir, fs, jsonFile, env = {} }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (!fs || !jsonFile || !env) throw new TypeError('fs, jsonFile and env are required');

  const file = path.join(dataDir, 'llm.json');
  jsonFile.protectDataFile(file);

  function getStoredLLMConfig() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return {}; }
  }

  function getLLMConfig() {
    const config = getStoredLLMConfig();
    const rawBaseUrl = env.LLM_BASE_URL || config.baseUrl || 'https://api.deepseek.com/v1';
    let baseUrl;
    try { baseUrl = normalizeLLMBaseUrl(rawBaseUrl); }
    catch { baseUrl = String(rawBaseUrl).trim().replace(/\/+$/, ''); }
    return {
      baseUrl,
      apiKey: env.LLM_API_KEY || config.apiKey || '',
      model: env.LLM_MODEL || config.model || 'deepseek-chat',
    };
  }

  function writeLLMConfig(config) {
    jsonFile.writeDataJSON(file, config);
  }

  return {
    file,
    getStoredLLMConfig,
    getLLMConfig,
    writeLLMConfig,
    normalizeLLMBaseUrl,
  };
}

module.exports = { createLLMConfigStore, normalizeLLMBaseUrl };

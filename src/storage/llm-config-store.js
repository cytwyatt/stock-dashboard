'use strict';

const path = require('node:path');

const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_LLM_MODEL = 'deepseek-v4-flash';
const DEFAULT_DEEPSEEK_REVIEW_MODEL = 'deepseek-v4-flash';

function normalizeLLMBaseUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('invalid LLM base URL');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function isOfficialDeepSeekBaseUrl(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function defaultMarketReviewModel(baseUrl, model) {
  return isOfficialDeepSeekBaseUrl(baseUrl) ? DEFAULT_DEEPSEEK_REVIEW_MODEL : model;
}

function createLLMConfigStore({ dataDir, fs, jsonFile, env = {} }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (!fs || !jsonFile || !env) throw new TypeError('fs, jsonFile and env are required');

  const file = path.join(dataDir, 'llm.json');
  jsonFile.protectDataFile(file);

  function getStoredLLMConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch { return {}; }
  }

  function getAPIConfig() {
    const config = getStoredLLMConfig();
    const rawBaseUrl = env.LLM_BASE_URL || config.baseUrl || DEFAULT_LLM_BASE_URL;
    let baseUrl;
    try { baseUrl = normalizeLLMBaseUrl(rawBaseUrl); }
    catch { baseUrl = String(rawBaseUrl).trim().replace(/\/+$/, ''); }
    const storedModel = typeof config.model === 'string' ? config.model.trim() : '';
    const model = env.LLM_MODEL || storedModel || DEFAULT_LLM_MODEL;
    const storedMarketReviewModel = typeof config.marketReviewModel === 'string'
      ? config.marketReviewModel.trim()
      : '';
    const fallbackMarketReviewModel = model;
    const implicitMarketReviewModel = storedModel
      ? fallbackMarketReviewModel
      : defaultMarketReviewModel(baseUrl, model);
    const marketReviewModel = env.LLM_MARKET_REVIEW_MODEL
      || (env.LLM_MODEL
        ? model
        : storedMarketReviewModel || implicitMarketReviewModel);
    return {
      baseUrl,
      apiKey: env.LLM_API_KEY || config.apiKey || '',
      model,
      marketReviewModel,
      fallbackMarketReviewModel,
    };
  }

  function getLLMConfig() {
    const config = getStoredLLMConfig();
    const transport = env.LLM_TRANSPORT || config.transport || 'api';
    if (!['api', 'codex'].includes(transport)) throw new Error('LLM_TRANSPORT 必须为 api 或 codex');
    if (transport !== 'codex') return getAPIConfig();
    const model = env.LLM_MODEL || config.codexModel || 'gpt-5.6-luna';
    return {
      transport: 'codex', baseUrl: '', apiKey: '', model,
      marketReviewModel: env.LLM_MARKET_REVIEW_MODEL || env.LLM_MODEL || config.codexMarketReviewModel || model,
      fallbackMarketReviewModel: model,
      codexEffort: ['low', 'medium', 'high'].includes(config.codexEffort) ? config.codexEffort : 'low',
    };
  }

  function writeLLMConfig(config) {
    jsonFile.writeDataJSON(file, config);
  }

  return {
    file,
    getStoredLLMConfig,
    getLLMConfig,
    getAPIConfig,
    writeLLMConfig,
    normalizeLLMBaseUrl,
  };
}

module.exports = {
  createLLMConfigStore,
  normalizeLLMBaseUrl,
  defaultMarketReviewModel,
  isOfficialDeepSeekBaseUrl,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_DEEPSEEK_REVIEW_MODEL,
};

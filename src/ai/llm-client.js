'use strict';

function normalizeLLMBaseUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('invalid LLM base URL');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = [
    ['promptTokens', value.prompt_tokens],
    ['completionTokens', value.completion_tokens],
    ['reasoningTokens', value.completion_tokens_details?.reasoning_tokens],
    ['totalTokens', value.total_tokens],
  ].map(([key, raw]) => [key, normalizeTokenCount(raw)])
    .filter(([, count]) => count != null);
  return entries.length ? Object.fromEntries(entries) : null;
}

function isOfficialDeepSeekV4(config) {
  try {
    return new URL(String(config?.baseUrl || '')).hostname.toLowerCase() === 'api.deepseek.com'
      && /^deepseek-v4-(?:flash|pro)$/.test(String(config?.model || ''));
  } catch {
    return false;
  }
}

function createLLMClient({ fetchImpl = global.fetch, now = Date.now } = {}) {
  async function testConfig(cfg) {
    if (!cfg.apiKey) return { ok: false, message: '尚未填写 API Key' };
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '只需回复两个字：OK' }],
          max_tokens: 16,
          temperature: 0,
          ...(isOfficialDeepSeekV4(cfg) ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        return { ok: false, message: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      }
      const json = await res.json();
      const choice = json.choices?.[0];
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';
      const reply = String(choice?.message?.content || '').trim();
      if (finishReason && finishReason !== 'stop') {
        return { ok: false, message: `${cfg.model} 测试异常结束：${finishReason}` };
      }
      if (!reply) return { ok: false, message: `${cfg.model} 返回空内容` };
      return { ok: true, message: `连接成功，${cfg.model} 回复：${reply.slice(0, 30)}` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  async function complete(cfg, messages, tools, options = {}) {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const officialDeepSeekV4 = isOfficialDeepSeekV4(cfg);
    const requestedThinking = options.thinking === 'enabled' || options.thinking === 'disabled'
      ? options.thinking
      : '';
    const thinking = requestedThinking || (officialDeepSeekV4 ? 'disabled' : '');
    const thinkingEnabled = thinking === 'enabled';
    const reasoningEffort = options.reasoningEffort === 'high' || options.reasoningEffort === 'max'
      ? options.reasoningEffort
      : '';
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(Math.floor(options.timeoutMs), 600000)
      : 120000;
    const payload = {
      model: cfg.model,
      messages,
      ...(options.omitTemperature || (officialDeepSeekV4 && thinkingEnabled)
        ? {}
        : { temperature: options.temperature == null ? 0.3 : options.temperature }),
      ...(options.maxTokens == null ? {} : { max_tokens: options.maxTokens }),
      ...(thinking ? { thinking: { type: thinking } } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(hasTools ? {
        tools,
        ...(officialDeepSeekV4 && thinkingEnabled ? {} : { tool_choice: 'auto' }),
      } : {}),
    };
    const startedAt = now();
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`LLM 接口返回 ${res.status}: ${body}`);
    }
    const json = await res.json();
    const choice = json.choices && json.choices[0];
    if (!choice || !choice.message || typeof choice.message !== 'object') {
      throw new Error('LLM 返回格式异常');
    }
    const message = officialDeepSeekV4 && thinkingEnabled
      && Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length
      && choice.message.content == null
      ? { ...choice.message, content: '' }
      : choice.message;
    if (!options.includeMeta) return message;
    return {
      ...message,
      _completionMeta: {
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        model: typeof json.model === 'string' ? json.model : cfg.model,
        usage: normalizeUsage(json.usage),
        durationMs: Math.max(0, now() - startedAt),
      },
    };
  }

  return { testConfig, complete };
}

module.exports = {
  normalizeLLMBaseUrl,
  normalizeUsage,
  isOfficialDeepSeekV4,
  createLLMClient,
};

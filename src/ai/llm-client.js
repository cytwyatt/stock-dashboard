'use strict';

function normalizeLLMBaseUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('invalid LLM base URL');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function createLLMClient({ fetchImpl = global.fetch } = {}) {
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
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        return { ok: false, message: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      }
      const json = await res.json();
      const reply = json.choices?.[0]?.message?.content || '';
      return { ok: true, message: `连接成功，${cfg.model} 回复：${reply.slice(0, 30) || '(空)'}` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  async function complete(cfg, messages, tools) {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`LLM 接口返回 ${res.status}: ${body}`);
    }
    const json = await res.json();
    if (!json.choices || !json.choices[0]) throw new Error('LLM 返回格式异常');
    return json.choices[0].message;
  }

  return { testConfig, complete };
}

module.exports = { normalizeLLMBaseUrl, createLLMClient };

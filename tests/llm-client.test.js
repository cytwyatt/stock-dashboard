'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLLMClient } = require('../src/ai/llm-client');

const cfg = {
  baseUrl: 'https://llm.example/v1',
  apiKey: 'test-key',
  model: 'test-model',
};
const messages = [{ role: 'user', content: 'hello' }];

function jsonResponse(message = { role: 'assistant', content: 'ok' }) {
  return {
    ok: true,
    async json() {
      return { choices: [{ message }] };
    },
  };
}

test('complete 在 tools 为 null 或空数组时省略工具字段并映射 options', async () => {
  const requests = [];
  const client = createLLMClient({
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse();
    },
  });

  await client.complete(cfg, messages, null);
  await client.complete(cfg, messages, [], { temperature: 0, maxTokens: 0 });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, {
    model: 'test-model',
    messages,
    temperature: 0.3,
  });
  assert.equal(Object.hasOwn(requests[0].body, 'tools'), false);
  assert.equal(Object.hasOwn(requests[0].body, 'tool_choice'), false);

  assert.deepEqual(requests[1].body, {
    model: 'test-model',
    messages,
    temperature: 0,
    max_tokens: 0,
  });
  assert.equal(Object.hasOwn(requests[1].body, 'tools'), false);
  assert.equal(Object.hasOwn(requests[1].body, 'tool_choice'), false);
});

test('complete 在 tools 非空时发送 tools 与自动工具选择并返回首条消息', async () => {
  const tools = [{ type: 'function', function: { name: 'get_quote' } }];
  const expected = { role: 'assistant', content: null, tool_calls: [{ id: 'call-1' }] };
  let request;
  const client = createLLMClient({
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return jsonResponse(expected);
    },
  });

  const result = await client.complete(cfg, messages, tools, {
    temperature: 0.75,
    maxTokens: 256,
  });

  assert.deepEqual(result, expected);
  assert.equal(request.url, 'https://llm.example/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(request.init.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-key',
  });
  assert.deepEqual(request.body, {
    model: 'test-model',
    messages,
    temperature: 0.75,
    max_tokens: 256,
    tools,
    tool_choice: 'auto',
  });
});

test('complete 将非成功响应和缺少 choices 的响应转为明确错误', async (t) => {
  await t.test('HTTP 错误包含状态码和截断后的响应体', async () => {
    const responseBody = 'x'.repeat(320);
    const client = createLLMClient({
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        async text() { return responseBody; },
      }),
    });

    await assert.rejects(
      client.complete(cfg, messages, null),
      new Error(`LLM 接口返回 429: ${'x'.repeat(300)}`),
    );
  });

  await t.test('成功响应缺少 choices 时报告格式异常', async () => {
    const client = createLLMClient({
      fetchImpl: async () => ({ ok: true, async json() { return {}; } }),
    });

    await assert.rejects(
      client.complete(cfg, messages, []),
      new Error('LLM 返回格式异常'),
    );
  });
});

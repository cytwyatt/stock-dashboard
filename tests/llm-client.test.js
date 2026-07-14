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

test('官方 DeepSeek V4 普通问答默认关闭 thinking，保持工具调用兼容', async () => {
  let body;
  const client = createLLMClient({
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse();
    },
  });
  const tools = [{ type: 'function', function: { name: 'get_quote' } }];

  await client.complete({
    ...cfg,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
  }, messages, tools);

  assert.deepEqual(body, {
    model: 'deepseek-v4-flash',
    messages,
    temperature: 0.3,
    thinking: { type: 'disabled' },
    tools,
    tool_choice: 'auto',
  });
});

test('官方 DeepSeek V4 开启 thinking 时省略 temperature 与 tool_choice，并保留推理字段', async () => {
  let body;
  const tools = [{ type: 'function', function: { name: 'get_quote' } }];
  const client = createLLMClient({
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({
        role: 'assistant',
        content: null,
        reasoning_content: '先查询报价',
        tool_calls: [{ id: 'call-1', function: { name: 'get_quote', arguments: '{}' } }],
      });
    },
  });

  const result = await client.complete({
    ...cfg,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
  }, messages, tools, {
    thinking: 'enabled',
    reasoningEffort: 'high',
  });

  assert.deepEqual(body, {
    model: 'deepseek-v4-flash',
    messages,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    tools,
  });
  assert.deepEqual(result, {
    role: 'assistant',
    content: '',
    reasoning_content: '先查询报价',
    tool_calls: [{ id: 'call-1', function: { name: 'get_quote', arguments: '{}' } }],
  });
});

test('DeepSeek V4 连接测试关闭 thinking，并拒绝空内容或非正常结束', async () => {
  const requests = [];
  const responses = [
    {
      ok: true,
      async json() {
        return {
          choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
        };
      },
    },
    {
      ok: true,
      async json() {
        return {
          choices: [{ finish_reason: 'length', message: { content: '' } }],
        };
      },
    },
  ];
  const client = createLLMClient({
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return responses.shift();
    },
  });
  const deepSeekConfig = {
    ...cfg,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
  };

  const success = await client.testConfig(deepSeekConfig);
  const truncated = await client.testConfig(deepSeekConfig);

  assert.equal(success.ok, true);
  assert.match(success.message, /deepseek-v4-pro.*OK/);
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(truncated.ok, false);
  assert.match(truncated.message, /length/);
});

test('complete 映射深度复盘参数、省略 temperature 并返回受控完成元数据', async () => {
  let request;
  const clock = [1000, 1125];
  const client = createLLMClient({
    now: () => clock.shift(),
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        async json() {
          return {
            model: 'deepseek-v4-pro',
            choices: [{
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"ok":true}' },
            }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 250,
              total_tokens: 350,
              completion_tokens_details: { reasoning_tokens: 200 },
              ignored: 'value',
            },
          };
        },
      };
    },
  });

  const result = await client.complete(cfg, messages, null, {
    maxTokens: 32768,
    timeoutMs: 300000,
    omitTemperature: true,
    thinking: 'enabled',
    reasoningEffort: 'high',
    jsonMode: true,
    includeMeta: true,
  });

  assert.deepEqual(request.body, {
    model: 'test-model',
    messages,
    max_tokens: 32768,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    response_format: { type: 'json_object' },
  });
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    role: 'assistant',
    content: '{"ok":true}',
    _completionMeta: {
      finishReason: 'stop',
      model: 'deepseek-v4-pro',
      usage: {
        promptTokens: 100,
        completionTokens: 250,
        reasoningTokens: 200,
        totalTokens: 350,
      },
      durationMs: 125,
    },
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

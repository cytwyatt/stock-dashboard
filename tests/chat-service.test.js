'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ChatValidationError, createChatService } = require('../src/ai/chat-service');

const clone = (value) => JSON.parse(JSON.stringify(value));

function stockContext(raw) {
  if (!raw || !['cn', 'hk', 'us'].includes(raw.market) || typeof raw.code !== 'string') return null;
  if (raw.market === 'cn' && !/^(sh|sz|bj)\d{6}$/i.test(raw.code)) return null;
  return { code: raw.market === 'us' ? raw.code.toUpperCase() : raw.code.toLowerCase(), name: String(raw.name || ''), market: raw.market };
}

function harness(options = {}) {
  let state = clone(options.state || { sessions: [] });
  const writes = [];
  const llmCalls = [];
  const toolCalls = [];
  const logs = [];
  const chatStore = {
    isValidChatSessionId: (id) => typeof id === 'string' && /^[\w-]{1,80}$/.test(id),
    normalizeStockContext: stockContext,
    createChatSessionId: (used) => { assert(used instanceof Set); return 'generated-id'; },
    readChats: () => clone(state),
    writeChats: (next) => { state = clone(next); writes.push(clone(next)); },
  };
  const responses = [...(options.responses || [{ role: 'assistant', content: '完成' }])];
  const llmClient = {
    complete: async (...args) => {
      llmCalls.push(clone(args));
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const toolRunner = {
    run: async (name, args) => {
      toolCalls.push({ name, args: clone(args) });
      if (options.toolError) throw new Error(options.toolError);
      return { ok: true, name, args };
    },
  };
  const prompts = {
    llmSystemPrompt: () => 'SYSTEM',
    stockContextSystemMessage: (context) => `CONTEXT:${context.code}`,
    stockResearchSystemMessage: (research) => `RESEARCH:${research.id}`,
    stockEvidenceSystemMessage: (evidence, serialize) => `EVIDENCE:${serialize(evidence, 10500)}`,
  };
  let tick = 1000;
  const service = createChatService({
    chatStore,
    llmConfigStore: { getLLMConfig: () => options.config || { baseUrl: 'https://llm.test/v1', apiKey: 'key', model: 'model' } },
    llmClient,
    toolRunner,
    LLM_TOOLS: [{ type: 'function', function: { name: 'fixture' } }],
    automaticEvidence: options.automaticEvidence || (async () => null),
    automaticResearch: options.automaticResearch || (async () => null),
    prompts,
    serializeToolResult: (value, limit) => JSON.stringify({ value, limit }),
    logger: { error: (...args) => logs.push(args) },
    now: () => tick++,
  });
  return {
    service,
    chatStore,
    getState: () => clone(state),
    writes,
    llmCalls,
    toolCalls,
    logs,
  };
}

test('prepare 完成请求体、sessionId、stockContext 与消息的全部 400 校验', () => {
  const { service } = harness();
  const invalid = [
    [null, '请求体格式不正确'],
    [[], '请求体格式不正确'],
    [{ sessionId: 'bad id', message: 'x' }, 'sessionId 格式不正确'],
    [{ message: 'x', stockContext: { code: 'AAPL', market: 'cn' } }, 'stockContext 格式不正确或代码与市场不匹配'],
    [{ sessionId: 'ok', message: '   ' }, '消息为空'],
  ];
  for (const [payload, message] of invalid) {
    assert.throws(() => service.prepare(payload), (error) => {
      assert(error instanceof ChatValidationError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, message);
      return true;
    });
  }

  const prepared = service.prepare({
    message: `  ${'x'.repeat(2100)}  `,
    stockContext: { code: 'aapl', name: 'Apple', market: 'us' },
  });
  assert.equal(prepared.sessionId, 'generated-id');
  assert.equal(prepared.text.length, 2000);
  assert.equal(prepared.hasIncomingStockContext, true);
  assert.deepEqual(prepared.incomingStockContext, { code: 'AAPL', name: 'Apple', market: 'us' });
});

test('未配置 API Key 只输出错误，不创建或写入会话', async () => {
  const h = harness({ config: { baseUrl: 'https://llm.test/v1', apiKey: '', model: 'm' } });
  const events = [];
  await h.service.run(h.service.prepare({ sessionId: 's1', message: '你好' }), (event) => events.push(event));
  assert.deepEqual(events, [{
    type: 'error',
    message: '尚未配置模型 API Key——点击「⚙ 模型设置」，选择服务商并填入 Key 即可使用。',
  }]);
  assert.equal(h.writes.length, 0);
  assert.equal(h.llmCalls.length, 0);
});

test('run 先持久化用户消息，并行自动证据，再按系统消息与最近12条历史调用模型', async () => {
  const oldMessages = Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `m${index}`,
  }));
  const timeline = [];
  let releaseEvidence;
  const evidenceGate = new Promise((resolve) => { releaseEvidence = resolve; });
  const h = harness({
    config: {
      baseUrl: 'https://llm.test/v1', apiKey: 'key',
      model: 'chat-model', marketReviewModel: 'review-model',
    },
    state: { sessions: [{ id: 's1', title: '', createdAt: 1, messages: oldMessages }] },
    automaticEvidence: async (context, text, { checkMove, onTool }) => {
      timeline.push(['evidence:start', context, text, checkMove]);
      onTool('get_stock_events', { auto: true });
      await evidenceGate;
      timeline.push(['evidence:end']);
      return { id: 'e1' };
    },
    automaticResearch: async (context, text, { onTool }) => {
      timeline.push(['research:start', context, text]);
      onTool('get_research_card', { auto: true });
      return { id: 'r1' };
    },
  });
  const originalWrite = h.chatStore.writeChats;
  h.chatStore.writeChats = (store) => { timeline.push(['write', clone(store)]); originalWrite(store); };
  const events = [];
  const prepared = h.service.prepare({
    sessionId: 's1',
    message: '  分析一下  ',
    stockContext: { code: 'sh600519', name: '贵州茅台', market: 'cn' },
  });
  const running = h.service.run(prepared, (event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timeline.slice(0, 3).map((item) => item[0]), ['write', 'evidence:start', 'research:start']);
  assert.equal(timeline[1][3], true);
  releaseEvidence();
  await running;

  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[0].sessions[0].messages.at(-1).role, 'user');
  assert.equal(h.writes[1].sessions[0].messages.at(-1).role, 'assistant');
  assert.equal(h.llmCalls.length, 1);
  const [config, messages, tools] = h.llmCalls[0];
  assert.equal(config.apiKey, 'key');
  assert.equal(config.model, 'chat-model');
  assert.equal(config.marketReviewModel, 'review-model');
  assert.equal(tools[0].function.name, 'fixture');
  assert.deepEqual(messages.slice(0, 4).map((message) => message.content), [
    'SYSTEM', 'CONTEXT:sh600519', 'RESEARCH:r1', 'EVIDENCE:{"value":{"id":"e1"},"limit":10500}',
  ]);
  assert.equal(messages.length, 16);
  assert.equal(messages[4].content, 'm3');
  assert.equal(messages.at(-1).content, '分析一下');
  assert.deepEqual(events.map((event) => event.type), ['tool', 'tool', 'answer']);
  assert.deepEqual(events.at(-1), { type: 'answer', content: '完成', sessionId: 's1', title: '分析一下' });
});

test('工具调用逐个执行，参数损坏回空对象，工具异常作为结果送回模型', async () => {
  const h = harness({
    toolError: 'upstream failed',
    responses: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'one', function: { name: 'get_quote', arguments: '{"code":"AAPL"}' } },
          { id: 'two', function: { name: 'get_news', arguments: '{bad' } },
        ],
      },
      { role: 'assistant', content: '工具完成' },
    ],
  });
  const events = [];
  await h.service.run(h.service.prepare({ sessionId: 's1', message: '查询' }), (event) => events.push(event));
  assert.deepEqual(h.toolCalls, [
    { name: 'get_quote', args: { code: 'AAPL' } },
    { name: 'get_news', args: {} },
  ]);
  assert.deepEqual(events.slice(0, 2), [
    { type: 'tool', name: 'get_quote', args: { code: 'AAPL' } },
    { type: 'tool', name: 'get_news', args: {} },
  ]);
  const secondMessages = h.llmCalls[1][1];
  assert.equal(secondMessages.at(-2).tool_call_id, 'one');
  assert.match(secondMessages.at(-2).content, /upstream failed/);
  assert.equal(secondMessages.at(-1).tool_call_id, 'two');
  assert.equal(events.at(-1).content, '工具完成');
});

test('连续6轮工具调用后使用固定超限答案并按原顺序持久化', async () => {
  const toolResponse = (index) => ({
    role: 'assistant', content: '',
    tool_calls: [{ id: `t${index}`, function: { name: 'get_quote', arguments: '{}' } }],
  });
  const h = harness({ responses: Array.from({ length: 6 }, (_, index) => toolResponse(index)) });
  const events = [];
  await h.service.run(h.service.prepare({ sessionId: 's1', message: '循环' }), (event) => events.push(event));
  assert.equal(h.llmCalls.length, 6);
  assert.equal(h.toolCalls.length, 6);
  assert.equal(h.writes.length, 2);
  assert.equal(h.getState().sessions[0].messages.at(-1).content, '（分析轮次超限，请换个更具体的问题）');
  assert.equal(events.at(-1).type, 'answer');
});

test('模型异常保留已写入的用户消息、输出 error 且不写 assistant', async () => {
  const h = harness({ responses: [new Error('LLM down')] });
  const events = [];
  await h.service.run(h.service.prepare({ sessionId: 's1', message: '问题' }), (event) => events.push(event));
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.getState().sessions[0].messages, [{ role: 'user', content: '问题' }]);
  assert.deepEqual(events, [{ type: 'error', message: 'LLM down' }]);
  assert.deepEqual(h.logs, [['[chat]', 'LLM down']]);
});

test('run 与外部 DELETE 复用同一 session 锁，同会话串行且前一任务失败不阻塞后续', async () => {
  const h = harness();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = h.service.withSessionLock('s1', async () => {
    order.push('first:start');
    await gate;
    order.push('first:end');
    throw new Error('expected');
  });
  const second = h.service.withSessionLock('s1', async () => { order.push('delete'); });
  const other = h.service.withSessionLock('s2', async () => { order.push('other'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first:start', 'other']);
  release();
  await assert.rejects(first, /expected/);
  await Promise.all([second, other]);
  assert.deepEqual(order, ['first:start', 'other', 'first:end', 'delete']);
});

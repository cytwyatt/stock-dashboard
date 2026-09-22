'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const {
  createCodexClient, SAFE_CONFIG, PERMISSIONS_PROFILE,
  decodeAction, hasOfficialRouting,
} = require('../src/ai/codex-client');
const { createLLMClient } = require('../src/ai/llm-client');

const model = 'test-model';
const config = { transport: 'codex', model, apiKey: 'never-pass-this-key' };
const tools = [{ type: 'function', function: {
  name: 'get_quote', description: 'quote', parameters: {
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
  },
} }];

function mockProcess(options = {}) {
  const requests = [];
  let launch;
  let child;
  let killed = false;
  function spawnImpl(binary, args, settings) {
    launch = { binary, args, settings };
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const message = JSON.parse(chunk);
      requests.push(message);
      callback();
      if (message.id == null) return;
      queueMicrotask(() => {
        const p = message.params;
        const result = {
          initialize: { userAgent: options.userAgent || 'codex/0.151.0' },
          'account/read': { account: { type: options.authType || 'chatgpt', email: 'never-expose@example.test' } },
          'account/rateLimits/read': options.quotas || {},
          'model/list': { data: [{ model, isDefault: true }] },
          'config/read': { config: { model_provider: 'openai', ...(options.inherited || {}) } },
          'thread/start': { thread: { id: 'thread-1' } },
          'turn/start': { turn: { id: 'turn-1' } },
        }[message.method];
        if (options.failMethod === message.method) {
          emit({ id: message.id, error: { message: 'SECRET_UPSTREAM_TOKEN' } });
          return;
        }
        if (message.method === 'turn/start') {
          if (options.hang) { emit({ id: message.id, result }); return; }
          if (options.earlyExit) { child.emit('exit', 1); return; }
          if (options.toolRequest) { emit({ id: 900, method: 'item/commandExecution/requestApproval', params: {} }); return; }
          emit({ method: 'item/started', params: { threadId: 'thread-1', item: { type: options.nativeTool || 'agentMessage' } } });
          emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { last: {
            inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 4, totalTokens: 120,
          } } } });
          emit({ method: 'item/completed', params: { threadId: 'thread-1', item: {
            type: 'agentMessage', phase: 'final_answer', text: options.text || JSON.stringify({ content: '完成' }),
          } } });
          // Deliberately notify before turn/start response to test ordering.
          emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: options.status || 'completed' } } });
        }
        emit({ id: message.id, result });
      });
    } });
    child.kill = () => { killed = true; child.signalCode = 'SIGTERM'; child.emit('exit', null); };
    return child;
  }
  const client = createCodexClient({ spawnImpl, env: {
    PATH: '/bin', HOME: '/fake-home', LLM_API_KEY: 'SECRET', MARKET_PASSWORD: 'SECRET',
    OPENAI_API_KEY: 'SECRET', CODEX_ACCESS_TOKEN: 'SECRET', SSH_AUTH_SOCK: 'SECRET',
  } });
  return { client, requests, get launch() { return launch; }, get killed() { return killed; } };
}

test('Codex structured completion preserves prompts and metadata without native tools or credentials', async () => {
  const h = mockProcess();
  const result = await h.client.complete(config, [
    { role: 'system', content: 'RESEARCH_CARD_EVIDENCE' },
    { role: 'user', content: '分析这只股票' },
  ], null, { includeMeta: true });
  assert.equal(result.content, '完成');
  assert.equal(result._completionMeta.finishReason, 'stop');
  assert.equal(result._completionMeta.usage.totalTokens, 120);
  assert(h.killed);
  assert.equal(fs.existsSync(h.launch.settings.cwd), false);
  assert.deepEqual(Object.keys(h.launch.settings.env).sort(), ['HOME', 'PATH']);
  assert.equal(h.launch.settings.shell, false);
  assert(h.launch.args.includes('stdio://'));
  for (const key of ['features.shell_tool', 'features.plugins', 'features.hooks']) assert.equal(SAFE_CONFIG[key], false);
  const thread = h.requests.find((r) => r.method === 'thread/start').params;
  assert.deepEqual(thread.environments, []);
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.permissions, PERMISSIONS_PROFILE);
  assert.equal(thread.sandbox, undefined);
  assert(h.launch.args.some((a) => a.startsWith(`permissions.${PERMISSIONS_PROFILE}.filesystem=`) && a.includes(h.launch.settings.cwd)));
  assert(h.launch.args.includes(`permissions.${PERMISSIONS_PROFILE}.network.enabled=false`));
  assert.match(thread.developerInstructions, /RESEARCH_CARD_EVIDENCE/);
  const turn = h.requests.find((r) => r.method === 'turn/start').params;
  assert.equal(turn.permissions, PERMISSIONS_PROFILE);
  assert.equal(turn.sandboxPolicy, undefined);
  assert.equal(turn.effort, 'low');
  assert.doesNotMatch(JSON.stringify(h.requests), /never-pass-this-key|SECRET|never-expose/);
});

test('structured query actions map to existing tool_calls; tool evidence survives the next completion', async () => {
  const h = mockProcess({ text: JSON.stringify({ content: '', toolCalls: [{ name: 'get_quote', arguments: '{"code":"AAPL"}' }] }) });
  const result = await h.client.complete(config, [{ role: 'user', content: '价格？' }], tools);
  assert.equal(result.tool_calls[0].function.name, 'get_quote');
  assert.match(result.tool_calls[0].id, /^codex_/);
  const next = mockProcess();
  await next.client.complete(config, [result, { role: 'tool', tool_call_id: result.tool_calls[0].id, content: '{"price":123}' }], tools);
  const input = JSON.parse(next.requests.find((r) => r.method === 'turn/start').params.input[0].text);
  assert.equal(input.transcript[1].role, 'tool');
  assert.equal(JSON.parse(input.transcript[1].content).price, 123);
});

test('status check reads account and models without starting an inference or exposing account', async () => {
  const h = mockProcess();
  const status = await h.client.testConfig(config);
  assert(status.ok);
  assert.deepEqual(status.models, [model]);
  assert.equal(h.requests.some((r) => r.method === 'account/rateLimits/read'), false);
  assert.equal(h.requests.some((r) => /^(thread|turn)\//.test(r.method)), false);
  assert.doesNotMatch(JSON.stringify(status), /never-expose|apiKey/);
});

test('Codex CLI compatibility is validated by protocol behavior instead of a version allowlist', async () => {
  for (const userAgent of ['codex/0.151.0', 'codex-cli/0.154.0', 'codex/future-version']) {
    const h = mockProcess({ userAgent });
    assert.equal((await h.client.testConfig(config)).ok, true);
    assert(h.requests.some((request) => request.method === 'account/read'));
  }
});

test('authentication failures are fail-closed before inference', async () => {
  const h = mockProcess({ authType: 'apiKey' });
  assert.equal((await h.client.testConfig(config)).ok, false);
  assert.equal(h.requests.some((r) => r.method === 'turn/start'), false);
  assert(h.killed);
});

test('subscription usage percentage does not gate new completions', async () => {
  const h = mockProcess({ quotas: { rateLimits: { primary: { usedPercent: 100 } } } });
  assert.equal((await h.client.complete(config, [], null)).content, '完成');
  assert(h.requests.some((r) => r.method === 'turn/start'));
  assert.equal(h.requests.some((r) => r.method === 'account/rateLimits/read'), false);
  assert(h.killed);
});

test('timeout, exit, native tool and abnormal completion cancel and clean up', async (t) => {
  for (const options of [
    { hang: true }, { earlyExit: true }, { toolRequest: true },
    { nativeTool: 'commandExecution' }, { status: 'failed' }, { text: '{bad' },
    { failMethod: 'model/list' },
  ]) await t.test(JSON.stringify(options), async () => {
    const h = mockProcess(options);
    await assert.rejects(h.client.complete(config, [], null, { timeoutMs: 25 }), (error) => {
      assert.match(error.message, /Codex/);
      assert.doesNotMatch(error.message, /SECRET_UPSTREAM_TOKEN/);
      return true;
    });
    assert(h.killed);
    assert.equal(fs.existsSync(h.launch.settings.cwd), false);
  });
});

test('one active request at a time; no hidden queued generations', async () => {
  const h = mockProcess({ hang: true });
  const first = h.client.complete(config, [], null, { timeoutMs: 30 });
  await assert.rejects(h.client.complete(config, [], null), /已有任务/);
  await assert.rejects(first, /超时/);
});

test('disconnected requests terminate their dedicated Codex process', async () => {
  const h = mockProcess({ hang: true });
  const controller = new AbortController();
  const pending = h.client.complete(config, [], null, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert(h.killed);
});

test('server shutdown terminates active Codex inference and rejects new work', async () => {
  const h = mockProcess({ hang: true });
  const pending = h.client.complete(config, [], null);
  await new Promise((resolve) => setImmediate(resolve));
  await h.client.close();
  await assert.rejects(pending, /关闭/);
  await assert.rejects(h.client.complete(config, [], null), /关闭/);
  assert(h.killed);
});

test('query whitelist, argument types, blank output and output token ceiling', async () => {
  for (const action of [
    { content: '', toolCalls: [{ name: 'exec_command', arguments: '{}' }] },
    { content: '', toolCalls: [{ name: 'get_quote', arguments: '{"code":12}' }] },
    { content: '', toolCalls: [{ name: 'get_quote', arguments: '{}' }] },
    { content: '', toolCalls: [{ name: 'get_quote', arguments: '{"code":"AAPL","path":"/secret"}' }] },
    { content: '' },
  ]) assert.throws(() => decodeAction(JSON.stringify(action), tools));
  const h = mockProcess();
  await assert.rejects(h.client.complete(config, [], null, { maxTokens: 10 }), /token 用量超过/);
});

test('LLM dispatcher never uses API after a Codex error or missing adapter', async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; throw Error('must not fetch'); };
  const client = createLLMClient({ fetchImpl, codexClient: { async complete() { throw Error('quota exhausted'); } } });
  await assert.rejects(client.complete(config, [], null), /quota/);
  await assert.rejects(createLLMClient({ fetchImpl }).complete(config, [], null), /不会回退/);
  assert.equal(fetched, false);
});

test('inherited external MCP and nonofficial routing fail before thread creation', async () => {
  for (const inherited of [
    { mcp_servers: { external: { enabled: true } } },
    { mcp_servers: { external: {} } },
    { chatgpt_base_url: 'https://untrusted.test/backend-api' },
    { model_providers: { openai: { env_key: 'PAID_API_KEY' } } },
  ]) {
    const h = mockProcess({ inherited });
    await assert.rejects(h.client.complete(config, [], null));
    assert.equal(h.requests.some((r) => r.method === 'thread/start'), false);
  }
  assert(hasOfficialRouting({ model_provider: 'openai', chatgpt_base_url: 'https://chatgpt.com/backend-api/' }));
  assert(!hasOfficialRouting({ model_provider: 'openai', chatgpt_base_url: 'https://user:pass@chatgpt.com/backend-api' }));
  assert(!hasOfficialRouting({ model_provider: 'openai', openai_base_url: 'https://api.openai.com/v1?key=secret' }));
});

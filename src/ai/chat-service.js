'use strict';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

class ChatValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatValidationError';
    this.status = 400;
    this.statusCode = 400;
  }
}

function createChatService({
  chatStore,
  llmConfigStore,
  llmClient,
  toolRunner,
  LLM_TOOLS,
  automaticEvidence,
  automaticResearch,
  prompts,
  serializeToolResult,
  logger = console,
  now = () => Date.now(),
}) {
  if (!chatStore || !llmConfigStore || !llmClient || !toolRunner || !prompts) {
    throw new TypeError('chatStore, llmConfigStore, llmClient, toolRunner and prompts are required');
  }
  if (typeof automaticEvidence !== 'function' || typeof automaticResearch !== 'function'
      || typeof serializeToolResult !== 'function') {
    throw new TypeError('automaticEvidence, automaticResearch and serializeToolResult are required');
  }

  // HTTP 删除会话也必须复用这个锁，避免与同会话的 LLM 回写互相覆盖。
  const queues = new Map();
  async function withSessionLock(sessionId, fn) {
    const previous = queues.get(sessionId) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    queues.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (queues.get(sessionId) === current) queues.delete(sessionId);
    }
  }

  function invalid(message) {
    throw new ChatValidationError(message);
  }

  function prepare(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      invalid('请求体格式不正确');
    }
    const rawId = payload.sessionId;
    if (rawId != null && !chatStore.isValidChatSessionId(rawId)) {
      invalid('sessionId 格式不正确');
    }
    const hasIncomingStockContext = hasOwn(payload, 'stockContext');
    const incomingStockContext = hasIncomingStockContext
      ? chatStore.normalizeStockContext(payload.stockContext)
      : null;
    if (hasIncomingStockContext && !incomingStockContext) {
      invalid('stockContext 格式不正确或代码与市场不匹配');
    }
    const sessionId = rawId || chatStore.createChatSessionId(
      new Set(chatStore.readChats().sessions.map((session) => session.id))
    );
    const text = String(payload.message || '').trim().slice(0, 2000);
    if (!text) invalid('消息为空');
    return { sessionId, text, hasIncomingStockContext, incomingStockContext };
  }

  async function run(prepared, emit) {
    if (!prepared || typeof emit !== 'function') throw new TypeError('prepared and emit are required');
    const { sessionId, text, hasIncomingStockContext, incomingStockContext } = prepared;
    return withSessionLock(sessionId, async () => {
      const config = llmConfigStore.getLLMConfig();
      try {
        if (!config.apiKey) {
          emit({
            type: 'error',
            message: '尚未配置模型 API Key——点击「⚙ 模型设置」，选择服务商并填入 Key 即可使用。',
          });
          return;
        }

        const store = chatStore.readChats();
        let session = store.sessions.find((item) => item.id === sessionId);
        if (!session) {
          session = { id: sessionId, title: '', createdAt: now(), messages: [] };
          store.sessions.unshift(session);
        }
        if (incomingStockContext) session.stockContext = incomingStockContext;
        const stockContext = chatStore.normalizeStockContext(session.stockContext);
        if (stockContext) session.stockContext = stockContext;
        else delete session.stockContext;
        if (!session.title) session.title = text.slice(0, 24);
        session.messages.push({ role: 'user', content: text });
        session.updatedAt = now();
        chatStore.writeChats(store);

        const onAutomaticTool = (name, args) => emit({ type: 'tool', name, args });
        const [evidenceResult, researchResult] = await Promise.allSettled([
          automaticEvidence(stockContext, text, {
            checkMove: !!incomingStockContext,
            onTool: onAutomaticTool,
          }),
          automaticResearch(stockContext, text, { onTool: onAutomaticTool }),
        ]);
        if (evidenceResult.status === 'rejected') {
          logger.error(`[stock-evidence] automatic: ${evidenceResult.reason?.message || evidenceResult.reason}`);
        }
        if (researchResult.status === 'rejected') {
          logger.error(`[stock-research] automatic: ${researchResult.reason?.message || researchResult.reason}`);
        }
        const evidence = evidenceResult.status === 'fulfilled' ? evidenceResult.value : null;
        const research = researchResult.status === 'fulfilled' ? researchResult.value : null;

        const messages = [
          { role: 'system', content: prompts.llmSystemPrompt() },
          ...(stockContext ? [{ role: 'system', content: prompts.stockContextSystemMessage(stockContext) }] : []),
          ...(research ? [{ role: 'system', content: prompts.stockResearchSystemMessage(research) }] : []),
          ...(evidence ? [{
            role: 'system',
            content: prompts.stockEvidenceSystemMessage(evidence, serializeToolResult),
          }] : []),
          ...session.messages.slice(-12).map((message) => ({ role: message.role, content: message.content })),
        ];

        let answer = '';
        for (let round = 0; round < 6; round++) {
          const response = await llmClient.complete(config, messages, LLM_TOOLS);
          if (response.tool_calls && response.tool_calls.length) {
            messages.push(response);
            for (const call of response.tool_calls) {
              let args = {};
              try { args = JSON.parse(call.function.arguments || '{}'); }
              catch { /* 参数解析失败按空对象处理 */ }
              emit({ type: 'tool', name: call.function.name, args });
              let result;
              try {
                result = await toolRunner.run(call.function.name, args);
              } catch (error) {
                result = { error: error.message };
              }
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: serializeToolResult(result),
              });
            }
            continue;
          }
          answer = response.content || '';
          break;
        }
        if (!answer) answer = '（分析轮次超限，请换个更具体的问题）';

        session.messages.push({ role: 'assistant', content: answer });
        session.updatedAt = now();
        const latestStore = chatStore.readChats();
        const index = latestStore.sessions.findIndex((item) => item.id === session.id);
        if (index >= 0) latestStore.sessions[index] = session;
        else latestStore.sessions.unshift(session);
        chatStore.writeChats(latestStore);

        emit({ type: 'answer', content: answer, sessionId: session.id, title: session.title });
      } catch (error) {
        logger.error('[chat]', error.message);
        emit({ type: 'error', message: error.message });
      }
    });
  }

  return { prepare, run, withSessionLock };
}

module.exports = { ChatValidationError, createChatService };

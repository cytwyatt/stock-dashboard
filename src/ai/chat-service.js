'use strict';

const { isOfficialDeepSeekV4 } = require('./llm-client');

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const MAX_TOOL_ROUNDS = 6;
const ADAPTIVE_TOOL_EVIDENCE_LIMIT = 16000;
const ADAPTIVE_THINKING_TIMEOUT_MS = 300000;

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
  adaptiveThinkingIntent,
  prompts,
  serializeToolResult,
  logger = console,
  now = () => Date.now(),
}) {
  if (!chatStore || !llmConfigStore || !llmClient || !toolRunner || !prompts) {
    throw new TypeError('chatStore, llmConfigStore, llmClient, toolRunner and prompts are required');
  }
  if (typeof automaticEvidence !== 'function' || typeof automaticResearch !== 'function'
      || typeof adaptiveThinkingIntent !== 'function' || typeof serializeToolResult !== 'function') {
    throw new TypeError('automaticEvidence, automaticResearch, adaptiveThinkingIntent and serializeToolResult are required');
  }
  if (typeof prompts.adaptiveThinkingSystemMessage !== 'function') {
    throw new TypeError('prompts.adaptiveThinkingSystemMessage is required');
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
    return {
      sessionId,
      text,
      hasIncomingStockContext,
      incomingStockContext,
      userCreatedAt: now(),
    };
  }

  async function run(prepared, emit) {
    if (!prepared || typeof emit !== 'function') throw new TypeError('prepared and emit are required');
    const {
      sessionId,
      text,
      hasIncomingStockContext,
      incomingStockContext,
      userCreatedAt,
    } = prepared;
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
          session = { id: sessionId, title: '', createdAt: userCreatedAt, messages: [] };
          store.sessions.unshift(session);
        }
        if (incomingStockContext) session.stockContext = incomingStockContext;
        const stockContext = chatStore.normalizeStockContext(session.stockContext);
        if (stockContext) session.stockContext = stockContext;
        else delete session.stockContext;
        const officialDeepSeekV4 = isOfficialDeepSeekV4(config);
        const useAdaptiveThinking = officialDeepSeekV4 && !!stockContext
          && adaptiveThinkingIntent(text, stockContext);
        if (!session.title) session.title = text.slice(0, 24);
        session.messages.push({ role: 'user', content: text, createdAt: userCreatedAt });
        session.updatedAt = userCreatedAt;
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

        const systemMessages = [
          { role: 'system', content: prompts.llmSystemPrompt() },
          ...(stockContext ? [{ role: 'system', content: prompts.stockContextSystemMessage(stockContext) }] : []),
          ...(research ? [{ role: 'system', content: prompts.stockResearchSystemMessage(research) }] : []),
          ...(evidence ? [{
            role: 'system',
            content: prompts.stockEvidenceSystemMessage(evidence, serializeToolResult),
          }] : []),
        ];
        const conversationMessages = session.messages.slice(-12)
          .map((message) => ({ role: message.role, content: message.content }));
        const messages = [...systemMessages, ...conversationMessages];
        const toolEvidence = [];

        let answer = '';
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const response = await llmClient.complete(
            config,
            messages,
            LLM_TOOLS,
            officialDeepSeekV4 ? { thinking: 'disabled' } : {},
          );
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
              const serializedResult = serializeToolResult(result);
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: serializedResult,
              });
              toolEvidence.push({
                name: call.function.name,
                args,
                result: serializedResult,
              });
            }
            continue;
          }
          answer = response.content || '';
          break;
        }
        if (!answer) answer = '（分析轮次超限，请换个更具体的问题）';

        if (useAdaptiveThinking) {
          try {
            const adaptiveMessages = [
              ...systemMessages,
              {
                role: 'system',
                content: prompts.adaptiveThinkingSystemMessage(
                  serializeToolResult(toolEvidence, ADAPTIVE_TOOL_EVIDENCE_LIMIT),
                ),
              },
              ...conversationMessages,
            ];
            const deepResponse = await llmClient.complete(config, adaptiveMessages, null, {
              thinking: 'enabled',
              reasoningEffort: 'high',
              omitTemperature: true,
              timeoutMs: ADAPTIVE_THINKING_TIMEOUT_MS,
              includeMeta: true,
            });
            const finishReason = deepResponse?._completionMeta?.finishReason;
            const deepAnswer = typeof deepResponse?.content === 'string'
              ? deepResponse.content.trim()
              : '';
            if (finishReason !== 'stop') {
              throw new Error(`异常结束：${finishReason || 'unknown'}`);
            }
            if (Array.isArray(deepResponse.tool_calls) && deepResponse.tool_calls.length) {
              throw new Error('最终综合意外返回工具调用');
            }
            if (!deepAnswer) throw new Error('最终综合返回空内容');
            answer = deepAnswer;
          } catch (error) {
            logger.error('[adaptive-thinking]', `${error.message}，已回退普通答案`);
          }
        }

        const assistantCreatedAt = now();
        session.messages.push({ role: 'assistant', content: answer, createdAt: assistantCreatedAt });
        session.updatedAt = assistantCreatedAt;
        const latestStore = chatStore.readChats();
        const index = latestStore.sessions.findIndex((item) => item.id === session.id);
        if (index >= 0) latestStore.sessions[index] = session;
        else latestStore.sessions.unshift(session);
        chatStore.writeChats(latestStore);

        emit({
          type: 'answer',
          content: answer,
          createdAt: assistantCreatedAt,
          sessionId: session.id,
          title: session.title,
        });
      } catch (error) {
        logger.error('[chat]', error.message);
        emit({ type: 'error', message: error.message });
      }
    });
  }

  return { prepare, run, withSessionLock };
}

module.exports = { ChatValidationError, createChatService };


const express = require('express');
const { Redis } = require('@upstash/redis');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing x-api-key header' });
  try {
    const keyData = await redis.hget('api_keys', apiKey);
    if (!keyData) return res.status(403).json({ error: 'Invalid API key' });
    const parsed = typeof keyData === 'string' ? JSON.parse(keyData) : keyData;
    if (parsed.credits < 2) return res.status(402).json({ error: 'Insufficient credits' });
    req.keyData = parsed;
    req.apiKey = apiKey;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

async function deductCredits(apiKey, keyData, amount) {
  const updated = { ...keyData, credits: keyData.credits - amount };
  await redis.hset('api_keys', { [apiKey]: JSON.stringify(updated) });
  return updated.credits;
}

app.get('/', (req, res) => {
  res.json({ service: 'mifactory-logic-verifier', status: 'live', version: '1.0.0' });
});

app.post('/verify', authenticate, async (req, res) => {
  const { reasoning, context } = req.body;
  if (!reasoning) return res.status(400).json({ error: 'Missing reasoning' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a strict logic verifier. Analyze this reasoning chain and detect any logical fallacies, invalid entailments, or contradictions.

Respond ONLY with JSON:
{
  "valid": true/false,
  "confidence": 0.0-1.0,
  "fallacies": [],
  "invalid_entailments": [],
  "verdict": "PASS or FAIL",
  "explanation": "brief explanation"
}

Reasoning: ${reasoning}
${context ? 'Context: ' + context : ''}`
      }]
    });
    const result = response.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(result);
    await deductCredits(req.apiKey, req.keyData, 2);
    res.json({ ...parsed, credits_used: 2, credits_remaining: req.keyData.credits - 2 });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed', details: err.message });
  }
});

app.get('/mcp', (req, res) => {
  res.json({ schema_version: '1.0', name: 'mifactory-logic-verifier', description: 'Verify reasoning chains and detect logical fallacies', version: '1.0.0', tools: [{ name: 'verify', description: 'Verify a reasoning chain' }] });
});

app.post('/mcp', (req, res) => {
  const { method, id } = req.body;
  if (method === 'initialize') return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mifactory-logic-verifier', version: '1.0.0' }, capabilities: { tools: {} } } });
  if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: { tools: [{ name: 'verify', description: 'Verify a reasoning chain for logical fallacies', inputSchema: { type: 'object', properties: { reasoning: { type: 'string' }, context: { type: 'string' } }, required: ['reasoning'] } }] } });
  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

app.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({ serverInfo: { name: 'mifactory-logic-verifier', version: '1.0.0' }, authentication: { required: true }, tools: [{ name: 'verify', description: 'Verify a reasoning chain for logical fallacies', inputSchema: { type: 'object', properties: { reasoning: { type: 'string' }, context: { type: 'string' } }, required: ['reasoning'] } }], resources: [], prompts: [] });
});

module.exports = app;

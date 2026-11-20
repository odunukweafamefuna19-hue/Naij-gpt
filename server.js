/**
 * NAIJA GPT — YOUR AI. YOUR WORLD.
 * Express backend: serves the frontend, persists chats to chats.json,
 * and proxies chat completions to OpenRouter (API key stays server-side).
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'openai/gpt-4o-mini';
const CHAT_FILE = path.join(__dirname, 'chats.json');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
// Generous body limit: image attachments arrive as base64 data URLs.
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── chats.json persistence ────────────────────────────────────
function readChats() {
  try {
    if (!fs.existsSync(CHAT_FILE)) return [];
    const raw = fs.readFileSync(CHAT_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[naija-gpt] Failed to read chats.json:', err.message);
    return [];
  }
}

function writeChats(chats) {
  try {
    fs.writeFileSync(CHAT_FILE, JSON.stringify(chats, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[naija-gpt] Failed to write chats.json:', err.message);
    return false;
  }
}

// ── System prompt: NAIJA GPT personality ─────────────────────
const SYSTEM_PROMPT = [
  'You are NAIJA GPT, a warm, sharp and expressive AI assistant built with Naija spirit.',
  'Respond by default in natural, clear, expressive Nigerian Pidgin English — fluent, correct and easy to follow, not exaggerated.',
  'You fully understand standard English, Nigerian slang (e.g. "sapa", "japa", "gist", "wahala", "E go better") and mixed English-Pidgin.',
  'Mirror the user: if they write in standard English, you may still reply in light, clear Pidgin unless they clearly prefer English; if they explicitly ask for standard English, switch fully to standard English.',
  'Be helpful, accurate and honest. If you do not know something, say so plainly — no forming.',
  'Keep answers well-structured: use Markdown, short paragraphs and bullet points when they help readability.',
  'For code, return complete, runnable snippets inside fenced code blocks with the language tag, and explain briefly in Pidgin afterwards.'
].join(' ');

// ── API: server status (API key readiness) ───────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    keyConfigured: Boolean(OPENROUTER_API_KEY),
    defaultModel: DEFAULT_MODEL
  });
});

// ── API: chat completions (proxied to OpenRouter) ────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { model, messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Request must include a non-empty "messages" array.' });
    }

    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: 'Server is not configured: OPENROUTER_API_KEY is missing. Copy .env.example to .env and add your key.'
      });
    }

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://naija-gpt.local',
        'X-Title': 'NAIJA GPT'
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detail = data && data.error && data.error.message
        ? data.error.message
        : `OpenRouter request failed with status ${response.status}.`;
      return res.status(response.status).json({ error: detail });
    }

    const reply = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';

    if (!reply) {
      return res.status(502).json({ error: 'OpenRouter returned an empty reply. Try again.' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('[naija-gpt] /api/chat error:', err);
    res.status(500).json({
      error: 'Server error while contacting the AI: ' + (err.message || 'unknown error')
    });
  }
});

// ── API: chats persistence ───────────────────────────────────

// GET all chats (most recent first)
app.get('/api/chats', (req, res) => {
  const chats = readChats();
  res.json({ chats });
});

// POST — create a new chat or update an existing one (upsert by id)
app.post('/api/chats', (req, res) => {
  const { chat } = req.body || {};
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
    return res.status(400).json({ error: 'Body must be { chat: { id?, title?, model?, messages: [] } }.' });
  }

  const chats = readChats();
  const now = new Date().toISOString();

  if (chat.id) {
    const idx = chats.findIndex((c) => c.id === chat.id);
    if (idx !== -1) {
      chats[idx] = {
        ...chats[idx],
        title: typeof chat.title === 'string' ? chat.title : chats[idx].title,
        model: typeof chat.model === 'string' ? chat.model : chats[idx].model,
        messages: chat.messages,
        updatedAt: now
      };
      if (!writeChats(chats)) return res.status(500).json({ error: 'Could not write chats.json.' });
      return res.json({ chat: chats[idx] });
    }
  }

  const newChat = {
    id: crypto.randomUUID(),
    title: typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : 'New Yarn',
    model: typeof chat.model === 'string' ? chat.model : DEFAULT_MODEL,
    messages: chat.messages,
    createdAt: now,
    updatedAt: now
  };
  chats.unshift(newChat);
  if (!writeChats(chats)) return res.status(500).json({ error: 'Could not write chats.json.' });
  res.status(201).json({ chat: newChat });
});

// PATCH — rename a chat
app.patch('/api/chats/:id', (req, res) => {
  const { title } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Body must include a non-empty string "title".' });
  }
  const chats = readChats();
  const chat = chats.find((c) => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });
  chat.title = title.trim();
  chat.updatedAt = new Date().toISOString();
  if (!writeChats(chats)) return res.status(500).json({ error: 'Could not write chats.json.' });
  res.json({ chat });
});

// DELETE — remove a chat
app.delete('/api/chats/:id', (req, res) => {
  const chats = readChats();
  const next = chats.filter((c) => c.id !== req.params.id);
  if (next.length === chats.length) return res.status(404).json({ error: 'Chat not found.' });
  if (!writeChats(next)) return res.status(500).json({ error: 'Could not write chats.json.' });
  res.json({ ok: true });
});

// ── SPA fallback: always serve the app shell ─────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'NAIJAGPT.HTML'));
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────');
  console.log('  ✦ NAIJA GPT — YOUR AI. YOUR WORLD.');
  console.log(`  Server running:  http://localhost:${PORT}`);
  console.log(`  API key ready:   ${OPENROUTER_API_KEY ? 'YES ✔' : 'NO ✖ (set OPENROUTER_API_KEY in .env)'}`);
  console.log(`  Default model:   ${DEFAULT_MODEL}`);
  console.log('──────────────────────────────────────────');
});

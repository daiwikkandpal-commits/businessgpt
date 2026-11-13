// "Ask AI" tutor chat for topical papers.
// POST { messages: [{ role: 'user'|'assistant', content: string }], question: { subject, topic, source, marks, text, ms, answer, studentAnswer, images: [url] } }
// Requires a signed-in user (Bearer token). Daily caps: free users FREE_DAILY, paying users PAID_DAILY.
// Usage is counted in the ai_chat_usage table (see supabase-ai-chat-schema.sql). If that table
// does not exist yet, questions are still answered but not counted.

const FREE_DAILY = 15;
const PAID_DAILY = 200;
const MAX_TURNS = 12;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function sb(path, opts = {}) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const q = body.question || {};
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json(400, { error: 'Ask a question first.' });

    // ── auth ──
    const auth = event.headers.authorization || event.headers.Authorization;
    if (!auth) return json(401, { error: 'Sign in to ask the AI.' });
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: process.env.SUPABASE_ANON_KEY }
    });
    if (!userRes.ok) return json(401, { error: 'Your session has expired. Please sign in again.' });
    const user = await userRes.json();

    // ── plan ──
    let paid = false;
    try {
      const r = await sb(`subscriptions?user_id=eq.${user.id}&select=plan,status,current_period_end`);
      if (r.ok) {
        const rows = await r.json();
        paid = rows.some(s => ['active', 'trialing'].includes(s.status) && (!s.current_period_end || new Date(s.current_period_end) > new Date()));
      }
    } catch (e) { /* treat as free */ }
    const limit = paid ? PAID_DAILY : FREE_DAILY;

    // ── daily usage ──
    const day = new Date().toISOString().slice(0, 10);
    let used = 0, tracked = false;
    try {
      const r = await sb(`ai_chat_usage?user_id=eq.${user.id}&day=eq.${day}&select=count`);
      if (r.ok) {
        tracked = true;
        const rows = await r.json();
        used = rows[0] ? rows[0].count : 0;
      }
    } catch (e) { /* table missing: don't block */ }
    if (tracked && used >= limit) {
      return json(429, {
        error: paid
          ? `You've asked ${limit} questions today. The limit resets tomorrow.`
          : `You've used your ${limit} free AI questions for today. They reset tomorrow, or upgrade for more.`,
        limitHit: true, paid
      });
    }

    // ── build the conversation ──
    const host = event.headers.host || event.headers.Host || '';
    const images = (Array.isArray(q.images) ? q.images : [])
      .filter(u => typeof u === 'string' && host && u.startsWith(`https://${host}/`))
      .slice(0, 5);

    const system = [
      `You are a friendly, expert Cambridge ${q.subject || 'IGCSE / AS Level'} tutor on IGCSE Mark. A student is practising a past paper question and has asked you for help.`,
      'How to help:',
      '- Help them understand and get unstuck. By default give a hint or explain the idea step by step, then let them try. Only give the full answer if they clearly ask for the answer, say they are finished, or ask you to check their work.',
      '- When they ask you to check their answer, compare it with the mark scheme, say what would score and what is missing, and estimate their mark.',
      '- Use the official mark scheme below to stay accurate. Do not paste it word for word unless they ask to see it.',
      '- Keep replies short and clear: usually under 150 words, short paragraphs, simple bullet points if useful. Use Cambridge terms and British spelling. For calculations, show the working line by line.',
      '- If they ask about something unrelated to their studies, gently bring them back to the question.',
      '',
      'THE QUESTION THEY ARE WORKING ON',
      q.source ? `Source: ${clip(q.source, 120)}` : '',
      q.topic ? `Topic: ${clip(q.topic, 120)}` : '',
      q.marks ? `Marks: ${q.marks}` : '',
      q.text ? `Question text: ${clip(q.text, 3000)}` : '',
      images.length ? 'The question itself is shown in the attached image(s) from the past paper.' : '',
      q.answer ? `Correct option (multiple choice): ${clip(q.answer, 5)}` : '',
      q.ms ? `Official mark scheme: ${clip(q.ms, 3000)}` : '',
      q.studentAnswer ? `The student's current answer: ${clip(q.studentAnswer, 2000)}` : ''
    ].filter(Boolean).join('\n');

    const history = msgs.slice(-MAX_TURNS).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: clip(m.content, 2000)
    }));
    // attach the question images to the first user turn in the window
    if (images.length) {
      const i = history.findIndex(m => m.role === 'user');
      history[i] = { role: 'user', content: [{ type: 'text', text: history[i].content }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] };
    }

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://igcsemark.com',
        'X-Title': 'IGCSE Mark Ask AI'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'system', content: system }, ...history],
        max_tokens: 1000,
        temperature: 0.3
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'The AI could not answer right now.');
    const text = data.choices?.[0]?.message?.content || '';

    // ── count it ──
    if (tracked) {
      try {
        await sb('ai_chat_usage?on_conflict=user_id,day', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ user_id: user.id, day, count: used + 1 })
        });
      } catch (e) { /* ignore */ }
    }

    return json(200, { text, remaining: tracked ? Math.max(0, limit - used - 1) : null, paid });
  } catch (err) {
    return json(500, { error: err.message || 'Something went wrong.' });
  }
};

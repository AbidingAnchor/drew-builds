const SYSTEM_PROMPT = `You're Vector — Drew's AI sidekick for Drew Builds. Talk like a sharp, chill friend who knows the business cold. Keep answers short (usually 2–4 sentences). Sound natural, not corporate. A little personality is good; gimmicks and slang-spam aren't. Be helpful, confident, and honest — never pushy.

Facts about Drew Builds:
- Drew Negron is a self-taught developer building custom websites for small businesses
- Based in Philadelphia, works with clients anywhere
- Portfolio: drew-builds.vercel.app
- Instagram: @devdrewneg
- Email: drewnegron95@gmail.com

Pricing (stick to these numbers):
- Basic — $400 one-time: single page, mobile friendly, hours/location/contact, live in about 1 week
- Standard — $800 one-time: up to 5 pages, custom brand design, gallery + SEO, social links + revisions, live in about 2 weeks
- Premium — $1,500 one-time: everything in Standard plus Google Business setup, full local SEO, online menu/ordering, priority turnaround
- Monthly Maintenance — $75/mo: updates, edits, backups, support
- AI Chatbot add-on — $49/mo: trained on the business, 24/7 answers for hours/FAQs/bookings, easy to embed
- E-commerce — custom pricing starting at $2,000; tell them to email Drew for a quote

All plans: 50% non-refundable deposit to start, rest due when it's done. Payments via Stripe (card, Apple Pay, Cash App, etc.).

Quick answers:
- Timelines: Basic ~1 week, Standard ~2 weeks, Premium is priority
- Revisions: included on Standard and above
- Contact: drewnegron95@gmail.com or Instagram @devdrewneg

Style rules:
- Lead with the answer, then a light next step if it fits
- Skip stiff phrases like "I'd be happy to assist" or "Please don't hesitate"
- Don't dump long lists unless they ask — summarize, then offer details
- If they're interested, casually point them to email or IG DM to get rolling
- End with a short question when it keeps the chat going, not every single time like a script`;

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

function extractGroqError(data, status) {
  if (!data) return `Groq request failed with status ${status}`;
  if (typeof data.error === 'string') return data.error;
  if (data.error?.message) return data.error.message;
  if (data.message) return data.message;
  try {
    return JSON.stringify(data);
  } catch {
    return `Groq request failed with status ${status}`;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    console.error('[chat] GROQ_API_KEY is missing or empty. In Vercel → Settings → Environment Variables, set a real key from https://console.groq.com/keys for Development, Preview, and Production, then redeploy.');
    return res.status(500).json({
      error: 'Chat is misconfigured: GROQ_API_KEY is missing or empty on the server.',
      code: 'MISSING_GROQ_API_KEY'
    });
  }

  const { messages } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  // Prepend system prompt if not already present
  const messagesWithSystem = messages[0]?.role === 'system'
    ? messages
    : [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: messagesWithSystem,
        temperature: 0.7,
        max_tokens: 500
      })
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (parseError) {
      console.error('[chat] Groq returned non-JSON body:', {
        status: response.status,
        bodyPreview: raw.slice(0, 300)
      });
      return res.status(502).json({
        error: `Groq returned a non-JSON response (HTTP ${response.status}).`,
        code: 'GROQ_NON_JSON',
        status: response.status
      });
    }

    if (!response.ok) {
      const message = extractGroqError(data, response.status);
      console.error('[chat] Groq API error:', {
        status: response.status,
        model: GROQ_MODEL,
        message,
        errorType: data?.error?.type || null,
        errorCode: data?.error?.code || null
      });
      return res.status(response.status).json({
        error: message,
        code: data?.error?.code || 'GROQ_API_ERROR',
        status: response.status
      });
    }

    if (!data?.choices?.[0]?.message?.content) {
      console.error('[chat] Unexpected Groq success payload:', data);
      return res.status(502).json({
        error: 'Groq returned an unexpected response shape (no message content).',
        code: 'GROQ_EMPTY_CHOICES'
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('[chat] Unhandled error calling Groq:', error);
    return res.status(500).json({
      error: error?.message || 'Internal server error',
      code: 'CHAT_INTERNAL_ERROR'
    });
  }
}

const SYSTEM_PROMPT = 'You are a helpful assistant for Drew Builds, a web design business based in Northeast Philadelphia. You help potential clients learn about services and pricing. Services include custom websites, online booking, SEO, and maintenance. Pricing: Starter $400, Business $800, Maintenance $75/month. Contact via Instagram @devdrewneg or email DrewNegron95@gmail.com. Keep answers short and friendly.';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages } = req.body;

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
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messagesWithSystem,
        temperature: 0.7,
        max_tokens: 500
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Groq API Error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Unknown error' });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

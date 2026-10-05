const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

export async function groqCompletion(apiKey, payload) {
  const primaryModel = (process.env.GROQ_MODEL || '').trim() || DEFAULT_MODEL;

  const request = (model) => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ...payload,
      model,
      ...(model === DEFAULT_MODEL || model === FALLBACK_MODEL
        ? { reasoning_effort: 'low', include_reasoning: false }
        : {})
    })
  });

  let model = primaryModel;
  let response = await request(model);
  if (!response.ok && model !== FALLBACK_MODEL) {
    // Inspect a clone so each caller can still parse the original error body.
    const error = response.status === 404
      ? null
      : await response.clone().json().catch(() => null);
    if (response.status === 404 || error?.error?.code === 'model_not_found'
      || error?.error?.type === 'model_not_found' || error?.code === 'model_not_found') {
      model = FALLBACK_MODEL;
      response = await request(model);
    }
  }
  return { response, model };
}

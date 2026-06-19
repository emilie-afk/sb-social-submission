const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const payload = JSON.parse(event.body);

    if (!payload.images || !payload.images.length) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No images provided' })
      };
    }

    const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

    const userContent = [];
    for (const img of payload.images) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.base64 }
      });
    }
    userContent.push({
      type: 'text',
      text: `Look at ${payload.images.length > 1 ? 'these screenshots' : 'this screenshot'} and respond with JSON only — no markdown, no explanation.

{
  "rawText": "<transcribe ALL visible text exactly as shown — captions, comments, usernames, engagement numbers, dates, hashtags, everything>",
  "creatorName": "<name or @handle of whoever made the original post — not commenters. null if unclear>"
}`
    });

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: userContent }]
    });

    let rawText = '', creatorName = null;
    try {
      const parsed = JSON.parse(response.content[0].text.trim());
      rawText     = parsed.rawText     || '';
      creatorName = parsed.creatorName || null;
    } catch {
      rawText = response.content[0].text.trim();
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, rawText, creatorName })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

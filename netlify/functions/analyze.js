const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are a social listening analyst for Succulents Box, a succulent plant subscription box company.

Analyze the raw social media signal and return ONLY a valid JSON object (no markdown fences, no extra text) with exactly these fields:

{
  "signal_type": "one of: TikTok manual observation | TikTok scraped/imported result | Instagram manual observation | Instagram scraped/imported result | Facebook Group manual observation | YouTube observation | Competitor observation | Customer comment / DM theme | Published video comment theme | Other community signal",
  "platform": "one of: TikTok | Instagram | Facebook | YouTube | Pinterest | Website | Email | Other",
  "source_name": "account name, group name, or creator name — blank if unknown",
  "topic": "concise topic label (5-10 words)",
  "plant_product": "plant or product name — blank if unclear",
  "caption_summary": "2-3 sentence summary of the post or observation",
  "metrics": "engagement numbers if mentioned — blank if none",
  "repeated_theme": "what question or concern keeps appearing",
  "audience_language": "key phrases or paraphrased quotes from the audience (do not copy private comments verbatim)",
  "why_it_matters": "why this is relevant for Succulents Box content — 1-2 sentences",
  "catalog_fit_guess": "matching SB product(s) or Needs check",
  "content_pillar": "one of: Repeated Questions | Common Mistakes | Plant Rescue | Myths and Debates | Experiments | Unusual Plant Features | Seasonal Problems | Trend Adaptation | Product / Catalog Fit",
  "shelf_life": "one of: Trend | Seasonal | Evergreen | Experimental",
  "priority_guess": "one of: High | Medium | Low",
  "suggested_hook": "one punchy hook line for a video — start with something compelling",
  "suggested_format": "brief description of the best content format (e.g. Diagnosis and fix, Side-by-side comparison, Myth correction)",
  "ai_confidence": "one of: High | Medium | Low",
  "needs_human_review": "Yes or No"
}

Rules:
- Do not invent metrics, URLs, or names.
- For Facebook Group content, summarize patterns — do not copy private member comments verbatim.
- If plant/product is uncertain, set catalog_fit_guess to Needs check.
- If evidence is weak or vague, set needs_human_review to Yes and ai_confidence to Low.
- If the post is unrelated to plants or succulents, set priority_guess to Low and explain in why_it_matters.
- Return only the JSON object. No markdown. No explanation.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const payload = JSON.parse(event.body);
    const client  = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

    const userContent = [];

    if (payload.images && payload.images.length > 0) {
      for (const img of payload.images) {
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.base64 }
        });
      }
      const n = payload.images.length;
      userContent.push({
        type: 'text',
        text: `These are ${n} screenshot${n > 1 ? 's' : ''} of a social media post${n > 1 ? ' and its comments' : ''}. Transcribe and analyze the full thread.\n\nSubmitter notes: ${payload.rawInput || '(none)'}`
      });
    } else {
      let text = '';
      if (payload.sourceUrl) text += `Source URL: ${payload.sourceUrl}\n\n`;
      text += payload.rawInput || '';
      userContent.push({ type: 'text', text });
    }

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userContent }]
    });

    let aiText = response.content[0].text.trim();
    let fields;
    try {
      fields = JSON.parse(aiText);
    } catch {
      const match = aiText.match(/\{[\s\S]*\}/);
      if (match) fields = JSON.parse(match[0]);
      else throw new Error('Could not parse AI response: ' + aiText.substring(0, 300));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, fields })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

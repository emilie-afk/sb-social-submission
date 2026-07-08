const { YoutubeTranscript } = require('youtube-transcript');

// ── Platform detection ─────────────────────────────────────────
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/tiktok\.com/.test(url))            return 'tiktok';
  if (/instagram\.com/.test(url))         return 'instagram';
  return 'unknown';
}

function extractYouTubeId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

// ── Supadata fallback (uses 1 credit if captions exist, 2 credits/min if AI-generated) ──
async function supadataTranscript(url) {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) return null; // key not set, skip silently

  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}`,
      { headers: { 'x-api-key': apiKey } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.content || !data.content.length) return null;
    // content is an array of { text, offset, duration } — join into plain text
    return data.content.map(s => s.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

// ── Handlers ───────────────────────────────────────────────────

async function handleYouTube(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return respond(400, { error: 'Could not extract a YouTube video ID from this URL.' });
  }

  // 1. Free: youtube-transcript package
  let transcript = null;
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (segments && segments.length > 0) {
      transcript = segments.map(s => s.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
    }
  } catch { /* fall through */ }

  if (transcript) {
    return respond(200, { success: true, platform: 'YouTube', transcript, source: 'free' });
  }

  // 2. Fallback: Supadata (costs 1 credit, or 2 credits/min if AI-generated)
  transcript = await supadataTranscript(url);
  if (transcript) {
    return respond(200, { success: true, platform: 'YouTube', transcript, source: 'supadata' });
  }

  // 3. Nothing found
  const isShorts = url.includes('/shorts/');
  return respond(200, {
    success: false,
    platform: 'YouTube',
    transcript: '',
    note: isShorts
      ? "No transcript found. Shorts often don't have auto-captions. To capture spoken content: open the Short → three-dot menu → Captions, screenshot it, then use the Screenshot tab."
      : "No transcript found (captions may be disabled). Add the spoken content manually in the notes field.",
  });
}

async function handleTikTok(url) {
  // 1. Supadata (handles TikTok transcripts natively)
  const transcript = await supadataTranscript(url);
  if (transcript) {
    return respond(200, { success: true, platform: 'TikTok', transcript, source: 'supadata' });
  }

  // 2. Fallback: oEmbed for caption text only
  try {
    const res = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (res.ok) {
      const data = await res.json();
      const parts = [];
      if (data.title)       parts.push(`Caption: ${data.title}`);
      if (data.author_name) parts.push(`Creator: ${data.author_name}`);
      if (parts.length) {
        return respond(200, {
          success: true,
          platform: 'TikTok',
          transcript: parts.join('\n'),
          note: process.env.SUPADATA_API_KEY
            ? 'Supadata could not retrieve a spoken transcript — caption text returned instead.'
            : 'Add SUPADATA_API_KEY to Netlify env vars to get full spoken transcripts. Caption text returned for now.',
        });
      }
    }
  } catch { /* fall through */ }

  return respond(200, {
    success: false,
    platform: 'TikTok',
    transcript: '',
    note: 'Could not retrieve transcript. The video may be private. Try pasting notes manually.',
  });
}

async function handleInstagram(url) {
  // 1. Supadata (handles Instagram transcripts natively)
  const transcript = await supadataTranscript(url);
  if (transcript) {
    return respond(200, { success: true, platform: 'Instagram', transcript, source: 'supadata' });
  }

  return respond(200, {
    success: false,
    platform: 'Instagram',
    transcript: '',
    note: process.env.SUPADATA_API_KEY
      ? 'Supadata could not retrieve a transcript for this Instagram video (may be private or a story).'
      : 'Add SUPADATA_API_KEY to Netlify env vars to enable Instagram transcripts. Alternatively: play the video with captions on → screenshot → use the Screenshot tab.',
  });
}

// ── Main handler ───────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method Not Allowed' });
  }

  let url;
  try {
    ({ url } = JSON.parse(event.body || '{}'));
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  if (!url || !url.trim()) {
    return respond(400, { error: 'URL is required' });
  }

  const platform = detectPlatform(url.trim());

  try {
    switch (platform) {
      case 'youtube':   return await handleYouTube(url.trim());
      case 'tiktok':    return await handleTikTok(url.trim());
      case 'instagram': return await handleInstagram(url.trim());
      default:
        return respond(200, {
          success: false,
          platform: 'unknown',
          transcript: '',
          note: 'Transcript extraction works for YouTube, TikTok, and Instagram URLs.',
        });
    }
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

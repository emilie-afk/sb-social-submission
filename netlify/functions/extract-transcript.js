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
    /[?&]v=([a-zA-Z0-9_-]{11})/,           // youtube.com/watch?v=
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,       // youtu.be/
    /\/shorts\/([a-zA-Z0-9_-]{11})/,        // youtube.com/shorts/
    /\/embed\/([a-zA-Z0-9_-]{11})/,         // youtube.com/embed/
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

// ── Handlers ───────────────────────────────────────────────────

async function handleYouTube(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return respond(400, { error: 'Could not extract a YouTube video ID from this URL.' });
  }

  const segments = await YoutubeTranscript.fetchTranscript(videoId);

  if (!segments || segments.length === 0) {
    return respond(200, {
      success: false,
      platform: 'YouTube',
      transcript: '',
      note: 'No captions found for this video. It may not have auto-generated captions, or they may be disabled.',
    });
  }

  const text = segments
    .map(s => s.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return respond(200, {
    success: true,
    platform: 'YouTube',
    transcript: text,
    wordCount: text.split(/\s+/).length,
  });
}

async function handleTikTok(url) {
  // TikTok oEmbed: returns the video caption/title (free, no auth needed)
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(oembedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });

  if (!res.ok) {
    return respond(200, {
      success: false,
      platform: 'TikTok',
      transcript: '',
      note: `TikTok returned an error (${res.status}). The video may be private or the URL format may be unsupported. Try pasting the caption/notes manually.`,
    });
  }

  const data = await res.json();

  // Build a useful text block from what oEmbed returns
  const parts = [];
  if (data.title)       parts.push(`Caption: ${data.title}`);
  if (data.author_name) parts.push(`Creator: ${data.author_name}`);

  const text = parts.join('\n');

  return respond(200, {
    success: true,
    platform: 'TikTok',
    transcript: text,
    note: "This is the video's caption text only — not the spoken transcript. TikTok's spoken words can't be extracted automatically. For the full audio transcript, play the video with captions on, screenshot them, then use the Screenshot tab.",
  });
}

function handleInstagram() {
  return respond(200, {
    success: false,
    platform: 'Instagram',
    transcript: '',
    note: "Instagram blocks external transcript access. To capture the content: play the video with captions on → screenshot the captions → switch to the Screenshot tab and extract the text there.",
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
      case 'instagram': return handleInstagram();
      default:
        return respond(200, {
          success: false,
          platform: 'unknown',
          transcript: '',
          note: 'Transcript extraction works for YouTube (full transcript), TikTok (caption text), and Instagram (guidance). This URL does not match any of those platforms.',
        });
    }
  } catch (err) {
    // YoutubeTranscript throws on disabled/missing captions
    const isNoCaption = err.message && (
      err.message.includes('Could not get') ||
      err.message.includes('Transcript is disabled') ||
      err.message.includes('No captions')
    );
    if (isNoCaption) {
      return respond(200, {
        success: false,
        platform: 'YouTube',
        transcript: '',
        note: 'No captions found for this video. Auto-captions may be disabled. Try pasting the script/notes manually.',
      });
    }
    return respond(500, { error: err.message });
  }
};

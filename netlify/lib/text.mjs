// Text normalisation shared by save / analyze / transcript.

// Remove control characters except tab and newline; normalise line endings and Unicode form.
export function cleanText(value, maxLen) {
  if (value === undefined || value === null) return '';
  let s = String(value).normalize('NFC').replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.trim();
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function singleLine(value, maxLen) {
  return cleanText(value, maxLen).replace(/\s*\n\s*/g, ' ');
}

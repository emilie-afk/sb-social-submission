# SB Signal Intake (SB Social Submission)

Team intake form for Succulents Box social listening: paste text, upload screenshots
(transcribed by Claude) or a YouTube / TikTok / Instagram link (transcript), then save to
the Intake Google Sheet and forward to SB Content Intelligence.

- Hosting: Netlify (`public/` + `netlify/functions/`, Functions v2), state in Netlify Blobs.
- Security design, configuration and test results: [SECURITY.md](SECURITY.md)
- Deployment and rollback: [ROLLOUT.md](ROLLOUT.md)

```
npm install
npm test              # unit + integration (fakes only; no network)
npm run build         # bundle all functions with Netlify's bundler and load them
npm run test:browser  # Chromium checks (needs Playwright installed on the machine)
```

Configuration lives only in Netlify environment variables — never commit real values.

const { google } = require('googleapis');

// Column order matches intake-sheet-script.gs COL definitions:
// 1: Raw input  2: Source URL  3: Platform  4: Source name  5: Status (auto)  6: Submitted at (auto)
const HEADERS = ['Raw input', 'Source URL', 'Platform', 'Source name', 'Status', 'Submitted at', 'Submitted by'];

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://sb-content-intelligence.netlify.app';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { rawInput, sourceUrl, platform, sourceName, submittedBy } = JSON.parse(event.body);

    if (!rawInput || !rawInput.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Raw input is required' })
      };
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Create Intake sheet + headers if it doesn't exist
    const meta     = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const hasSheet = meta.data.sheets.some(s => s.properties.title === 'Intake');

    if (!hasSheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        resource: { requests: [{ addSheet: { properties: { title: 'Intake' } } }] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId:   sheetId,
        range:           'Intake!A1',
        valueInputOption:'RAW',
        resource:        { values: [HEADERS] }
      });
    }

    // ── 1. Write raw row to sheet ─────────────────────────────────────────
    // Note: Google Sheets API writes do NOT trigger Apps Script onEdit,
    // so we submit to the dashboard directly below instead.
    const now = new Date().toISOString();
    const row = [
      (rawInput   || '').trim(),
      (sourceUrl  || '').trim(),
      (platform   || '').trim(),
      (sourceName || '').trim(),
      '',                          // Status — written back below
      now,                         // Submitted at
      (submittedBy|| '').trim(),   // Submitted by (internal, col G)
    ];

    const appendResp = await sheets.spreadsheets.values.append({
      spreadsheetId:   sheetId,
      range:           'Intake!A:A',
      valueInputOption:'USER_ENTERED',
      insertDataOption:'INSERT_ROWS',
      resource:        { values: [row] }
    });

    // Parse the row number from the updated range (e.g. "Intake!A5:F5" → 5)
    const updatedRange = appendResp.data.updates?.updatedRange || '';
    const rowMatch = updatedRange.match(/:([A-Z]+(\d+))$/);
    const appendedRow = rowMatch ? parseInt(rowMatch[2], 10) : null;

    // ── 2. Submit directly to dashboard (bypasses onEdit limitation) ──────
    const submitToken = process.env.SUBMIT_TOKEN;
    let dashboardResult = { skipped: true };
    let sheetStatus = '⚠️ No token';

    if (submitToken) {
      try {
        const signal = [{
          topic:        (rawInput || '').trim(),
          source_url:   (sourceUrl || '').trim() || null,
          platform:     (platform  || '').trim() || null,
          creator_name: (sourceName|| '').trim() || null,
          date_found:   now.slice(0, 10),
          status:       'New',
        }];

        const resp = await fetch(
          `${DASHBOARD_URL}/.netlify/functions/submit-signal`,
          {
            method:  'POST',
            headers: {
              'Content-Type':        'application/json',
              'x-submission-token':  submitToken,
            },
            body: JSON.stringify(signal),
          }
        );
        dashboardResult = await resp.json();
        sheetStatus = resp.ok ? '✅ Sent' : '❌ Error';
      } catch (dashErr) {
        console.warn('Dashboard submit failed (signal still saved to sheet):', dashErr.message);
        sheetStatus = '❌ Error';
      }
    }

    // ── 3. Write status back to sheet ────────────────────────────────────
    if (appendedRow) {
      await sheets.spreadsheets.values.update({
        spreadsheetId:   sheetId,
        range:           `Intake!E${appendedRow}`,
        valueInputOption:'RAW',
        resource:        { values: [[sheetStatus]] }
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, dashboard: dashboardResult })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

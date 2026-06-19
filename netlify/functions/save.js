const { google } = require('googleapis');

// Column order matches intake-sheet-script.gs COL definitions:
// 1: Raw input  2: Source URL  3: Platform  4: Source name  5: Status (auto)  6: Submitted at (auto)
const HEADERS = ['Raw input', 'Source URL', 'Platform', 'Source name', 'Status', 'Submitted at'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { rawInput, sourceUrl, platform, sourceName } = JSON.parse(event.body);

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

    // Write the raw row — Status and Submitted at left blank (Apps Script fills them on edit)
    const row = [
      (rawInput  || '').trim(),
      (sourceUrl || '').trim(),
      (platform  || '').trim(),
      (sourceName|| '').trim(),
      '', // Status — set by Apps Script onEdit trigger
      '', // Submitted at — set by Apps Script onEdit trigger
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId:   sheetId,
      range:           'Intake!A:A',
      valueInputOption:'USER_ENTERED',
      insertDataOption:'INSERT_ROWS',
      resource:        { values: [row] }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

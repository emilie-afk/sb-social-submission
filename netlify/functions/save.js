const { google } = require('googleapis');

const HEADERS = [
  'Submitted at', 'Submitted by', 'Raw input', 'Source URL',
  'Signal type', 'Platform', 'Source name', 'Date found',
  'Topic', 'Plant/product', 'Caption/post summary', 'Metrics',
  'Repeated question/theme', 'Audience language', 'Why it matters',
  'Catalog fit guess', 'Content pillar', 'Shelf life', 'Priority guess',
  'Suggested hook', 'Suggested format', 'Duplicate/similar topic match',
  'AI confidence', 'Needs human review?', 'Assistant review status',
  'Notes', 'Import status', 'Import ID', 'Import error'
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { payload, fields } = JSON.parse(event.body);
    const sheetId = process.env.GOOGLE_SHEET_ID;

    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Create "Intake" sheet + headers if it doesn't exist
    const meta     = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const hasSheet = meta.data.sheets.some(s => s.properties.title === 'Intake');

    if (!hasSheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        resource: { requests: [{ addSheet: { properties: { title: 'Intake' } } }] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'Intake!A1',
        valueInputOption: 'RAW',
        resource: { values: [HEADERS] }
      });
    }

    const now = new Date().toISOString();
    const row = [
      now,
      payload.submittedBy        || '',
      payload.rawInput           || '',
      payload.sourceUrl          || '',
      fields.signal_type         || '',
      fields.platform            || '',
      fields.source_name         || '',
      now,
      fields.topic               || '',
      fields.plant_product       || '',
      fields.caption_summary     || '',
      fields.metrics             || '',
      fields.repeated_theme      || '',
      fields.audience_language   || '',
      fields.why_it_matters      || '',
      fields.catalog_fit_guess   || '',
      fields.content_pillar      || '',
      fields.shelf_life          || '',
      fields.priority_guess      || '',
      fields.suggested_hook      || '',
      fields.suggested_format    || '',
      '',
      fields.ai_confidence       || '',
      fields.needs_human_review  || '',
      'Ready to import',
      '',
      'New',
      '',
      ''
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

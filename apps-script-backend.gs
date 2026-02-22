// ============================================================
// BML LAW - Google Apps Script Backend v3
// ============================================================

const CONFIG = {
  SPREADSHEET_ID: '1Tt_4t3Yjrgk247JxVb7iacnt1tXDIHxXyB5IPT1ikVs',
  SHEET_NAME: 'לידים',
  PARENT_FOLDER_ID: '18NCCA_ZDuRF-rKoCsg6YEGiZRuihVwAD',
  NOTIFICATION_EMAIL: 'peri@bettylaw.co.il',
  SF_ORG_ID: '00D9k000001XJEb',
  SF_DRIVE_FIELD: '00NWn000001S8Bl', // שדה "קישור לקבצים" ב-SF
};

// ============================================================
// נקודת כניסה: POST
// ============================================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // מצב ב: העלאת קבצים לתיקייה קיימת + מייל
    if (data.action === 'uploadFiles' && data.folderUrl) {
      return handleFileUpload(data);
    }

    // מצב א: יצירת תיקייה + רישום + שליחה לסיילספורס
    return handleNewLead(data);

  } catch (err) {
    console.error('doPost error:', err);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput('BML Law API is running OK')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ============================================================
// מצב א: ליד חדש – תיקייה + Sheets + Salesforce
// ============================================================
function handleNewLead(data) {
  // 1. צור תיקיית לקוח
  const clientFolderUrl = createClientFolder(data);

  // 2. רשום ב-Sheets
  const rowNum = logToSheets(data, clientFolderUrl);

  // 3. שלח לסיילספורס (מה-GAS – לא מהדפדפן!)
  sendToSalesforce(data, clientFolderUrl);

  return ContentService
    .createTextOutput(JSON.stringify({
      success: true,
      folderUrl: clientFolderUrl,
      rowNum
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// מצב ב: העלאת קבצים + מייל עם קבצים מצורפים
// ============================================================
function handleFileUpload(data) {
  const folderId = data.folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (!folderId) return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: 'Invalid folder URL' }))
    .setMimeType(ContentService.MimeType.JSON);

  const folder = DriveApp.getFolderById(folderId[1]);

  // מצא תתי-תיקיות
  let docsFolder = folder;
  const docsSub = folder.getFoldersByName('מסמכים שהועלו');
  if (docsSub.hasNext()) docsFolder = docsSub.next();

  let powFolder = folder;
  const powSub = folder.getFoldersByName('ייפוי כוח');
  if (powSub.hasNext()) powFolder = powSub.next();

  const attachments = [];

  // שמור דוח תנועה
  if (data.files && data.files.ticket) {
    const blob = saveBase64File(docsFolder, data.files.ticket);
    if (blob) attachments.push(blob);
  }

  // שמור ת.ז
  if (data.files && data.files.idCard) {
    const blob = saveBase64File(docsFolder, data.files.idCard);
    if (blob) attachments.push(blob);
  }

  // שמור חתימה (ייפוי כוח)
  if (data.signature) {
    const blob = saveSignature(powFolder, data);
    if (blob) attachments.push(blob);
  }

  // שלח מייל עם קבצים מצורפים
  if (data.clientData) {
    sendNotificationEmail(data.clientData, data.folderUrl, attachments);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// שליחה לסיילספורס מה-GAS (אמין יותר מהדפדפן)
// ============================================================
function sendToSalesforce(data, folderUrl) {
  try {
    const payload = {
      'oid': CONFIG.SF_ORG_ID,
      'retURL': 'https://bettylaw.co.il',
      'first_name': data.firstName || '',
      'last_name': data.lastName || '',
      'phone': data.phone || '',
      'mobile': data.phone || '',
      'email': data.email || 'noemail@bettylaw.co.il',
      'company': (data.lastName || '') + ' ' + (data.firstName || ''),
      'city': data.ticketCity || '',
      'lead_source': 'Web',
      'description': 'דוח: ' + (data.ticketNum||'') + ' | קנס: ₪' + (data.ticketAmount||'') + ' | רכב: ' + (data.licensePlate||'') + ' | עיר: ' + (data.ticketCity||'') + ' | עבירה: ' + (data.violationType||''),
      [CONFIG.SF_DRIVE_FIELD]: folderUrl || '',
    };

    UrlFetchApp.fetch(
      'https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8',
      {
        method: 'post',
        payload: payload,
        muteHttpExceptions: true,
        followRedirects: true,
      }
    );
    console.log('SF lead sent OK');
  } catch(e) {
    console.error('SF error:', e);
  }
}

// ============================================================
// Drive
// ============================================================
function createClientFolder(data) {
  const parentFolder = DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID);
  const folderName = (data.lastName||'') + ' ' + (data.firstName||'') + ' – דוח ' + (data.ticketNum||'');
  const clientFolder = parentFolder.createFolder(folderName);

  clientFolder.createFolder('מסמכים שהועלו');
  clientFolder.createFolder('ייפוי כוח');
  clientFolder.createFolder('תיעוד פנימי');

  const summary = buildSummaryText(data);
  clientFolder.createFile(
    Utilities.newBlob(summary, 'text/plain; charset=utf-8', 'פרטי_לקוח.txt')
  );

  return clientFolder.getUrl();
}

function saveBase64File(folder, fileObj) {
  try {
    const b64 = fileObj.data.indexOf(',') >= 0 ? fileObj.data.split(',')[1] : fileObj.data;
    const blob = Utilities.newBlob(
      Utilities.base64Decode(b64),
      fileObj.type || 'application/octet-stream',
      fileObj.name || 'קובץ'
    );
    folder.createFile(blob);
    return blob; // מחזיר למייל
  } catch(e) {
    console.error('saveBase64File error:', e);
    return null;
  }
}

function saveSignature(folder, data) {
  try {
    const b64 = data.signature.split(',')[1];
    const blob = Utilities.newBlob(
      Utilities.base64Decode(b64),
      'image/png',
      'ייפוי_כוח_חתום_' + (data.lastName||'') + '_' + (data.firstName||'') + '.png'
    );
    folder.createFile(blob);
    return blob;
  } catch(e) {
    console.error('saveSignature error:', e);
    return null;
  }
}

// ============================================================
// מייל התראה עם קבצים מצורפים
// ============================================================
function sendNotificationEmail(data, folderUrl, attachments) {
  try {
    const subject = 'ליד חדש: ' + data.firstName + ' ' + data.lastName + ' – דוח ' + data.ticketNum;

    const htmlBody = '<div style="font-family:Arial,sans-serif;direction:rtl;max-width:600px">'
      + '<div style="background:#0d1b2a;padding:20px;border-radius:12px 12px 0 0">'
      + '<h2 style="color:#c9a84c;margin:0">BML LAW – ליד חדש</h2></div>'
      + '<div style="background:#f9f5ee;padding:24px;border:1px solid #e5e5e5">'
      + '<p><strong>שם:</strong> ' + data.firstName + ' ' + data.lastName + '</p>'
      + '<p><strong>ת"ז:</strong> ' + (data.idNum||'—') + '</p>'
      + '<p><strong>טלפון:</strong> ' + (data.phone||'—') + '</p>'
      + '<p><strong>מייל:</strong> ' + (data.email||'—') + '</p>'
      + '<hr>'
      + '<p><strong>מספר דוח:</strong> ' + (data.ticketNum||'—') + '</p>'
      + '<p><strong>סכום קנס:</strong> ₪' + (data.ticketAmount||'—') + '</p>'
      + '<p><strong>מספר רכב:</strong> ' + (data.licensePlate||'—') + '</p>'
      + '<p><strong>עיר:</strong> ' + (data.ticketCity||'—') + '</p>'
      + '<p><strong>עבירה:</strong> ' + (data.violationType||'—') + '</p>'
      + '<hr>'
      + (attachments && attachments.length
          ? '<p style="color:#276221">✅ ' + attachments.length + ' קבצים מצורפים למייל זה</p>'
          : '<p style="color:#666">לא צורפו קבצים</p>')
      + '<br><a href="' + folderUrl + '" style="background:#0d1b2a;color:#c9a84c;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">📁 פתח תיקיית Drive</a>'
      + '</div></div>';

    GmailApp.sendEmail(CONFIG.NOTIFICATION_EMAIL, subject, '', {
      htmlBody: htmlBody,
      name: 'BML Law System',
      attachments: attachments || [],
    });
    console.log('Email sent with', (attachments||[]).length, 'attachments');
  } catch(e) {
    console.error('Email error:', e);
  }
}

// ============================================================
// Google Sheets
// ============================================================
function logToSheets(data, folderUrl) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    setupSheetHeaders(sheet);
  }
  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  sheet.appendRow([
    now, data.firstName, data.lastName, data.idNum, data.phone, data.email,
    data.ticketNum, data.ticketAmount, data.ticketDate||'', data.licensePlate||'',
    data.ticketCity||'', data.violationType||'', 'חדש', folderUrl, data.caseDesc||'',
  ]);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 13).setBackground('#c6efce').setFontColor('#276221');
  const driveCell = sheet.getRange(newRow, 14);
  if (folderUrl) {
    driveCell.setFormula('=HYPERLINK("' + folderUrl + '","📁 פתח תיקייה")');
    driveCell.setFontColor('#1155CC');
  }
  return newRow;
}

function setupSheetHeaders(sheet) {
  const headers = [
    'תאריך קבלה','שם פרטי','שם משפחה','ת.ז','טלפון','מייל',
    'מספר דוח','סכום קנס','תאריך דוח','מספר רכב','עיר',
    'סוג עבירה','סטטוס','תיקיית Drive','תיאור המקרה'
  ];
  sheet.getRange(1,1,1,headers.length).setValues([headers])
    .setBackground('#0d1b2a').setFontColor('#c9a84c')
    .setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
}

function buildSummaryText(data) {
  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  return [
    '=== BML LAW - פרטי לקוח ===',
    'תאריך פתיחת תיק: ' + now, '',
    '--- פרטים אישיים ---',
    'שם מלא: ' + (data.firstName||'') + ' ' + (data.lastName||''),
    'ת.ז: ' + (data.idNum||''), 'טלפון: ' + (data.phone||''),
    'כתובת: ' + (data.address||'—'), '',
    '--- פרטי הדוח ---',
    'מספר דוח: ' + (data.ticketNum||''),
    'סכום קנס: ₪' + (data.ticketAmount||''),
    'תאריך: ' + (data.ticketDate||'—'),
    'רכב: ' + (data.licensePlate||'—'),
    'עיר: ' + (data.ticketCity||'—'),
    'עבירה: ' + (data.violationType||'—'),
  ].join('\n');
}

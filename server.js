import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import csvParser from 'csv-parser';
import express from 'express';
import multer from 'multer';
import pino from 'pino';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIN_DELAY_MS = 60000; // 1 minute default
const MAX_DELAY_MS = 180000; // 3 minutes default
const MAX_DELAY_SEC = 1200; // 20 minutes maximum (anti-ban safe limit)

const HEADER_ALIASES = {
  ledgerNumber: [
    'ledger number',
    'ac ledger no',
    'a c ledger no',
    'account ledger no',
    'ledger no',
    'ledger id',
    'ledger',
    'admission no',
    'adm no',
    'reg no',
    'sr no',
  ],
  fatherName: [
    'father name',
    'fathers name',
    "father's name",
    'father',
    'parent name',
    'guardian name',
  ],
  studentName: [
    'student name',
    'students name',
    "student's name",
    'name of student',
    'ward name',
    'child name',
    'student',
    'name',
  ],
  mobileNumber: [
    'mobile number',
    'mobile no',
    'mobile',
    'contact number',
    'contact no',
    'contact',
    'phone number',
    'phone no',
    'phone',
    'whatsapp number',
    'whatsapp no',
    'whatsapp',
    'cell no',
    'cell',
  ],
};

const FIELD_LABELS = {
  ledgerNumber: 'Ledger Number (e.g. Ledger Number, Ac Ledger No)',
  fatherName: 'Father Name',
  studentName: 'Student Name',
  mobileNumber: 'Mobile / Contact Number (e.g. Mobile Number, Contact No)',
};

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB max per file
  },
});

// WhatsApp connection state
let currentSock = null;
let reconnectTimer = null;
let isManualLogout = false;
let isInitializing = false;

const waState = {
  status: 'connecting', // 'connected' | 'qr' | 'disconnected' | 'connecting'
  qrDataUrl: null,
  user: null,
  lastError: null,
};

// Active bulk campaign state
const campaign = {
  running: false,
  abortRequested: false,
  abortController: null,
  latestReportCsv: null,
};

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(delayMs = 2500) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void initWhatsApp();
  }, delayMs);
}

/**
 * Initialize or re-initialize the Baileys WhatsApp Web socket.
 */
async function initWhatsApp() {
  if (isInitializing) {
    return;
  }
  isInitializing = true;
  clearReconnectTimer();

  try {
    waState.status = 'connecting';
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
    });

    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      // Ignore events from superseded socket instances
      if (sock !== currentSock) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: {
              dark: '#0f172a',
              light: '#ffffff',
            },
          });
          if (sock === currentSock) {
            waState.status = 'qr';
            waState.qrDataUrl = dataUrl;
            waState.user = null;
            waState.lastError = null;
          }
        } catch (err) {
          console.error('[whatsapp] Failed to generate QR Data URL:', err.message);
        }
      }

      if (connection === 'open') {
        isManualLogout = false;
        waState.status = 'connected';
        waState.qrDataUrl = null;
        waState.user = {
          id: sock.user?.id || '',
          name: sock.user?.name || '',
        };
        waState.lastError = null;
        console.log('[whatsapp] Connected:', waState.user.id);
      }

      if (connection === 'close') {
        waState.qrDataUrl = null;
        waState.user = null;

        if (isManualLogout) {
          waState.status = 'disconnected';
          return;
        }

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          waState.status = 'disconnected';
          waState.lastError = `Connection lost (code ${statusCode ?? 'unknown'}). Reconnecting...`;
          console.log(`[whatsapp] ${waState.lastError}`);
          scheduleReconnect(2500);
        } else {
          waState.status = 'disconnected';
          waState.lastError =
            'WhatsApp session logged out. Click "Disconnect / Switch Number" to generate a new QR code.';
          console.log('[whatsapp] Logged out (DisconnectReason.loggedOut).');
        }
      }
    });
  } catch (err) {
    waState.status = 'disconnected';
    waState.qrDataUrl = null;
    waState.lastError = `Failed to initialize WhatsApp client: ${err.message}`;
    console.error('[whatsapp] Init error:', err);
    if (!isManualLogout) {
      scheduleReconnect(4000);
    }
  } finally {
    isInitializing = false;
  }
}

/**
 * Strip non-numeric characters and normalize Indian 10-digit numbers with "91".
 * Validates 12-digit Indian format or standard E.164 international format (11-15 digits).
 */
function normalizeMobileNumber(rawMobile) {
  const digits = String(rawMobile ?? '').replace(/\D/g, '');
  if (!digits) {
    return { valid: false, reason: 'Missing mobile number' };
  }

  const normalized = digits.length === 10 ? `91${digits}` : digits;

  if (normalized.startsWith('0')) {
    return {
      valid: false,
      reason: `Invalid mobile number "${rawMobile}" (leading zero without country code)`,
    };
  }

  // Standard 12-digit (91 + 10 digits) or E.164 international format (11-15 digits)
  if (normalized.length < 11 || normalized.length > 15) {
    return {
      valid: false,
      reason: `Invalid mobile number "${rawMobile}" (${normalized.length} digits after normalization)`,
    };
  }

  return {
    valid: true,
    normalized,
    jid: `${normalized}@s.whatsapp.net`,
  };
}

function normalizeHeaderKey(header) {
  return String(header ?? '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveColumnMap(rawHeaders) {
  const entries = rawHeaders
    .filter((h) => h && h.trim())
    .map((original) => ({
      original,
      norm: normalizeHeaderKey(original),
    }));

  const usedOriginals = new Set();
  const columnMap = {};

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    let matched = null;

    // 1. Exact alias match in priority order
    for (const alias of aliases) {
      const found = entries.find((e) => !usedOriginals.has(e.original) && e.norm === alias);
      if (found) {
        matched = found.original;
        break;
      }
    }

    // 2. Fallback substring match (e.g., "Student's Ledger No")
    if (!matched) {
      const keywords = {
        ledgerNumber: ['ledger'],
        fatherName: ['father', 'guardian'],
        studentName: ['student', 'ward'],
        mobileNumber: ['mobile', 'contact', 'phone', 'whatsapp'],
      }[field];

      const found = entries.find(
        (e) => !usedOriginals.has(e.original) && keywords.some((kw) => e.norm.includes(kw))
      );
      if (found) {
        matched = found.original;
      }
    }

    if (matched) {
      columnMap[field] = matched;
      usedOriginals.add(matched);
    }
  }

  return columnMap;
}

/**
 * Parse and validate an uploaded CSV file.
 */
function parseStudentCsv(filePath) {
  return new Promise((resolve, reject) => {
    const validRows = [];
    const invalidRows = [];
    const allRows = [];
    let rawHeaders = [];
    let columnMap = {};
    let headersChecked = false;
    let rowNumber = 0;

    const stream = fs.createReadStream(filePath);
    const parser = csvParser({
      mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim(),
      mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value),
    });

    parser.on('headers', (headers) => {
      headersChecked = true;
      rawHeaders = headers.filter((h) => Boolean(h && h.trim()));
      columnMap = resolveColumnMap(rawHeaders);

      const missingFields = Object.keys(HEADER_ALIASES).filter((field) => !columnMap[field]);
      if (missingFields.length > 0) {
        const missingLabels = missingFields.map((f) => FIELD_LABELS[f]);
        stream.destroy();
        parser.destroy(
          new Error(
            `Could not find column(s): ${missingLabels.join('; ')}. Found CSV headers: ${
              rawHeaders.length ? rawHeaders.join(', ') : '(none)'
            }.`
          )
        );
      }
    });

    parser.on('data', (record) => {
      rowNumber += 1;
      const ledgerNumber = String(record[columnMap.ledgerNumber] ?? '').trim();
      const fatherName = String(record[columnMap.fatherName] ?? '').trim();
      const studentName = String(record[columnMap.studentName] ?? '').trim();
      const mobileRaw = String(record[columnMap.mobileNumber] ?? '').trim();

      // Skip completely blank trailing lines
      if (!ledgerNumber && !fatherName && !studentName && !mobileRaw) {
        rowNumber -= 1;
        return;
      }

      const phoneCheck = normalizeMobileNumber(mobileRaw);
      const entry = {
        rowNumber,
        ledgerNumber,
        fatherName,
        studentName,
        mobileRaw,
        normalizedMobile: phoneCheck.valid ? phoneCheck.normalized : mobileRaw,
        jid: phoneCheck.valid ? phoneCheck.jid : null,
        valid: phoneCheck.valid,
        reason: phoneCheck.valid ? '' : phoneCheck.reason,
        raw: record,
      };

      allRows.push(entry);
      if (entry.valid) {
        validRows.push(entry);
      } else {
        invalidRows.push(entry);
      }
    });

    parser.on('error', (err) => {
      reject(err);
    });

    stream.on('error', (err) => {
      reject(err);
    });

    parser.on('end', () => {
      if (!headersChecked || allRows.length === 0) {
        reject(new Error('The uploaded CSV file is empty or contains no student records.'));
        return;
      }
      resolve({
        headers: rawHeaders,
        columnMap,
        totalRows: allRows.length,
        validRows,
        invalidRows,
        allRows,
      });
    });

    stream.pipe(parser);
  });
}

function escapeCsvCell(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildDeliveryReportCsv(rows) {
  const header = ['Ledger Number', 'Father Name', 'Student Name', 'Mobile Number', 'Status', 'Reason'];
  const lines = [header.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.ledgerNumber,
        row.fatherName,
        row.studentName,
        row.mobile,
        row.status,
        row.reason,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function normalizeKey(str) {
  return String(str ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\-\/\s]+/g, ' ');
}

function personalizeMessage(template, row) {
  if (!template) return '';
  const rawRecord = row?.raw || {};

  return template.replace(/\{([^{}]+)\}/g, (fullMatch, tag) => {
    const trimmedTag = tag.trim();

    // 1. Direct exact match in rawRecord (e.g. {Due Amount}, {Mother Name}, {Grade/Class})
    if (
      Object.prototype.hasOwnProperty.call(rawRecord, trimmedTag) &&
      rawRecord[trimmedTag] !== undefined &&
      rawRecord[trimmedTag] !== null
    ) {
      return String(rawRecord[trimmedTag]);
    }

    // 2. Case-insensitive / normalized key match in rawRecord (e.g. {due_amount}, {grade/class})
    const normTag = normalizeKey(trimmedTag);
    const rawKeys = Object.keys(rawRecord);
    const foundKey = rawKeys.find((k) => normalizeKey(k) === normTag);
    if (
      foundKey &&
      rawRecord[foundKey] !== undefined &&
      rawRecord[foundKey] !== null
    ) {
      return String(rawRecord[foundKey]);
    }

    // 3. Built-in canonical fallback aliases for common student/school fields
    if (
      normTag === 'ledger number' ||
      normTag === 'ledger no' ||
      normTag === 'ac ledger no' ||
      normTag === 'ledger' ||
      normTag === 'admission no' ||
      normTag === 'adm no'
    ) {
      return String(row.ledgerNumber ?? '');
    }
    if (
      normTag === 'father name' ||
      normTag === 'fathers name' ||
      normTag === 'father' ||
      normTag === 'parent name' ||
      normTag === 'guardian name'
    ) {
      return String(row.fatherName ?? '');
    }
    if (
      normTag === 'student name' ||
      normTag === 'students name' ||
      normTag === 'student' ||
      normTag === 'ward name' ||
      normTag === 'child name' ||
      normTag === 'name'
    ) {
      return String(row.studentName ?? '');
    }
    if (
      normTag === 'mobile number' ||
      normTag === 'mobile no' ||
      normTag === 'contact no' ||
      normTag === 'contact number' ||
      normTag === 'mobile' ||
      normTag === 'phone' ||
      normTag === 'whatsapp number'
    ) {
      return String(row.normalizedMobile ?? row.mobileRaw ?? '');
    }

    // 4. Match without special characters (alphanumeric only)
    const alphaTag = trimmedTag.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (alphaTag) {
      const foundAlphaKey = rawKeys.find(
        (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === alphaTag
      );
      if (
        foundAlphaKey &&
        rawRecord[foundAlphaKey] !== undefined &&
        rawRecord[foundAlphaKey] !== null
      ) {
        return String(rawRecord[foundAlphaKey]);
      }
    }

    // If tag not found in row, keep the placeholder unchanged
    return fullMatch;
  });
}

function waitWithAbort(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore missing/already removed temp files
  }
}

// --- API Routes ---

app.get('/status', (req, res) => {
  res.json({
    status: waState.status,
    qrDataUrl: waState.qrDataUrl,
    user: waState.user,
    lastError: waState.lastError,
    campaignRunning: campaign.running,
    reportAvailable: Boolean(campaign.latestReportCsv),
  });
});

app.post('/logout', async (req, res) => {
  if (campaign.running) {
    return res.status(409).json({
      error: 'A bulk campaign is currently running. Stop the campaign before switching numbers.',
    });
  }

  isManualLogout = true;
  clearReconnectTimer();

  const sockToClose = currentSock;
  currentSock = null;

  try {
    if (sockToClose) {
      try {
        await sockToClose.logout();
      } catch {
        // Socket may already be closed/unauthenticated
      }
      try {
        sockToClose.end(undefined);
      } catch {
        // Ignore
      }
    }

    await fsp.rm(AUTH_DIR, { recursive: true, force: true });

    waState.status = 'connecting';
    waState.qrDataUrl = null;
    waState.user = null;
    waState.lastError = null;
    isManualLogout = false;

    void initWhatsApp();

    return res.json({
      ok: true,
      message: 'Disconnected successfully. Generating a new QR code...',
    });
  } catch (err) {
    isManualLogout = false;
    return res.status(500).json({
      error: `Failed to disconnect session: ${err.message}`,
    });
  }
});

function parseNumberList(numbersText) {
  const tokens = String(numbersText ?? '')
    .split(/[\r\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const validRows = [];
  const invalidRows = [];
  const allRows = [];

  tokens.forEach((rawMobile, idx) => {
    const rowNumber = idx + 1;
    const phoneCheck = normalizeMobileNumber(rawMobile);
    const entry = {
      rowNumber,
      ledgerNumber: '',
      fatherName: '',
      studentName: `Number #${rowNumber}`,
      mobileRaw: rawMobile,
      normalizedMobile: phoneCheck.valid ? phoneCheck.normalized : rawMobile,
      jid: phoneCheck.valid ? phoneCheck.jid : null,
      valid: phoneCheck.valid,
      reason: phoneCheck.valid ? '' : phoneCheck.reason,
      raw: { 'Mobile Number': rawMobile },
    };

    allRows.push(entry);
    if (entry.valid) {
      validRows.push(entry);
    } else {
      invalidRows.push(entry);
    }
  });

  return {
    totalRows: allRows.length,
    validRows,
    invalidRows,
    allRows,
  };
}

function parseDelayRange(body) {
  let rawMin = body?.minDelaySec;
  let rawMax = body?.maxDelaySec;

  if (rawMin === undefined && body?.minDelayMin !== undefined) {
    rawMin = Number(body.minDelayMin) * 60;
  }
  if (rawMax === undefined && body?.maxDelayMin !== undefined) {
    rawMax = Number(body.maxDelayMin) * 60;
  }

  const minSec =
    rawMin !== undefined && rawMin !== '' ? Number(rawMin) : MIN_DELAY_MS / 1000;
  const maxSec =
    rawMax !== undefined && rawMax !== '' ? Number(rawMax) : MAX_DELAY_MS / 1000;

  if (!Number.isFinite(minSec) || !Number.isFinite(maxSec)) {
    throw new Error('Delay values must be valid numbers.');
  }
  if (minSec < 0 || maxSec < 0 || maxSec > MAX_DELAY_SEC) {
    throw new Error(`Delay seconds must be between 0 and ${MAX_DELAY_SEC} (maximum 20 minutes).`);
  }
  if (minSec > maxSec) {
    throw new Error('Minimum delay seconds cannot be greater than maximum delay seconds.');
  }

  return {
    minDelaySec: minSec,
    maxDelaySec: maxSec,
    minDelayMs: Math.round(minSec * 1000),
    maxDelayMs: Math.round(maxSec * 1000),
  };
}

function parseTypingRange(body, delayRange) {
  const simulateTyping = body?.simulateTyping !== 'false' && body?.simulateTyping !== false;
  if (!simulateTyping) {
    return {
      enabled: false,
      minTypingSec: 0,
      maxTypingSec: 0,
      minTypingMs: 0,
      maxTypingMs: 0,
    };
  }

  const rawMin = body?.minTypingSec;
  const rawMax = body?.maxTypingSec;

  const minSec =
    rawMin !== undefined && rawMin !== '' ? Number(rawMin) : 2;
  const maxSec =
    rawMax !== undefined && rawMax !== '' ? Number(rawMax) : 4;

  if (!Number.isFinite(minSec) || !Number.isFinite(maxSec)) {
    throw new Error('Typing indicator duration values must be valid numbers in seconds.');
  }
  if (minSec < 0 || maxSec < 0 || maxSec > 300) {
    throw new Error('Typing indicator duration seconds must be between 0 and 300.');
  }
  if (minSec > maxSec) {
    throw new Error(
      `Minimum typing indicator duration (${minSec}s) cannot be greater than maximum typing duration (${maxSec}s).`
    );
  }
  if (delayRange && maxSec > delayRange.minDelaySec) {
    const formattedDelay =
      delayRange.minDelaySec >= 60
        ? `${(delayRange.minDelaySec / 60).toFixed(1)}m (${delayRange.minDelaySec}s)`
        : `${delayRange.minDelaySec}s`;
    throw new Error(
      `Typing indicator duration (max ${maxSec}s) must be within the random delay time (minimum delay is ${formattedDelay}).`
    );
  }

  return {
    enabled: true,
    minTypingSec: minSec,
    maxTypingSec: maxSec,
    minTypingMs: Math.round(minSec * 1000),
    maxTypingMs: Math.round(maxSec * 1000),
  };
}

app.post('/preview-csv', upload.single('csv'), async (req, res) => {
  const csvFile = req.file;
  if (!csvFile) {
    return res.status(400).json({ error: 'Please select a .csv file to preview.' });
  }

  try {
    const parsed = await parseStudentCsv(csvFile.path);
    return res.json({
      totalRows: parsed.totalRows,
      validCount: parsed.validRows.length,
      invalidCount: parsed.invalidRows.length,
      headers: parsed.headers,
      detectedColumns: parsed.columnMap,
      rows: parsed.allRows.map((r) => ({
        rowNumber: r.rowNumber,
        ledgerNumber: r.ledgerNumber,
        fatherName: r.fatherName,
        studentName: r.studentName,
        mobileRaw: r.mobileRaw,
        normalizedMobile: r.normalizedMobile,
        valid: r.valid,
        reason: r.reason,
        raw: r.raw,
      })),
      previewRows: parsed.validRows.slice(0, 3).map((r) => ({
        rowNumber: r.rowNumber,
        ledgerNumber: r.ledgerNumber,
        fatherName: r.fatherName,
        studentName: r.studentName,
        mobileRaw: r.mobileRaw,
        normalizedMobile: r.normalizedMobile,
        raw: r.raw,
      })),
      invalidRows: parsed.invalidRows.map((r) => ({
        rowNumber: r.rowNumber,
        ledgerNumber: r.ledgerNumber,
        fatherName: r.fatherName,
        studentName: r.studentName,
        mobileRaw: r.mobileRaw,
        reason: r.reason,
      })),
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  } finally {
    await safeUnlink(csvFile.path);
  }
});

app.post(
  '/send-bulk',
  upload.fields([
    { name: 'csv', maxCount: 1 },
    { name: 'image', maxCount: 1 },
  ]),
  async (req, res) => {
    const csvFile = req.files?.csv?.[0];
    const imageFile = req.files?.image?.[0];
    const numbersText = String(req.body?.numbersText ?? '').trim();
    const template = String(req.body?.message ?? '').trim();

    const cleanupFiles = async () => {
      await safeUnlink(csvFile?.path);
      await safeUnlink(imageFile?.path);
    };

    if (campaign.running) {
      await cleanupFiles();
      return res.status(409).json({ error: 'A bulk campaign is already in progress.' });
    }

    if (waState.status !== 'connected' || !currentSock) {
      await cleanupFiles();
      return res.status(400).json({
        error: 'WhatsApp is not connected. Please scan the QR code before starting a campaign.',
      });
    }

    if (!csvFile && !numbersText) {
      await cleanupFiles();
      return res.status(400).json({
        error: 'Please upload a CSV file or enter phone numbers to start a campaign.',
      });
    }

    if (!template) {
      await cleanupFiles();
      return res.status(400).json({ error: 'Message template cannot be empty.' });
    }

    if (imageFile && !String(imageFile.mimetype || '').startsWith('image/')) {
      await cleanupFiles();
      return res.status(400).json({ error: 'Attached media must be a valid image file.' });
    }

    let delayRange;
    try {
      delayRange = parseDelayRange(req.body);
    } catch (err) {
      await cleanupFiles();
      return res.status(400).json({ error: err.message });
    }

    let typingRange;
    try {
      typingRange = parseTypingRange(req.body, delayRange);
    } catch (err) {
      await cleanupFiles();
      return res.status(400).json({ error: err.message });
    }

    let parsedInput;
    try {
      parsedInput = csvFile
        ? await parseStudentCsv(csvFile.path)
        : parseNumberList(numbersText);
    } catch (err) {
      await cleanupFiles();
      return res.status(400).json({ error: err.message });
    }

    let targetValidRows = parsedInput.validRows;
    let targetInvalidRows = parsedInput.invalidRows;

    if (csvFile && req.body?.selectedRowNumbers !== undefined) {
      let selectedList;
      try {
        selectedList = JSON.parse(String(req.body.selectedRowNumbers));
      } catch {
        await cleanupFiles();
        return res.status(400).json({ error: 'Invalid selectedRowNumbers format.' });
      }
      if (!Array.isArray(selectedList) || selectedList.length === 0) {
        await cleanupFiles();
        return res.status(400).json({ error: 'Please select at least one recipient row to send.' });
      }
      const selectedSet = new Set(selectedList.map(Number));
      targetValidRows = parsedInput.validRows.filter((r) => selectedSet.has(r.rowNumber));
      targetInvalidRows = [];
    }

    if (targetValidRows.length === 0) {
      await cleanupFiles();
      return res.status(400).json({
        error: 'No valid mobile numbers selected to send.',
      });
    }

    // Begin campaign and stream SSE telemetry
    campaign.running = true;
    campaign.abortRequested = false;
    campaign.abortController = new AbortController();
    campaign.latestReportCsv = null;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    req.socket?.setTimeout(0);
    req.socket?.setKeepAlive?.(true, 15000);
    res.flushHeaders?.();

    // Periodic SSE keep-alive comment so browsers and proxies don't drop during long (up to 20 mins) anti-ban delays
    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(': keepalive\n\n');
      }
    }, 15000);

    const sendEvent = (payload) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    const total = targetValidRows.length + targetInvalidRows.length;
    let sent = 0;
    let failed = 0;
    let current = 0;
    const reportRows = [];

    try {
      const imageBuffer = imageFile ? fs.readFileSync(imageFile.path) : null;

      sendEvent({
        type: 'start',
        sent,
        failed,
        current,
        total,
        validTotal: targetValidRows.length,
        minDelaySec: delayRange.minDelaySec,
        maxDelaySec: delayRange.maxDelaySec,
        simulateTyping: typingRange.enabled,
        minTypingSec: typingRange.minTypingSec,
        maxTypingSec: typingRange.maxTypingSec,
        status: 'running',
      });

      // Log invalid/skipped rows immediately so every attempted recipient appears in delivery_report.csv
      for (const badRow of targetInvalidRows) {
        current += 1;
        failed += 1;
        const entry = {
          ledgerNumber: badRow.ledgerNumber,
          fatherName: badRow.fatherName,
          studentName: badRow.studentName || `Row #${badRow.rowNumber}`,
          mobile: badRow.mobileRaw || 'N/A',
          status: 'Failed',
          reason: badRow.reason,
        };
        reportRows.push(entry);
        sendEvent({
          type: 'progress',
          sent,
          failed,
          current,
          total,
          status: 'running',
          entry,
        });
      }

      let nextTypingMs = 0;
      if (typingRange.enabled) {
        nextTypingMs =
          typingRange.maxTypingMs > typingRange.minTypingMs
            ? crypto.randomInt(typingRange.minTypingMs, typingRange.maxTypingMs + 1)
            : typingRange.minTypingMs;
      }

      const validRows = targetValidRows;
      for (let i = 0; i < validRows.length; i += 1) {
        const row = validRows[i];

        if (campaign.abortRequested) {
          // Record remaining unsent rows as stopped/failed in the delivery report
          for (let j = i; j < validRows.length; j += 1) {
            const remaining = validRows[j];
            current += 1;
            failed += 1;
            const entry = {
              ledgerNumber: remaining.ledgerNumber,
              fatherName: remaining.fatherName,
              studentName: remaining.studentName || `Row #${remaining.rowNumber}`,
              mobile: remaining.normalizedMobile,
              status: 'Failed',
              reason: 'Campaign stopped by user',
            };
            reportRows.push(entry);
            sendEvent({
              type: 'progress',
              sent,
              failed,
              current,
              total,
              status: 'stopped',
              entry,
            });
          }
          break;
        }

        const personalizedMsg = personalizeMessage(template, row);
        let status = 'Sent';
        let reason = 'Delivered to WhatsApp';

        const currentTypingMs = nextTypingMs;

        if (waState.status !== 'connected' || !currentSock) {
          status = 'Failed';
          reason = 'WhatsApp socket disconnected';
        } else {
          try {
            // Optional humanized typing indicator simulation
            if (typingRange.enabled && currentTypingMs > 0 && !campaign.abortRequested) {
              sendEvent({
                type: 'typing',
                studentName: row.studentName,
                fatherName: row.fatherName,
                mobile: row.normalizedMobile,
                typingMs: currentTypingMs,
                sent,
                failed,
                current,
                total,
                status: 'typing',
              });

              try {
                await currentSock.sendPresenceUpdate('composing', row.jid);
              } catch {
                // Ignore presence update error if non-fatal
              }

              await waitWithAbort(currentTypingMs, campaign.abortController.signal);

              try {
                await currentSock.sendPresenceUpdate('paused', row.jid);
              } catch {
                // Ignore
              }
            }

            if (campaign.abortRequested) {
              status = 'Failed';
              reason = 'Campaign stopped by user';
            } else {
              const payload = imageBuffer
                ? { image: imageBuffer, caption: personalizedMsg }
                : { text: personalizedMsg };
              await currentSock.sendMessage(row.jid, payload);
            }
          } catch (sendErr) {
            status = 'Failed';
            reason = sendErr?.message || 'Unknown send error';
          }
        }

        current += 1;
        if (status === 'Sent') {
          sent += 1;
        } else {
          failed += 1;
        }

        const entry = {
          ledgerNumber: row.ledgerNumber,
          fatherName: row.fatherName,
          studentName: row.studentName || `Row #${row.rowNumber}`,
          mobile: row.normalizedMobile,
          status,
          reason,
        };
        reportRows.push(entry);

        sendEvent({
          type: 'progress',
          sent,
          failed,
          current,
          total,
          status: 'running',
          entry,
        });

        // Variable randomized delay between messages, with typing indicator happening for upcoming recipient
        const hasMore = i < validRows.length - 1;
        if (hasMore && !campaign.abortRequested) {
          const totalDelayMs =
            delayRange.maxDelayMs > delayRange.minDelayMs
              ? crypto.randomInt(delayRange.minDelayMs, delayRange.maxDelayMs + 1)
              : delayRange.minDelayMs;

          if (typingRange.enabled) {
            nextTypingMs =
              typingRange.maxTypingMs > typingRange.minTypingMs
                ? crypto.randomInt(typingRange.minTypingMs, typingRange.maxTypingMs + 1)
                : typingRange.minTypingMs;
            if (nextTypingMs > totalDelayMs) {
              nextTypingMs = totalDelayMs;
            }
          } else {
            nextTypingMs = 0;
          }

          const idlePauseMs = Math.max(0, totalDelayMs - nextTypingMs);

          if (idlePauseMs > 0 && !campaign.abortRequested) {
            const nextRecipient = validRows[i + 1];
            sendEvent({
              type: 'waiting',
              delayMs: idlePauseMs,
              totalDelayMs,
              upcomingTypingMs: nextTypingMs,
              nextRecipient: nextRecipient?.studentName || nextRecipient?.normalizedMobile,
              sent,
              failed,
              current,
              total,
              status: 'waiting',
            });
            await waitWithAbort(idlePauseMs, campaign.abortController.signal);
          }
        }
      }

      campaign.latestReportCsv = buildDeliveryReportCsv(reportRows);

      sendEvent({
        type: 'complete',
        sent,
        failed,
        current,
        total,
        status: campaign.abortRequested ? 'stopped' : 'completed',
        aborted: campaign.abortRequested,
        reportAvailable: true,
      });
    } catch (err) {
      if (reportRows.length > 0) {
        campaign.latestReportCsv = buildDeliveryReportCsv(reportRows);
      }
      sendEvent({
        type: 'error',
        sent,
        failed,
        current,
        total,
        status: 'error',
        error: err.message || 'Campaign encountered an unexpected error.',
        reportAvailable: Boolean(campaign.latestReportCsv),
      });
    } finally {
      clearInterval(keepAliveTimer);
      await cleanupFiles();
      campaign.running = false;
      campaign.abortController = null;
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
);

app.post('/stop-bulk', (req, res) => {
  if (!campaign.running) {
    return res.status(200).json({ ok: true, message: 'No active campaign is running.' });
  }
  campaign.abortRequested = true;
  campaign.abortController?.abort();
  return res.json({ ok: true, message: 'Stop signal sent. Halting campaign...' });
});

app.get('/download-report', (req, res) => {
  if (!campaign.latestReportCsv) {
    return res.status(404).json({ error: 'No delivery report is available yet.' });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="delivery_report.csv"');
  return res.send(campaign.latestReportCsv);
});

// Express error handler (including multer file-size/upload errors)
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `File upload error: ${err.message}` });
  }
  return res.status(500).json({ error: err?.message || 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`School WhatsApp Bulk Notification Portal running at http://localhost:${PORT}`);
  void initWhatsApp();
});

function gracefulShutdown() {
  clearReconnectTimer();
  isManualLogout = true;
  campaign.abortRequested = true;
  campaign.abortController?.abort();
  try {
    currentSock?.end(undefined);
  } catch {
    // Ignore
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

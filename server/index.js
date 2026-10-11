/* ==========================================================================
   Digital IT Move — Resume Builder Backend
   - Express static + JSON API
   - Multer file uploads (PDF/JPG/PNG/DOC/DOCX, max 8MB each, 5 files)
   - Nodemailer via Gmail SMTP -> avipatmase@gmail.com
   - Stripe Checkout for $1 second resume
   - Signed cookie counter (1st free, then $1)
   - Rate limiting + honeypot + security headers
   ========================================================================== */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const Stripe = require('stripe');

// -------- Config --------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'change-me-in-production-please';
const TARGET_EMAIL = process.env.TARGET_EMAIL || 'avipatmase@gmail.com';
const FROM_EMAIL = process.env.FROM_EMAIL || TARGET_EMAIL;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// -------- Mailer --------
let transporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  transporter.verify().then(
    () => console.log('[mail] Gmail SMTP verified ✓'),
    (err) => console.warn('[mail] SMTP verify failed:', err.message)
  );
} else {
  console.warn('[mail] GMAIL_USER / GMAIL_APP_PASSWORD not set — emails will be queued to disk only.');
}

// -------- Stripe --------
let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = new Stripe(STRIPE_SECRET_KEY);
  console.log('[stripe] Stripe initialized ✓');
} else {
  console.warn('[stripe] STRIPE_SECRET_KEY not set — $1 payment endpoint will be disabled.');
}

// -------- Multer (file uploads) --------
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx']);
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB
const MAX_FILES = 5;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-80);
    cb(null, `${ts}-${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES + 1 /* allow profile image */ },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
      return cb(new Error(`Unsupported file type: ${file.originalname}`));
    }
    cb(null, true);
  },
});

// -------- Cookie-signed counter --------
function getRequestCount(req) {
  const raw = req.signedCookies.ditmove_count;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function setRequestCount(res, n) {
  res.cookie('ditmove_count', String(n), {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    signed: true,
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    path: '/',
  });
}

// -------- App --------
const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'connect-src': ["'self'", 'https://api.stripe.com'],
      'frame-src': ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors({ origin: PUBLIC_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(COOKIE_SECRET));

// Serve static
app.use(express.static(ROOT, { extensions: ['html'], maxAge: '1h' }));

// Rate limit on API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', apiLimiter);

// -------- Helpers --------
const submissionId = () => 'DRM-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

function sanitizeText(v, max = 1000) {
  if (v == null) return '';
  return String(v).replace(/[<>]/g, (c) => ({ '<': '&lt;', '>': '&gt;' }[c])).trim().slice(0, max);
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function buildEmailBody(d, files) {
  const row = (k, v) => `<tr><td style="padding:6px 12px;background:#f4f6fb;font-weight:600;width:200px;color:#0a1428;">${escapeHtml(k)}</td><td style="padding:6px 12px;color:#0a1428;">${v || '—'}</td></tr>`;
  const link = (u) => u ? `<a href="${escapeHtml(u)}" style="color:#1e40af;">${escapeHtml(u)}</a>` : '';
  const list = (arr) => arr && arr.length ? arr.map((x) => escapeHtml(JSON.stringify(x))).join('<br>') : '—';

  return `
  <div style="font-family:Inter,system-ui,Arial,sans-serif;background:#f4f6fb;padding:24px;">
    <div style="max-width:680px;margin:0 auto;background:white;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
      <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);padding:24px;color:white;">
        <h1 style="margin:0;font-size:22px;">New Resume Creation Request</h1>
        <p style="margin:8px 0 0;opacity:0.9;font-size:14px;">Submission ID: <strong>${escapeHtml(d.submissionId)}</strong> · ${escapeHtml(d.requestLabel)}</p>
      </div>
      <div style="padding:20px 24px;">
        <h2 style="font-size:16px;color:#0a1428;margin:0 0 12px;">Personal</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Full Name', escapeHtml(d.fullName))}
          ${row('Mobile', escapeHtml(d.mobile))}
          ${row('Email', `<a href="mailto:${escapeHtml(d.email)}" style="color:#1e40af;">${escapeHtml(d.email)}</a>`)}
          ${row('Current Title', escapeHtml(d.currentTitle))}
          ${row('Current Organization', escapeHtml(d.currentOrg))}
          ${row('Years of Experience', escapeHtml(d.yearsExperience))}
          ${row('Target Job / Field', escapeHtml(d.targetJob))}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Education</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Records', list(d.education))}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Certifications</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Records', list(d.certs))}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Experience</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Records', list(d.experience))}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Skills &amp; About</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Skills', (d.skills || []).map(escapeHtml).join(', '))}
          ${row('About', escapeHtml(d.about).replace(/\n/g, '<br>'))}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Online Profiles</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('LinkedIn', link(d.linkedin))}
          ${row('GitHub', link(d.github))}
          ${row('Portfolio', link(d.portfolio))}
          ${row('Location', escapeHtml(d.location))}
          ${row('Other Link', link(d.otherLink))}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Preferences</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Resume Style', escapeHtml(d.resumeStyle))}
          ${row('Resume Color', escapeHtml(d.resumeColor))}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Files</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Attached', (files || []).map((f) => `${escapeHtml(f.originalname)} (${(f.size / 1024).toFixed(0)} KB)`).join('<br>') || 'None')}
        </table>

        <h2 style="font-size:16px;color:#0a1428;margin:24px 0 12px;">Meta</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row('Submission ID', escapeHtml(d.submissionId))}
          ${row('Request #', escapeHtml(d.requestLabel))}
          ${row('Submitted At', escapeHtml(d.submittedAt))}
        </table>

        <p style="margin-top:24px;font-size:12px;color:#64748b;">This message was generated automatically by the Digital IT Move resume portal.</p>
      </div>
    </div>
  </div>
  `;
}

async function sendEmail(d, files) {
  const subject = `New Resume Creation Request – ${d.fullName || 'Anonymous'} [${d.submissionId}]`;
  const html = buildEmailBody(d, files);
  const text = `New resume request from ${d.fullName} (${d.email}, ${d.mobile}). Submission ID: ${d.submissionId}. ${d.requestLabel}.`;

  if (transporter) {
    return transporter.sendMail({
      from: `"Digital IT Move" <${FROM_EMAIL}>`,
      to: TARGET_EMAIL,
      replyTo: d.email || FROM_EMAIL,
      subject,
      text,
      html,
      attachments: (files || []).map((f) => ({ filename: f.originalname, path: f.path })),
    });
  }

  // Fallback: write to disk
  const out = path.join(UPLOAD_DIR, `email-${d.submissionId}.html`);
  fs.writeFileSync(out, html, 'utf8');
  console.log(`[mail] SMTP not configured — wrote email to ${out}`);
  return { queued: true, fallbackPath: out };
}

function deleteFiles(files) {
  if (!files) return;
  // Accepts an array OR a multer-fields object like { documents: [...], profileImage: [...] }
  const list = Array.isArray(files)
    ? files
    : Object.values(files || {}).flat().filter((x) => x && x.path);
  list.forEach((f) => {
    try { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
  });
}

// -------- Routes --------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    mail: !!transporter,
    stripe: !!stripe,
    target: TARGET_EMAIL,
  });
});

app.get('/api/resume/status', (req, res) => {
  const count = getRequestCount(req);
  res.json({
    requestCount: count,
    isFree: count < 1,
    price: count < 1 ? 0 : 1,
  });
});

// Stripe Checkout for $1 second resume
app.post('/api/resume/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured on this server.' });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Professional Resume Creation' },
          unit_amount: 100, // $1.00
        },
        quantity: 1,
      }],
      success_url: `${PUBLIC_URL}/?paid=1&session_id={CHECKOUT_SESSION_ID}#form`,
      cancel_url: `${PUBLIC_URL}/?paid=cancelled#form`,
      metadata: { type: 'resume_creation', price: '1.00' },
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[stripe]', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Multer 2.x: use upload.fields to handle multiple field types in one pass.
const resumeUpload = upload.fields([
  { name: 'documents', maxCount: MAX_FILES },
  { name: 'profileImage', maxCount: 1 },
]);

// Submit
app.post('/api/resume/submit', (req, res, next) => {
  resumeUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    // Honeypot
    if (req.body.company_hp) {
      console.warn('[spam] honeypot triggered');
      return res.json({ ok: true, submissionId: 'SPAM-IGNORED' });
    }

    const count = getRequestCount(req);
    const isPaid = req.body.paid === 'true';
    if (count >= 1 && !isPaid) {
      return res.status(402).json({ error: 'Payment required for additional resumes.' });
    }

    // Validate required fields
    const fullName = sanitizeText(req.body.fullName, 120);
    const email = sanitizeText(req.body.email, 160);
    const mobile = sanitizeText(req.body.mobile, 30);
    const currentTitle = sanitizeText(req.body.currentTitle, 120);
    if (!fullName || !email || !mobile || !currentTitle) {
      deleteFiles(req.files || []);
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      deleteFiles(req.files || []);
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const sid = submissionId();
    const newCount = count + 1;
    setRequestCount(res, newCount);

    const data = {
      submissionId: sid,
      requestCount: newCount,
      requestLabel: newCount === 1 ? '1st — FREE' : `#${newCount} — $1 paid`,
      fullName,
      mobile,
      email,
      currentTitle,
      currentOrg: sanitizeText(req.body.currentOrg, 120),
      yearsExperience: sanitizeText(req.body.yearsExperience, 20),
      targetJob: sanitizeText(req.body.targetJob, 160),
      about: sanitizeText(req.body.about, 3000),
      linkedin: sanitizeText(req.body.linkedin, 200),
      github: sanitizeText(req.body.github, 200),
      portfolio: sanitizeText(req.body.portfolio, 200),
      location: sanitizeText(req.body.location, 120),
      otherLink: sanitizeText(req.body.otherLink, 200),
      resumeStyle: sanitizeText(req.body.resumeStyle, 40),
      resumeColor: sanitizeText(req.body.resumeColor, 40),
      education: asArray(req.body.education).map((e) => ({
        qualification: sanitizeText(e?.qualification, 80),
        course: sanitizeText(e?.course, 160),
        college: sanitizeText(e?.college, 160),
        year: sanitizeText(e?.year, 20),
        description: sanitizeText(e?.description, 500),
      })),
      certs: asArray(req.body.certs).map((c) => ({
        name: sanitizeText(c?.name, 160),
        org: sanitizeText(c?.org, 160),
        year: sanitizeText(c?.year, 20),
      })),
      experience: asArray(req.body.experience).map((x) => ({
        title: sanitizeText(x?.title, 120),
        company: sanitizeText(x?.company, 120),
        duration: sanitizeText(x?.duration, 80),
        responsibilities: sanitizeText(x?.responsibilities, 1000),
        achievements: sanitizeText(x?.achievements, 1000),
      })),
      skills: asArray(req.body.skills ? (typeof req.body.skills === 'string' ? req.body.skills.split(',') : req.body.skills) : []).map((s) => sanitizeText(s, 60)),
      submittedAt: new Date().toISOString(),
    };

    const files = [
      ...((req.files && req.files.documents) || []),
      ...((req.files && req.files.profileImage) || []),
    ];

    let emailResult;
    try {
      emailResult = await sendEmail(data, files);
    } catch (err) {
      console.error('[mail] send failed:', err.message);
      // Don't fail the request if email is broken — files are still saved
      emailResult = { error: err.message };
    }

    res.json({
      ok: true,
      submissionId: sid,
      requestCount: newCount,
      paid: newCount > 1,
      emailSent: !!(emailResult && emailResult.accepted),
      emailFallback: !!(emailResult && emailResult.fallbackPath),
    });
  } catch (err) {
    console.error('[submit] error:', err);
    deleteFiles(req.files || []);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Stripe webhook (for production verification — optional)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(200).end();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe webhook]', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    console.log('[stripe] payment completed', event.data.object.id);
  }
  res.json({ received: true });
});

// 404 fallback (SPA-friendly)
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// Multer error handler
app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, () => {
  console.log(`\n  Digital IT Move — Resume Builder`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → env: ${NODE_ENV}`);
  console.log(`  → mail: ${transporter ? 'enabled' : 'fallback (disk only)'}`);
  console.log(`  → stripe: ${stripe ? 'enabled' : 'disabled'}\n`);
});

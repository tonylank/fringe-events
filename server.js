'use strict';
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const { parse: csvParse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── Database ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        event_date TIMESTAMPTZ NOT NULL,
        end_date TIMESTAMPTZ,
        venue_name TEXT,
        venue_address TEXT,
        venue_lat FLOAT,
        venue_lng FLOAT,
        description TEXT,
        hero_image_url TEXT,
        dress_code TEXT,
        rsvp_deadline DATE,
        max_guests INTEGER,
        allow_plus_one BOOLEAN DEFAULT false,
        check_in_pin TEXT,
        email_subject TEXT,
        email_from_name TEXT,
        email_reply_to TEXT,
        status TEXT DEFAULT 'draft',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS guests (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        notes TEXT,
        tags TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS event_guests (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
        rsvp_code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'pending',
        plus_one_name TEXT,
        dietary_requirements TEXT,
        seat_label TEXT,
        notes TEXT,
        checked_in_at TIMESTAMPTZ,
        checked_in_by TEXT,
        invitation_sent_at TIMESTAMPTZ,
        reminder_sent_at TIMESTAMPTZ,
        rsvp_submitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(event_id, guest_id)
      );

      CREATE TABLE IF NOT EXISTS event_questions (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        question_text TEXT NOT NULL,
        question_type TEXT DEFAULT 'text',
        options JSONB,
        required BOOLEAN DEFAULT false,
        sort_order INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS rsvp_answers (
        id SERIAL PRIMARY KEY,
        event_guest_id INTEGER REFERENCES event_guests(id) ON DELETE CASCADE,
        question_id INTEGER REFERENCES event_questions(id) ON DELETE CASCADE,
        answer TEXT,
        UNIQUE(event_guest_id, question_id)
      );
    `);

    // Seed default admin if none exists
    const { rows } = await client.query('SELECT COUNT(*) FROM admin_users');
    if (parseInt(rows[0].count) === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
      await client.query(
        'INSERT INTO admin_users (email, name, password_hash) VALUES ($1, $2, $3)',
        [process.env.ADMIN_EMAIL || 'admin@example.com', 'Admin', hash]
      );
      console.log('Seeded default admin:', process.env.ADMIN_EMAIL || 'admin@example.com');
    }

    console.log('DB migration complete');
  } finally {
    client.release();
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
// CSP — allow inline scripts/styles (app uses no external JS libs), Google Maps iframe, any img src
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src * data: blob:; " +
    "connect-src 'self'; " +
    "frame-src https://www.google.com; " +
    "font-src 'self' data:");
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }
}));

const requireAuth = (req, res, next) => {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorised' });
  next();
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function genSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    + '-' + Date.now().toString(36);
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

function fmtTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

function gcalDate(d) {
  if (!d) return '';
  return new Date(d).toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
}

function generateICS(event, guestEmail, guestName) {
  const pad = n => String(n).padStart(2,'0');
  const dt = (d) => {
    const x = new Date(d);
    return `${x.getUTCFullYear()}${pad(x.getUTCMonth()+1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00Z`;
  };
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Fringe Events//EN','METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${event.id}-${Date.now()}@fringe-events`,
    `DTSTART:${dt(event.event_date)}`,
    `DTEND:${dt(event.end_date || event.event_date)}`,
    `SUMMARY:${event.name}`,
    `LOCATION:${[event.venue_name, event.venue_address].filter(Boolean).join(', ')}`,
    `DESCRIPTION:${(event.description||'').replace(/\n/g,'\\n')}`,
    `ORGANIZER;CN="${event.email_from_name||'Event Organiser'}":MAILTO:${process.env.EMAIL_FROM||'noreply@example.com'}`,
    `ATTENDEE;CN="${guestName}":MAILTO:${guestEmail}`,
    'STATUS:CONFIRMED','END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}

function buildInvitationHtml(event, guest, eventGuest) {
  const rsvpUrl = `${BASE_URL}/rsvp/${eventGuest.rsvp_code}`;
  const mapsUrl = event.venue_address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.venue_address)}`
    : null;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#f4f4f8;font-family:Georgia,serif}.w{max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}.hero{width:100%;height:200px;object-fit:cover;display:block;background:#2D1B69}.c{padding:40px}h1{margin:0 0 8px;font-size:28px;color:#2D1B69}.meta{color:#666;font-size:15px;margin-bottom:24px}.meta strong{color:#333}p{color:#444;line-height:1.7;font-size:16px}.btn{display:inline-block;margin:24px 0 12px;padding:16px 36px;background:#7C3AED;color:#fff!important;text-decoration:none;border-radius:8px;font-size:17px;font-weight:700}.ml{display:inline-block;margin-top:8px;color:#7C3AED;font-size:14px}.ft{padding:20px 40px;background:#f8f7ff;font-size:13px;color:#888;border-top:1px solid #eee}</style>
</head><body><div class="w">
${event.hero_image_url?`<img class="hero" src="${esc(event.hero_image_url)}" alt="${esc(event.name)}">`:`<div class="hero"></div>`}
<div class="c"><h1>${esc(event.name)}</h1>
<div class="meta"><strong>${fmtDate(event.event_date)}</strong> at <strong>${fmtTime(event.event_date)}</strong><br>
${event.venue_name?`<strong>${esc(event.venue_name)}</strong>${event.venue_address?', '+esc(event.venue_address):''}`:''}
${event.dress_code?`<br>Dress code: <strong>${esc(event.dress_code)}</strong>`:''}</div>
<p>Dear ${esc(guest.first_name)},</p>
<p>${esc(event.description||'You are cordially invited to join us for this special event.')}</p>
<p>Please click below to confirm your attendance:</p>
<a class="btn" href="${rsvpUrl}">RSVP Now →</a>
${event.rsvp_deadline?`<p style="font-size:13px;color:#888">Please respond by ${new Date(event.rsvp_deadline).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</p>`:''}
${mapsUrl?`<br><a class="ml" href="${mapsUrl}" target="_blank">📍 View on Google Maps</a>`:''}
</div>
<div class="ft">You received this invitation because you were added to the guest list.<br>To respond, visit: ${rsvpUrl}</div>
</div></body></html>`;
}

async function sendEmail({ to, toName, subject, html, text, attachments }) {
  if (!process.env.EMAIL_HOST) {
    console.log('[EMAIL SKIPPED - no EMAIL_HOST] To:', to, 'Subject:', subject);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
  await transporter.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME || 'Fringe Events'}" <${process.env.EMAIL_FROM}>`,
    to: `"${toName}" <${to}>`,
    subject, html, text, attachments
  });
}

// ─── RSVP Page Renderer ───────────────────────────────────────────────────────
function renderRsvpPage(event, guest, eventGuest, questions, answers) {
  const rsvpUrl = `${BASE_URL}/rsvp/${eventGuest.rsvp_code}`;
  const mapsEmbedUrl = process.env.GOOGLE_MAPS_API_KEY && (event.venue_lat && event.venue_lng)
    ? `https://www.google.com/maps/embed/v1/place?key=${process.env.GOOGLE_MAPS_API_KEY}&q=${event.venue_lat},${event.venue_lng}`
    : process.env.GOOGLE_MAPS_API_KEY && event.venue_address
    ? `https://www.google.com/maps/embed/v1/search?key=${process.env.GOOGLE_MAPS_API_KEY}&q=${encodeURIComponent(event.venue_address)}`
    : null;

  const isPastDeadline = event.rsvp_deadline && new Date(event.rsvp_deadline) < new Date();
  const canRsvp = !isPastDeadline && event.status !== 'closed';

  const googleCalUrl = `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(event.name)}&dates=${gcalDate(event.event_date)}/${gcalDate(event.end_date||event.event_date)}&details=${encodeURIComponent(event.description||'')}&location=${encodeURIComponent([event.venue_name,event.venue_address].filter(Boolean).join(', '))}`;

  const questionsHtml = questions.map(q => {
    const ans = (answers.find(a => a.question_id === q.id)||{}).answer || '';
    if (q.question_type === 'select' && Array.isArray(q.options)) {
      return `<div class="fg"><label>${esc(q.question_text)}${q.required?' *':''}</label><select name="q_${q.id}"${q.required?' required':''}><option value="">Select…</option>${q.options.map(o=>`<option${ans===o?' selected':''}>${esc(o)}</option>`).join('')}</select></div>`;
    }
    if (q.question_type === 'textarea') {
      return `<div class="fg"><label>${esc(q.question_text)}${q.required?' *':''}</label><textarea name="q_${q.id}" rows="3"${q.required?' required':''}>${esc(ans)}</textarea></div>`;
    }
    return `<div class="fg"><label>${esc(q.question_text)}${q.required?' *':''}</label><input type="text" name="q_${q.id}" value="${esc(ans)}"${q.required?' required':''}></div>`;
  }).join('');

  const statusBanner = eventGuest.status === 'accepted'
    ? `<div class="status-banner accepted">✓ You have confirmed attendance</div>`
    : eventGuest.status === 'declined'
    ? `<div class="status-banner declined">✗ You have declined this invitation</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(event.name)} — RSVP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0720;font-family:Georgia,'Times New Roman',serif;min-height:100vh;display:flex;align-items:center;justify-content:center}

/* Envelope */
.scene{perspective:1200px;width:100%;max-width:500px;padding:60px 20px}
.envelope{position:relative;width:100%;background:#f0e8d8;border-radius:4px;box-shadow:0 24px 64px rgba(0,0,0,.7);min-height:280px;overflow:visible}
.env-body{width:100%;height:280px;background:#f0e8d8;border-radius:4px;position:relative;overflow:hidden}
.fold-l{position:absolute;top:0;bottom:0;left:0;width:50%;background:#e8dece;clip-path:polygon(0 0,100% 45%,0 100%)}
.fold-r{position:absolute;top:0;bottom:0;right:0;width:50%;background:#e0d8c4;clip-path:polygon(0 45%,100% 0,100% 100%)}
.fold-b{position:absolute;bottom:0;left:0;right:0;height:55%;background:#d8d0bc;clip-path:polygon(0 100%,50% 0%,100% 100%)}
.flap{position:absolute;top:0;left:0;right:0;height:50%;background:#ece4d4;clip-path:polygon(0 0,50% 100%,100% 0);transform-origin:top center;transform:rotateX(0deg);transition:transform 1.2s cubic-bezier(.4,0,.2,1);z-index:10;will-change:transform}
.envelope.open .flap{transform:rotateX(-180deg)}
.card-wrap{position:absolute;bottom:8px;left:28px;right:28px;z-index:5;transform:translateY(0);opacity:0;transition:transform 1.2s cubic-bezier(.4,0,.2,1) 0.3s,opacity 0.4s 0.3s}
.envelope.open .card-wrap{transform:translateY(-200px);opacity:1}
.mini-card{background:#fff;border-radius:6px;padding:20px 24px;box-shadow:0 4px 20px rgba(0,0,0,.15);text-align:center}
.mini-card .eyebrow{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:8px}
.mini-card h2{color:#2D1B69;font-size:19px;margin-bottom:4px}
.mini-card .date{color:#666;font-size:13px}

/* Full page */
.rsvp-page{display:none;max-width:640px;width:100%;padding:20px}
.rsvp-page.vis{display:block}
.eyebrow-full{text-align:center;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#a78bfa;padding:16px 0 8px}
.hero-img{width:100%;height:220px;object-fit:cover;border-radius:12px 12px 0 0;display:block}
.hero-ph{width:100%;height:80px;background:linear-gradient(135deg,#2D1B69,#7C3AED);border-radius:12px 12px 0 0}
.card{background:#fff;padding:28px 32px;border-radius:0 0 12px 12px;box-shadow:0 8px 40px rgba(0,0,0,.15);margin-bottom:20px}
.card h1{font-size:24px;color:#2D1B69;margin-bottom:8px}
.meta{color:#666;font-size:15px;line-height:1.7;margin-bottom:16px}
.desc{color:#444;font-size:15px;line-height:1.7;border-top:1px solid #eee;padding-top:16px;margin-bottom:16px}
.status-banner{padding:12px 16px;border-radius:8px;font-size:14px;font-weight:700;margin-bottom:16px}
.status-banner.accepted{background:#d1fae5;color:#065f46}
.status-banner.declined{background:#fee2e2;color:#991b1b}
.rsvp-section{background:#fff;border-radius:12px;padding:28px 32px;box-shadow:0 4px 20px rgba(0,0,0,.08);margin-bottom:20px}
.rsvp-section h2{font-size:18px;color:#2D1B69;margin-bottom:20px}
.attend-btns{display:flex;gap:12px;margin-bottom:20px}
.btn-yes,.btn-no{flex:1;padding:14px;border:2px solid;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;background:#fff;transition:all .2s;font-family:inherit}
.btn-yes{border-color:#059669;color:#059669}
.btn-yes.on,.btn-yes:hover{background:#059669;color:#fff}
.btn-no{border-color:#DC2626;color:#DC2626}
.btn-no.on,.btn-no:hover{background:#DC2626;color:#fff}
.form-fields{display:none}.form-fields.vis{display:block}
.fg{margin-bottom:16px}
.fg label{display:block;font-size:13px;font-weight:700;color:#333;margin-bottom:6px}
.fg input,.fg select,.fg textarea{width:100%;padding:10px 14px;border:1.5px solid #ddd;border-radius:6px;font-size:15px;font-family:inherit;transition:border-color .2s}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:#7C3AED;outline:none}
.submit-btn{width:100%;padding:15px;background:#7C3AED;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s;margin-top:4px;font-family:inherit}
.submit-btn:hover{background:#6D28D9}.submit-btn:disabled{background:#ccc;cursor:not-allowed}
.success{display:none;background:#d1fae5;color:#065f46;padding:14px;border-radius:8px;text-align:center;font-size:15px;font-weight:700;margin-top:14px}
.success.vis{display:block}
.cal-section{background:#fff;border-radius:12px;padding:24px 32px;box-shadow:0 4px 20px rgba(0,0,0,.08);margin-bottom:20px}
.cal-section h3{font-size:15px;color:#2D1B69;margin-bottom:14px}
.cal-btns{display:flex;gap:10px;flex-wrap:wrap}
.cal-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:700;text-decoration:none;border:1.5px solid #2D1B69;color:#2D1B69;transition:all .2s}
.cal-btn:hover{background:#2D1B69;color:#fff}
.cal-btn.gcal{border-color:#4285f4;color:#4285f4}.cal-btn.gcal:hover{background:#4285f4;color:#fff}
.map-wrap{border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);margin-bottom:40px}
.map-wrap iframe{width:100%;height:240px;border:none;display:block}
.closed-msg{text-align:center;color:#888;padding:16px;font-size:15px}
@media(max-width:480px){.card,.rsvp-section,.cal-section{padding:20px}.attend-btns{flex-direction:column}}
</style>
</head>
<body>

<div class="scene" id="scene">
  <div class="envelope" id="env">
    <div class="env-body">
      <div class="fold-l"></div><div class="fold-r"></div><div class="fold-b"></div>
    </div>
    <div class="flap"></div>
    <div class="card-wrap">
      <div class="mini-card">
        <div class="eyebrow">You are invited</div>
        <h2>${esc(event.name)}</h2>
        <div class="date">${fmtDate(event.event_date)}</div>
      </div>
    </div>
  </div>
</div>

<div class="rsvp-page" id="page">
  <div class="eyebrow-full">Invitation</div>
  ${event.hero_image_url?`<img class="hero-img" src="${esc(event.hero_image_url)}" alt="${esc(event.name)}">`:`<div class="hero-ph"></div>`}
  <div class="card">
    <h1>${esc(event.name)}</h1>
    <div class="meta">
      <strong>📅 ${fmtDate(event.event_date)}</strong> at <strong>${fmtTime(event.event_date)}</strong><br>
      ${event.venue_name?`📍 <strong>${esc(event.venue_name)}</strong>${event.venue_address?', '+esc(event.venue_address):''}` : ''}
      ${event.dress_code?`<br>👔 Dress code: <strong>${esc(event.dress_code)}</strong>`:''}
    </div>
    ${event.description?`<div class="desc">${esc(event.description).replace(/\n/g,'<br>')}</div>`:''}
    <p style="font-size:15px;color:#444">Dear <strong>${esc(guest.first_name)} ${esc(guest.last_name)}</strong>,</p>
    ${statusBanner}
    ${event.rsvp_deadline?`<p style="font-size:13px;color:#888;margin-top:10px">Please respond by <strong>${new Date(event.rsvp_deadline).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</strong></p>`:''}
  </div>

  ${canRsvp ? `
  <div class="rsvp-section">
    <h2>Your Response</h2>
    <form id="rf" onsubmit="doSubmit(event)">
      <div class="attend-btns">
        <button type="button" class="btn-yes${eventGuest.status==='accepted'?' on':''}" onclick="pick('accepted')">✓ Attending</button>
        <button type="button" class="btn-no${eventGuest.status==='declined'?' on':''}" onclick="pick('declined')">✗ Decline</button>
      </div>
      <input type="hidden" id="si" name="status" value="${eventGuest.status||''}">
      <div class="form-fields${eventGuest.status==='accepted'?' vis':''}" id="ff">
        ${event.allow_plus_one?`<div class="fg"><label>Plus one name (optional)</label><input type="text" name="plus_one_name" value="${esc(eventGuest.plus_one_name||'')}"></div>`:''}
        <div class="fg"><label>Dietary requirements (optional)</label><input type="text" name="dietary" value="${esc(eventGuest.dietary_requirements||'')}"></div>
        ${questionsHtml}
      </div>
      <div class="success" id="ok">Thank you — your response has been saved ✓</div>
      <button class="submit-btn" id="sb">Save Response</button>
    </form>
  </div>
  ` : `<div class="rsvp-section"><p class="closed-msg">RSVP is now closed for this event.</p></div>`}

  ${eventGuest.status==='accepted'?`
  <div class="cal-section">
    <h3>Add to Calendar</h3>
    <div class="cal-btns">
      <a class="cal-btn gcal" href="${googleCalUrl}" target="_blank">📅 Google Calendar</a>
      <a class="cal-btn" href="/rsvp/${eventGuest.rsvp_code}/calendar.ics">📎 Download .ics</a>
    </div>
  </div>`:''}

  ${mapsEmbedUrl?`<div class="map-wrap"><iframe src="${mapsEmbedUrl}" allowfullscreen loading="lazy"></iframe></div>`:''}
</div>

<script>
let sel='${eventGuest.status||''}';
setTimeout(()=>document.getElementById('env').classList.add('open'),700);
setTimeout(()=>{document.getElementById('scene').style.display='none';document.getElementById('page').classList.add('vis');},2800);
function pick(s){
  sel=s;document.getElementById('si').value=s;
  document.querySelector('.btn-yes').classList.toggle('on',s==='accepted');
  document.querySelector('.btn-no').classList.toggle('on',s==='declined');
  document.getElementById('ff').classList.toggle('vis',s==='accepted');
}
async function doSubmit(e){
  e.preventDefault();
  if(!sel){alert('Please select whether you are attending.');return;}
  const btn=document.getElementById('sb');
  btn.disabled=true;btn.textContent='Saving…';
  const data={status:sel,answers:{}};
  new FormData(e.target).forEach((v,k)=>{
    if(k.startsWith('q_'))data.answers[k.replace('q_','')]=v;
    else if(k!=='status')data[k]=v;
  });
  try{
    const r=await fetch('/rsvp/${eventGuest.rsvp_code}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(r.ok){document.getElementById('ok').classList.add('vis');btn.textContent='Saved ✓';setTimeout(()=>location.reload(),1600);}
    else{const j=await r.json();btn.disabled=false;btn.textContent='Save Response';alert(j.error||'Failed — please try again.');}
  }catch{btn.disabled=false;btn.textContent='Save Response';alert('Network error — please try again.');}
}
</script>
</body></html>`;
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.adminId = rows[0].id;
    req.session.adminName = rows[0].name;
    res.json({ ok: true, name: rows[0].name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/admin/me', requireAuth, (req, res) => {
  res.json({ id: req.session.adminId, name: req.session.adminName });
});

// ─── Event Routes ─────────────────────────────────────────────────────────────
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.*,
        COUNT(DISTINCT eg.id) AS total_guests,
        COUNT(DISTINCT CASE WHEN eg.status='accepted' THEN eg.id END) AS accepted,
        COUNT(DISTINCT CASE WHEN eg.status='declined' THEN eg.id END) AS declined,
        COUNT(DISTINCT CASE WHEN eg.checked_in_at IS NOT NULL THEN eg.id END) AS checked_in
      FROM events e
      LEFT JOIN event_guests eg ON eg.event_id = e.id
      GROUP BY e.id ORDER BY e.event_date DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', requireAuth, async (req, res) => {
  const { name, event_date, end_date, venue_name, venue_address, venue_lat, venue_lng,
    description, hero_image_url, dress_code, rsvp_deadline, max_guests, allow_plus_one,
    check_in_pin, email_subject, email_from_name, email_reply_to, status } = req.body;
  if (!name || !event_date) return res.status(400).json({ error: 'Name and date required' });
  try {
    const slug = genSlug(name);
    const { rows } = await pool.query(`
      INSERT INTO events (slug,name,event_date,end_date,venue_name,venue_address,venue_lat,venue_lng,
        description,hero_image_url,dress_code,rsvp_deadline,max_guests,allow_plus_one,
        check_in_pin,email_subject,email_from_name,email_reply_to,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [slug,name,event_date,end_date||null,venue_name||null,venue_address||null,
       venue_lat||null,venue_lng||null,description||null,hero_image_url||null,
       dress_code||null,rsvp_deadline||null,max_guests||null,allow_plus_one||false,
       check_in_pin||null,email_subject||null,email_from_name||null,email_reply_to||null,
       status||'draft']);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
  const { name, event_date, end_date, venue_name, venue_address, venue_lat, venue_lng,
    description, hero_image_url, dress_code, rsvp_deadline, max_guests, allow_plus_one,
    check_in_pin, email_subject, email_from_name, email_reply_to, status } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE events SET name=$1,event_date=$2,end_date=$3,venue_name=$4,venue_address=$5,
        venue_lat=$6,venue_lng=$7,description=$8,hero_image_url=$9,dress_code=$10,
        rsvp_deadline=$11,max_guests=$12,allow_plus_one=$13,check_in_pin=$14,
        email_subject=$15,email_from_name=$16,email_reply_to=$17,status=$18,
        updated_at=NOW() WHERE id=$19 RETURNING *`,
      [name,event_date,end_date||null,venue_name||null,venue_address||null,
       venue_lat||null,venue_lng||null,description||null,hero_image_url||null,
       dress_code||null,rsvp_deadline||null,max_guests||null,allow_plus_one||false,
       check_in_pin||null,email_subject||null,email_from_name||null,email_reply_to||null,
       status||'draft',req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM events WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Guest Routes (master database) ──────────────────────────────────────────
app.get('/api/guests', requireAuth, async (req, res) => {
  const { q } = req.query;
  try {
    let query = 'SELECT * FROM guests';
    const params = [];
    if (q) {
      query += ` WHERE (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR company ILIKE $1)`;
      params.push(`%${q}%`);
    }
    query += ' ORDER BY last_name, first_name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/guests', requireAuth, async (req, res) => {
  const { email, first_name, last_name, phone, company, notes, tags } = req.body;
  if (!email || !first_name || !last_name) return res.status(400).json({ error: 'Email, first name and last name required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO guests (email,first_name,last_name,phone,company,notes,tags)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (email) DO UPDATE SET first_name=$2,last_name=$3,phone=$4,company=$5,notes=$6,tags=$7,updated_at=NOW()
      RETURNING *`,
      [email.toLowerCase().trim(),first_name.trim(),last_name.trim(),phone||null,company||null,notes||null,tags||null]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/guests/:id', requireAuth, async (req, res) => {
  const { email, first_name, last_name, phone, company, notes, tags } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE guests SET email=$1,first_name=$2,last_name=$3,phone=$4,company=$5,notes=$6,tags=$7,updated_at=NOW()
      WHERE id=$8 RETURNING *`,
      [email.toLowerCase().trim(),first_name.trim(),last_name.trim(),phone||null,company||null,notes||null,tags||null,req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/guests/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM guests WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guest event history
app.get('/api/guests/:id/events', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.name, e.event_date, e.slug,
             eg.status, eg.checked_in_at, eg.invitation_sent_at, eg.rsvp_code
      FROM event_guests eg
      JOIN events e ON e.id = eg.event_id
      WHERE eg.guest_id = $1
      ORDER BY e.event_date DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import guests from CSV
app.post('/api/guests/import', requireAuth, async (req, res) => {
  const { csv } = req.body; // raw CSV string
  if (!csv) return res.status(400).json({ error: 'No CSV data' });
  try {
    const records = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    let imported = 0, skipped = 0, errors = [];
    for (const r of records) {
      const email = (r.email || r.Email || r.EMAIL || '').toLowerCase().trim();
      const first_name = (r.first_name || r['First Name'] || r.firstname || r.first || '').trim();
      const last_name = (r.last_name || r['Last Name'] || r.lastname || r.last || '').trim();
      if (!email || !first_name) { skipped++; continue; }
      try {
        await pool.query(`
          INSERT INTO guests (email,first_name,last_name,phone,company,notes,tags)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (email) DO UPDATE SET first_name=$2,last_name=$3,phone=$4,company=$5,updated_at=NOW()`,
          [email, first_name, last_name || '', r.phone||null, r.company||null, r.notes||null, r.tags||null]);
        imported++;
      } catch (e) { errors.push(`${email}: ${e.message}`); skipped++; }
    }
    res.json({ imported, skipped, errors });
  } catch (e) { res.status(400).json({ error: 'CSV parse error: ' + e.message }); }
});

// ─── Event Guest Routes ───────────────────────────────────────────────────────
app.get('/api/events/:id/guests', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT eg.*, g.email, g.first_name, g.last_name, g.phone, g.company
      FROM event_guests eg
      JOIN guests g ON g.id = eg.guest_id
      WHERE eg.event_id = $1
      ORDER BY g.last_name, g.first_name`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add single guest to event (by guest_id)
app.post('/api/events/:id/guests', requireAuth, async (req, res) => {
  const { guest_id } = req.body;
  if (!guest_id) return res.status(400).json({ error: 'guest_id required' });
  try {
    const code = genCode();
    const { rows } = await pool.query(`
      INSERT INTO event_guests (event_id,guest_id,rsvp_code)
      VALUES ($1,$2,$3) ON CONFLICT (event_id,guest_id) DO NOTHING RETURNING *`,
      [req.params.id, guest_id, code]);
    if (!rows.length) return res.status(409).json({ error: 'Guest already in this event' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove guest from event
app.delete('/api/events/:eventId/guests/:guestId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM event_guests WHERE event_id=$1 AND guest_id=$2',
      [req.params.eventId, req.params.guestId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Copy guest list from another event
app.post('/api/events/:id/copy-guests-from/:sourceId', requireAuth, async (req, res) => {
  try {
    const { rows: sourceGuests } = await pool.query(
      'SELECT guest_id FROM event_guests WHERE event_id=$1', [req.params.sourceId]);
    let added = 0, skipped = 0;
    for (const sg of sourceGuests) {
      const code = genCode();
      try {
        await pool.query(
          'INSERT INTO event_guests (event_id,guest_id,rsvp_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [req.params.id, sg.guest_id, code]);
        added++;
      } catch { skipped++; }
    }
    res.json({ added, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Questions Routes ─────────────────────────────────────────────────────────
app.get('/api/events/:id/questions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM event_questions WHERE event_id=$1 ORDER BY sort_order', [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events/:id/questions', requireAuth, async (req, res) => {
  const { question_text, question_type, options, required, sort_order } = req.body;
  if (!question_text) return res.status(400).json({ error: 'Question text required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO event_questions (event_id,question_text,question_type,options,required,sort_order)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, question_text, question_type||'text',
       options ? JSON.stringify(options) : null, required||false, sort_order||0]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/events/:id/questions/:qid', requireAuth, async (req, res) => {
  const { question_text, question_type, options, required, sort_order } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE event_questions SET question_text=$1,question_type=$2,options=$3,required=$4,sort_order=$5
      WHERE id=$6 AND event_id=$7 RETURNING *`,
      [question_text, question_type||'text',
       options ? JSON.stringify(options) : null, required||false, sort_order||0,
       req.params.qid, req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id/questions/:qid', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM event_questions WHERE id=$1 AND event_id=$2',
      [req.params.qid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Email Routes ─────────────────────────────────────────────────────────────
app.post('/api/events/:id/send-invitations', requireAuth, async (req, res) => {
  const { guest_ids } = req.body; // optional filter
  try {
    const event = (await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id])).rows[0];
    if (!event) return res.status(404).json({ error: 'Event not found' });

    let query = `SELECT eg.*, g.email, g.first_name, g.last_name
      FROM event_guests eg JOIN guests g ON g.id=eg.guest_id WHERE eg.event_id=$1`;
    const params = [req.params.id];
    if (guest_ids?.length) {
      query += ` AND g.id = ANY($2)`;
      params.push(guest_ids);
    }
    const { rows: eventGuests } = await pool.query(query, params);

    let sent = 0, failed = 0, errors = [];
    for (const eg of eventGuests) {
      try {
        const html = buildInvitationHtml(event, eg, eg);
        const ics = generateICS(event, eg.email, `${eg.first_name} ${eg.last_name}`);
        await sendEmail({
          to: eg.email,
          toName: `${eg.first_name} ${eg.last_name}`,
          subject: event.email_subject || `You're invited: ${event.name}`,
          html,
          text: `You are invited to ${event.name}. RSVP at: ${BASE_URL}/rsvp/${eg.rsvp_code}`,
          attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar' }]
        });
        await pool.query('UPDATE event_guests SET invitation_sent_at=NOW() WHERE id=$1', [eg.id]);
        sent++;
      } catch (e) { failed++; errors.push(`${eg.email}: ${e.message}`); }
    }
    res.json({ sent, failed, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events/:id/send-reminders', requireAuth, async (req, res) => {
  try {
    const event = (await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id])).rows[0];
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { rows: pending } = await pool.query(`
      SELECT eg.*, g.email, g.first_name, g.last_name
      FROM event_guests eg JOIN guests g ON g.id=eg.guest_id
      WHERE eg.event_id=$1 AND eg.status='pending'`, [req.params.id]);

    let sent = 0, failed = 0;
    for (const eg of pending) {
      try {
        const html = buildInvitationHtml(event, eg, eg);
        await sendEmail({
          to: eg.email,
          toName: `${eg.first_name} ${eg.last_name}`,
          subject: `Reminder: ${event.email_subject || `You're invited to ${event.name}`}`,
          html,
          text: `Reminder: Please RSVP for ${event.name} at: ${BASE_URL}/rsvp/${eg.rsvp_code}`
        });
        await pool.query('UPDATE event_guests SET reminder_sent_at=NOW() WHERE id=$1', [eg.id]);
        sent++;
      } catch { failed++; }
    }
    res.json({ sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Public RSVP Routes ───────────────────────────────────────────────────────
app.get('/rsvp/:code', async (req, res) => {
  try {
    const { rows: eg } = await pool.query(`
      SELECT eg.*, g.email, g.first_name, g.last_name, g.phone, g.company
      FROM event_guests eg JOIN guests g ON g.id=eg.guest_id
      WHERE eg.rsvp_code=$1`, [req.params.code.toUpperCase()]);
    if (!eg.length) return res.status(404).send('<h2>Invitation not found</h2>');
    const eventGuest = eg[0];
    const event = (await pool.query('SELECT * FROM events WHERE id=$1', [eventGuest.event_id])).rows[0];
    const questions = (await pool.query(
      'SELECT * FROM event_questions WHERE event_id=$1 ORDER BY sort_order', [event.id])).rows;
    const answers = (await pool.query(
      'SELECT * FROM rsvp_answers WHERE event_guest_id=$1', [eventGuest.id])).rows;
    const guest = { email: eventGuest.email, first_name: eventGuest.first_name, last_name: eventGuest.last_name };
    res.send(renderRsvpPage(event, guest, eventGuest, questions, answers));
  } catch (e) { res.status(500).send('<h2>Error loading invitation</h2>'); }
});

app.post('/rsvp/:code', async (req, res) => {
  const { status, plus_one_name, dietary, answers } = req.body;
  if (!['accepted','declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows: eg } = await pool.query(
      'SELECT * FROM event_guests WHERE rsvp_code=$1', [req.params.code.toUpperCase()]);
    if (!eg.length) return res.status(404).json({ error: 'Invitation not found' });
    const eventGuest = eg[0];

    // Check deadline
    const event = (await pool.query('SELECT * FROM events WHERE id=$1', [eventGuest.event_id])).rows[0];
    if (event.rsvp_deadline && new Date(event.rsvp_deadline) < new Date()) {
      return res.status(400).json({ error: 'RSVP deadline has passed' });
    }

    await pool.query(`
      UPDATE event_guests SET status=$1,plus_one_name=$2,dietary_requirements=$3,rsvp_submitted_at=NOW()
      WHERE id=$4`,
      [status, plus_one_name||null, dietary||null, eventGuest.id]);

    // Save custom answers
    if (answers && typeof answers === 'object') {
      for (const [qid, answer] of Object.entries(answers)) {
        await pool.query(`
          INSERT INTO rsvp_answers (event_guest_id,question_id,answer)
          VALUES ($1,$2,$3) ON CONFLICT (event_guest_id,question_id) DO UPDATE SET answer=$3`,
          [eventGuest.id, parseInt(qid), answer]);
      }
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ICS download
app.get('/rsvp/:code/calendar.ics', async (req, res) => {
  try {
    const { rows: eg } = await pool.query(`
      SELECT eg.*, g.email, g.first_name, g.last_name
      FROM event_guests eg JOIN guests g ON g.id=eg.guest_id
      WHERE eg.rsvp_code=$1`, [req.params.code.toUpperCase()]);
    if (!eg.length) return res.status(404).send('Not found');
    const event = (await pool.query('SELECT * FROM events WHERE id=$1', [eg[0].event_id])).rows[0];
    const ics = generateICS(event, eg[0].email, `${eg[0].first_name} ${eg[0].last_name}`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${event.slug}.ics"`);
    res.send(ics);
  } catch (e) { res.status(500).send('Error'); }
});

// ─── Check-in Routes ──────────────────────────────────────────────────────────
// Verify check-in PIN for an event
app.post('/api/checkin/:eventId/auth', async (req, res) => {
  const { pin } = req.body;
  try {
    const { rows } = await pool.query('SELECT check_in_pin, name FROM events WHERE id=$1', [req.params.eventId]);
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    if (!rows[0].check_in_pin || rows[0].check_in_pin !== pin) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }
    res.json({ ok: true, eventName: rows[0].name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search guests for check-in
app.get('/api/checkin/:eventId/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const { rows } = await pool.query(`
      SELECT eg.id, eg.rsvp_code, eg.status, eg.checked_in_at, eg.plus_one_name,
             g.first_name, g.last_name, g.email, g.company
      FROM event_guests eg JOIN guests g ON g.id=eg.guest_id
      WHERE eg.event_id=$1
        AND (g.first_name ILIKE $2 OR g.last_name ILIKE $2 OR g.email ILIKE $2
             OR (g.first_name || ' ' || g.last_name) ILIKE $2
             OR eg.rsvp_code ILIKE $2)
      ORDER BY g.last_name, g.first_name LIMIT 20`, [req.params.eventId, `%${q}%`]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check in a guest
app.post('/api/checkin/:eventId/guests/:egId/checkin', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE event_guests SET checked_in_at=NOW(), checked_in_by='check-in-desk'
      WHERE id=$1 AND event_id=$2 RETURNING *`,
      [req.params.egId, req.params.eventId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Undo check-in
app.post('/api/checkin/:eventId/guests/:egId/uncheckin', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE event_guests SET checked_in_at=NULL, checked_in_by=NULL
      WHERE id=$1 AND event_id=$2 RETURNING *`,
      [req.params.egId, req.params.eventId]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/events/:id/stats', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status='accepted' THEN 1 END) AS accepted,
        COUNT(CASE WHEN status='declined' THEN 1 END) AS declined,
        COUNT(CASE WHEN status='pending' THEN 1 END) AS pending,
        COUNT(CASE WHEN checked_in_at IS NOT NULL THEN 1 END) AS checked_in,
        COUNT(CASE WHEN invitation_sent_at IS NOT NULL THEN 1 END) AS invited,
        COUNT(CASE WHEN reminder_sent_at IS NOT NULL THEN 1 END) AS reminded
      FROM event_guests WHERE event_id=$1`, [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check-in page init — resolves slug + verifies PIN, returns eventId
app.get('/api/checkin-page-init', async (req, res) => {
  const { slug, pin } = req.query;
  if (!slug || !pin) return res.status(400).json({ error: 'slug and pin required' });
  try {
    const { rows } = await pool.query('SELECT id, name, check_in_pin FROM events WHERE slug=$1', [slug]);
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    const ev = rows[0];
    if (!ev.check_in_pin || ev.check_in_pin !== pin) return res.status(401).json({ error: 'Incorrect PIN' });
    res.json({ eventId: ev.id, eventName: ev.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin pages ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/checkin/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));

// ─── Start ────────────────────────────────────────────────────────────────────
migrate().then(() => {
  app.listen(PORT, () => console.log(`Fringe Events running on http://localhost:${PORT}`));
}).catch(e => { console.error('Migration failed:', e); process.exit(1); });

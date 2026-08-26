const express    = require('express');
const { Client, Environment } = require('square');
const { randomUUID, randomBytes } = require('crypto');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Square client ─────────────────────────────────────────────
const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production
});

// ── Config ────────────────────────────────────────────────────
const DISCORD_WEBHOOK =
  'https://discord.com/api/webhooks/1541257404644073492/utlSCLMUQs7zfnzllT7eeJmWj8dTXepBDGwqpnzd3zyRvZ5OwJdghIACml2GdwJgblWe';

const AMOUNTS = {
  basic: 999n, premium: 1999n, exclusive: 3999n,
  girls_only: 2999n, get_wins: 2999n, no_ban: 1999n, all_in_one: 4999n
};

const PROMO_CODES = {
  HAVEN: { type: 'percent', value: 10n }   // 10% off — applied server-side
};

const LABELS = {
  basic: 'Basic', premium: 'Premium', exclusive: 'Exclusive',
  girls_only: 'Girls Only Guide', get_wins: 'Get Wins Guide',
  no_ban: 'No Ban Guide', all_in_one: 'All-In-One Bundle'
};

const PRICES = {
  basic: '$9.99', premium: '$19.99', exclusive: '$39.99',
  girls_only: '$29.99', get_wins: '$29.99', no_ban: '$19.99', all_in_one: '$49.99'
};

const INVITE_LINKS = {
  basic:     'https://t.me/+8dKaklm2kkwzOTYx',
  premium:   'https://t.me/+jdXXrUwbQpo5MmNh',
  exclusive: 'https://t.me/+mzQYI5L1qcs1MGUx'
};

// PDF guides — files live in /pdfs/ directory
const PDF_FILES = {
  girls_only: 'girls_only.pdf',
  get_wins:   'get_wins.pdf',
  no_ban:     'no_ban.pdf',
  all_in_one: 'all_in_one.pdf'
};
const GUIDE_TIERS = new Set(['girls_only', 'get_wins', 'no_ban', 'all_in_one']);

// ── Token stores ──────────────────────────────────────────────
// Layer 1: checkout session (32 bytes, 2hr TTL, reusable during payment flow)
const checkoutTokens = new Map();   // token → { tierKey, expires }

// Layer 2: delivery (16 bytes, 2hr TTL, strictly one-time)
const deliveryTokens = new Map();   // token → { tierKey, used, expires }

// Expire stale entries every hour — no unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of checkoutTokens) if (v.expires < now) checkoutTokens.delete(k);
  for (const [k, v] of deliveryTokens) if (v.expires < now) deliveryTokens.delete(k);
}, 60 * 60 * 1000);

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());

// Apple Pay domain verification — byte-exact, trailing whitespace stripped
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  const filePath = path.join(__dirname, 'public', '.well-known', 'apple-developer-merchantid-domain-association');
  const raw     = fs.readFileSync(filePath);
  const trimmed = Buffer.from(raw.toString('binary').replace(/[\s﻿]+$/, ''), 'binary');
  res.set('Content-Type', 'application/json');
  res.set('Content-Length', String(trimmed.length));
  res.send(trimmed);
});

// Route by hostname: jabigod.xyz → home/, everything else → public/
const serveHome   = express.static(path.join(__dirname, 'home'),   { extensions: ['html'] });
const servePublic = express.static(path.join(__dirname, 'public'), { extensions: ['html'] });

app.use((req, res, next) => {
  const raw  = req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname || '';
  const host = raw.split(',')[0].split(':')[0].toLowerCase().trim();
  if (host === 'jabigod.xyz' || host === 'www.jabigod.xyz') {
    serveHome(req, res, next);
  } else {
    servePublic(req, res, next);
  }
});

// ── GET /api/config ───────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ appId: process.env.SQUARE_APP_ID, locationId: process.env.SQUARE_LOCATION_ID });
});

// ── GET /api/health ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const mask = (v) => v ? v.slice(0, 6) + '••••' + v.slice(-3) : '(not set)';
  res.json({
    SQUARE_ACCESS_TOKEN: mask(process.env.SQUARE_ACCESS_TOKEN),
    SQUARE_APP_ID:       mask(process.env.SQUARE_APP_ID),
    SQUARE_LOCATION_ID:  mask(process.env.SQUARE_LOCATION_ID),
    node_env:            process.env.NODE_ENV || '(not set)',
    uptime_seconds:      Math.floor(process.uptime()),
    checkout_tokens:     checkoutTokens.size,
    delivery_tokens:     deliveryTokens.size
  });
});

// ── OPTIONS preflight (checkout-token is called cross-origin from jabigod.xyz) ──
app.options('/api/checkout-token', (req, res) => {
  res.set('Access-Control-Allow-Origin',  'https://jabigod.xyz');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ── POST /api/checkout-token ──────────────────────────────────
// Layer 1 — generate a random single-purpose checkout URL for a tier.
// The /c/:token URL is what the buyer lands on; it's not guessable or
// bookmarkable as a plain tier name. Reusable across page loads/retries
// during the 2-hour payment window.
app.post('/api/checkout-token', (req, res) => {
  res.set('Access-Control-Allow-Origin',  'https://jabigod.xyz');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  const { tier } = req.body;
  const resolvedTier = AMOUNTS[tier] ? tier : 'basic';
  const token        = randomBytes(32).toString('base64url');

  checkoutTokens.set(token, {
    tierKey: resolvedTier,
    expires: Date.now() + 2 * 60 * 60 * 1000
  });

  res.json({ url: `/c/${token}` });
});

// ── GET /c/:token ─────────────────────────────────────────────
// Layer 1 route. Validates the checkout token, injects tier data into
// the checkout page at render time. Reusable — buyer can reload or
// retry payment without burning the token.
app.get('/c/:token', (req, res) => {
  const entry = checkoutTokens.get(req.params.token);
  if (!entry || entry.expires < Date.now()) {
    return res.redirect('https://mycheckout.live/');
  }

  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const injected = html.replace(
    '</head>',
    `<script>window.__CHECKOUT_TIER=${JSON.stringify(entry.tierKey)};` +
    `window.__CHECKOUT_TOKEN=${JSON.stringify(req.params.token)};</script>\n</head>`
  );
  res.set('Content-Type', 'text/html');
  res.send(injected);
});

// ── POST /api/pay ─────────────────────────────────────────────
app.post('/api/pay', async (req, res) => {
  const { sourceId, tier, verificationToken, promoCode } = req.body;

  if (!sourceId) return res.status(400).json({ error: 'Missing sourceId' });

  const resolvedTier = AMOUNTS[tier] ? tier : 'basic';
  const locationId   = process.env.SQUARE_LOCATION_ID;

  let amount = AMOUNTS[resolvedTier];
  if (promoCode) {
    const promo = PROMO_CODES[promoCode.toUpperCase().trim()];
    if (promo && promo.type === 'percent') {
      amount = amount * (100n - promo.value) / 100n;
    }
  }

  try {
    const body = {
      sourceId,
      idempotencyKey: randomUUID(),
      amountMoney: { amount, currency: 'USD' },
      locationId,
      note: `${LABELS[resolvedTier]} Membership — HOEJABI HAVEN`
    };
    if (verificationToken) body.verificationToken = verificationToken;

    const { result } = await square.paymentsApi.createPayment(body);
    const payment    = result.payment;

    // Layer 2 — generate one-time delivery token AFTER confirmed payment
    const deliveryToken = randomBytes(16).toString('base64url');
    const isGuide = GUIDE_TIERS.has(resolvedTier);
    deliveryTokens.set(deliveryToken, {
      tierKey:    resolvedTier,
      inviteLink: isGuide ? null : (INVITE_LINKS[resolvedTier] || null),
      pdfFile:    isGuide ? (PDF_FILES[resolvedTier] || null) : null,
      used:       false,
      expires:    Date.now() + 2 * 60 * 60 * 1000
    });

    // Fire Discord — non-blocking
    notifyDiscord(resolvedTier, payment.amountMoney.amount, payment.id).catch(console.error);

    res.json({
      success:      true,
      tier:         resolvedTier,
      paymentId:    payment.id,
      deliveryPath: `/complete/${deliveryToken}`
    });

  } catch (err) {
    console.error('[pay]', JSON.stringify(err, null, 2));
    const detail = err.result?.errors?.[0]?.detail || err.message || 'Payment failed';
    res.status(400).json({ error: detail });
  }
});

// ── GET /complete/:token ──────────────────────────────────────
// Layer 2 delivery page.
//   PDF guides   → revisitable within 2hr window; no one-time flip
//   Telegram inv → strictly one-time; used=true before render
app.get('/complete/:token', (req, res) => {
  const entry = deliveryTokens.get(req.params.token);
  const token = req.params.token;

  if (!entry || entry.expires < Date.now()) {
    return res.status(410).send(deliveryPage(null, 'expired'));
  }

  // PDF guide — revisitable delivery page
  if (entry.pdfFile) {
    return res.send(deliveryPage({
      tier:          LABELS[entry.tierKey],
      price:         PRICES[entry.tierKey],
      downloadToken: token
    }, 'pdf'));
  }

  // Telegram invite — one-time
  if (entry.used) {
    return res.status(200).send(deliveryPage(null, 'used'));
  }
  entry.used = true;   // flip before render — prevents race on reload

  return res.send(deliveryPage({
    tier:       LABELS[entry.tierKey],
    inviteLink: entry.inviteLink,
    price:      PRICES[entry.tierKey]
  }, 'ok'));
});

// ── GET /dl/:token ────────────────────────────────────────────
// Streams the PDF file for guide purchases. Valid for 2hr after purchase.
app.get('/dl/:token', (req, res) => {
  const entry = deliveryTokens.get(req.params.token);

  const errPage = (title, msg) =>
    `<!doctype html><html><head><meta charset="UTF-8"><title>${title}</title></head>` +
    `<body style="font-family:sans-serif;text-align:center;padding:60px;background:#040407;color:#f2f2f8;">` +
    `<h2>${title}</h2><p style="color:rgba(242,242,248,.5);margin-top:8px;">${msg}</p></body></html>`;

  if (!entry || entry.expires < Date.now() || !entry.pdfFile) {
    return res.status(410).send(errPage(
      'Download link expired',
      'DM <a href="https://t.me/killsaints" style="color:#b8c4ff;">@killsaints</a> on Telegram for support.'
    ));
  }

  const pdfPath = path.join(__dirname, 'pdfs', entry.pdfFile);
  if (!fs.existsSync(pdfPath)) {
    return res.status(503).send(errPage(
      'File being processed',
      'DM <a href="https://t.me/killsaints" style="color:#b8c4ff;">@killsaints</a> on Telegram and we\'ll send it directly.'
    ));
  }

  res.setHeader('Content-Disposition', `attachment; filename="${entry.pdfFile}"`);
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(pdfPath).pipe(res);
});

// ── Delivery page renderer ────────────────────────────────────
function deliveryPage(data, state) {
  const head = `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body{min-height:100vh;
      background:radial-gradient(ellipse 130% 50% at 50% 0%,#16161e 0%,#0c0c14 20%,#07070d 40%,transparent 62%),
      linear-gradient(180deg,#060609 0%,#040407 45%,#020205 100%);
      color:#f2f2f8;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      -webkit-font-smoothing:antialiased;display:flex;flex-direction:column;
      align-items:center;justify-content:center;padding:24px;text-align:center}
    .logo{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;
      color:rgba(242,242,248,.3);margin-bottom:40px}
    .card{max-width:440px;width:100%;background:#0c0c13;
      border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:38px 32px}
    .icon{width:58px;height:58px;border-radius:50%;margin:0 auto 22px;display:flex;
      align-items:center;justify-content:center}
    .icon-ok{background:radial-gradient(circle,rgba(74,222,128,.13),rgba(74,222,128,.02));
      border:1.5px solid rgba(74,222,128,.28)}
    .icon-warn{background:radial-gradient(circle,rgba(255,160,64,.13),rgba(255,160,64,.02));
      border:1.5px solid rgba(255,160,64,.28)}
    .eyebrow{font-size:10px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;
      color:rgba(242,242,248,.38);margin-bottom:9px}
    h1{font-size:1.6rem;font-weight:800;letter-spacing:-.03em;margin-bottom:7px}
    .sub{font-size:13.5px;color:rgba(242,242,248,.46);line-height:1.65;margin-bottom:28px}
    .order-box{background:#111119;border:1px solid rgba(255,255,255,.1);border-radius:11px;
      padding:20px 22px;text-align:left;margin-bottom:18px}
    .order-row{display:flex;align-items:center;justify-content:space-between;
      padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05)}
    .order-row:last-child{border-bottom:none}
    .order-label{font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
      color:rgba(242,242,248,.34)}
    .order-val{font-size:13.5px;font-weight:700;color:#f2f2f8}
    .cta{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;
      padding:15px 20px;border-radius:10px;
      background:linear-gradient(135deg,#fff 0%,#d4d4e8 100%);
      color:#040407;font-size:15px;font-weight:800;letter-spacing:-.01em;
      text-decoration:none;transition:opacity .18s,transform .18s;margin-bottom:13px}
    .cta:hover{opacity:.87;transform:translateY(-1px)}
    .cta svg{flex-shrink:0}
    .note{font-size:11px;color:rgba(242,242,248,.28);line-height:1.6}
    .divider{border:none;border-top:1px solid rgba(255,255,255,.06);margin:24px 0}
    .help{font-size:12px;color:rgba(242,242,248,.3)}
    .help a{color:rgba(242,242,248,.52);text-decoration:none}
    .help a:hover{color:rgba(242,242,248,.78)}
  </style></head><body>
  <div class="logo">HOEJABI HAVEN</div>`;

  const foot = `</body></html>`;

  if (state === 'pdf') {
    return head + `
  <div class="card">
    <div class="icon icon-ok">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
        <path d="M10 22l-2 2h16l-2-2" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M16 5v13M10 13l6 6 6-6" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="eyebrow">Payment Confirmed</div>
    <h1>Ready to download.</h1>
    <p class="sub">Your guide is waiting. Tap below — link valid for 2 hours from purchase.</p>
    <div class="order-box">
      <div class="order-row">
        <span class="order-label">Product</span>
        <span class="order-val">${data.tier}</span>
      </div>
      <div class="order-row">
        <span class="order-label">Format</span>
        <span class="order-val">PDF · Instant Download</span>
      </div>
      <div class="order-row">
        <span class="order-label">Amount</span>
        <span class="order-val">${data.price}</span>
      </div>
    </div>
    <a class="cta" href="/dl/${data.downloadToken}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M12 3v14M6 11l6 6 6-6" stroke="#040407" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4 20h16" stroke="#040407" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
      Download Your Guide →
    </a>
    <p class="note">⏱ Bookmark this page or save the PDF now — download link expires in 2 hours.</p>
    <hr class="divider">
    <p class="help">Questions? DM <a href="https://t.me/killsaints" target="_blank" rel="noopener">@killsaints</a> on Telegram.</p>
  </div>` + foot;
  }

  if (state === 'ok') {
    return head + `
  <div class="card">
    <div class="icon icon-ok">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
        <path d="M7 16l6 6 12-12" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="eyebrow">Payment Confirmed</div>
    <h1>You're in.</h1>
    <p class="sub">Your order is below — tap the button to join your channel right now.</p>
    <div class="order-box">
      <div class="order-row">
        <span class="order-label">Tier</span>
        <span class="order-val">${data.tier} Membership</span>
      </div>
      <div class="order-row">
        <span class="order-label">Access</span>
        <span class="order-val">Lifetime · Never expires</span>
      </div>
      <div class="order-row">
        <span class="order-label">Amount</span>
        <span class="order-val">${data.price}</span>
      </div>
    </div>
    <a class="cta" href="${data.inviteLink}" target="_blank" rel="noopener">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="#040407">
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.014 9.49c-.148.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.08 14.4l-2.95-.924c-.642-.2-.654-.642.136-.953l11.527-4.447c.535-.194 1.003.13.769.172z"/>
      </svg>
      Join ${data.tier} Channel →
    </a>
    <p class="note">⚠ This link works once — join now. Refreshing this page will not show the link again.</p>
    <hr class="divider">
    <p class="help">Questions? DM <a href="https://t.me/killsaints" target="_blank" rel="noopener">@killsaints</a> on Telegram.</p>
  </div>` + foot;
  }

  if (state === 'used') {
    return head + `
  <div class="card">
    <div class="icon icon-warn">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
        <path d="M16 10v8M16 22h.01" stroke="#ffa040" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="eyebrow">Already Viewed</div>
    <h1>Link already used.</h1>
    <p class="sub">This delivery link was already opened. For your security it only works once.<br><br>
      Haven't joined your channel yet? DM us — we'll sort it out immediately.</p>
    <hr class="divider">
    <p class="help">DM <a href="https://t.me/killsaints" target="_blank" rel="noopener">@killsaints</a> on Telegram for support.</p>
  </div>` + foot;
  }

  // expired
  return head + `
  <div class="card">
    <div class="icon icon-warn">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="10" stroke="#ffa040" stroke-width="2.2"/>
        <path d="M16 10v6l4 3" stroke="#ffa040" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="eyebrow">Link Expired</div>
    <h1>This link expired.</h1>
    <p class="sub">Delivery links are valid for 2 hours after purchase. If you're seeing this, DM us and we'll send your access directly.</p>
    <hr class="divider">
    <p class="help">DM <a href="https://t.me/killsaints" target="_blank" rel="noopener">@killsaints</a> on Telegram for support.</p>
  </div>` + foot;
}

// ── Discord notification ──────────────────────────────────────
async function notifyDiscord(tier, amountBigInt, paymentId) {
  const amount = Number(amountBigInt);
  const price  = '$' + (amount / 100).toFixed(2);
  const label  = LABELS[tier] || tier;

  const payload = {
    embeds: [{
      title:       '💸 New Payment — HOEJABI HAVEN',
      color:       0xb8c4ff,
      description: `**${label}** tier purchased successfully.`,
      fields: [
        { name: 'Tier',       value: label,                                            inline: true  },
        { name: 'Amount',     value: price,                                            inline: true  },
        ...(GUIDE_TIERS.has(tier)
          ? [{ name: 'Type',    value: 'PDF Guide — auto-delivered',                   inline: false }]
          : [{ name: 'Channel', value: INVITE_LINKS[tier] || '(no link)',              inline: false }]),
        { name: 'Payment ID', value: `\`${paymentId}\``,                              inline: false }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'mycheckout.live' }
    }]
  };

  const r = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
}

// ── POST /api/crypto-notify ───────────────────────────────────
app.post('/api/crypto-notify', async (req, res) => {
  const { tier, coin, address, txHash, amount } = req.body;

  if (!txHash || !coin || !tier) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const resolvedTier = LABELS[tier] ? tier : 'basic';
  const label        = LABELS[resolvedTier];
  const coinNames    = { btc: 'Bitcoin (BTC)', eth: 'Ethereum (ETH)', ltc: 'Litecoin (LTC)', sol: 'Solana (SOL)' };
  const coinLabel    = coinNames[coin.toLowerCase()] || coin.toUpperCase();

  try {
    const payload = {
      embeds: [{
        title:       '⏳ Crypto Payment — Needs Verification',
        color:       0xf59e0b,
        description: `**${label}** tier — crypto payment submitted, awaiting manual verification.`,
        fields: [
          { name: 'Tier',    value: label,                        inline: true  },
          { name: 'Amount',  value: amount || PRICES[resolvedTier], inline: true  },
          { name: 'Coin',    value: coinLabel,                    inline: true  },
          { name: 'TX Hash', value: `\`${txHash}\``,              inline: false },
          { name: 'Address', value: `\`${address}\``,             inline: false },
          { name: 'Channel', value: INVITE_LINKS[resolvedTier],   inline: false }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'mycheckout.live — verify TX then send invite' }
      }]
    };

    const r = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`Discord ${r.status}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[crypto-notify]', err.message);
    res.status(500).json({ error: 'Notification failed' });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`mycheckout.live running on port ${PORT}`);
});

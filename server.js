const express    = require('express');
const { Client, Environment } = require('square');
const { randomUUID } = require('crypto');
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

const AMOUNTS = { basic: 999n, premium: 1999n, exclusive: 3999n }; // cents as BigInt

const PROMO_CODES = {
  HAVEN: { type: 'percent', value: 10n }   // 10 % off — applied server-side
};
const LABELS  = { basic: 'Basic', premium: 'Premium', exclusive: 'Exclusive' };
const PRICES  = { basic: '$9.99', premium: '$19.99', exclusive: '$39.99' };

const INVITE_LINKS = {
  basic:     'https://t.me/+8dKaklm2kkwzOTYx',
  premium:   'https://t.me/+jdXXrUwbQpo5MmNh',
  exclusive: 'https://t.me/+mzQYI5L1qcs1MGUx'
};

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());

// Apple Pay domain verification — byte-exact, trailing whitespace stripped
// defensively so git/editor newlines never break verification.
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  const filePath = path.join(__dirname, 'public', '.well-known', 'apple-developer-merchantid-domain-association');
  const raw = fs.readFileSync(filePath);
  const trimmed = Buffer.from(raw.toString('binary').replace(/[\s﻿]+$/, ''), 'binary');
  res.set('Content-Type', 'application/json');
  res.set('Content-Length', String(trimmed.length));
  res.send(trimmed);
});

// Route static files by hostname:
//   jabigod.xyz  → home/   (landing page)
//   everything else → public/ (checkout)
const serveHome   = express.static(path.join(__dirname, 'home'));
const servePublic = express.static(path.join(__dirname, 'public'));

app.use((req, res, next) => {
  // Railway sits behind a reverse proxy — read x-forwarded-host first,
  // then raw Host header, then Express's req.hostname as last resort.
  const raw = req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname || '';
  const host = raw.split(':')[0].toLowerCase().trim();
  console.log('[route] host:', host);
  if (host === 'jabigod.xyz' || host === 'www.jabigod.xyz') {
    serveHome(req, res, next);
  } else {
    servePublic(req, res, next);
  }
});

// ── GET /api/config ───────────────────────────────────────────
// Returns public Square credentials to the browser.
// appId and locationId are safe to expose client-side.
app.get('/api/config', (req, res) => {
  res.json({
    appId:      process.env.SQUARE_APP_ID,
    locationId: process.env.SQUARE_LOCATION_ID
  });
});

// ── GET /api/health ───────────────────────────────────────────
// Shows whether env vars are set (masked). Visit in browser to diagnose.
app.get('/api/health', (req, res) => {
  const mask = (v) => v ? v.slice(0, 6) + '••••' + v.slice(-3) : '(not set)';
  res.json({
    SQUARE_ACCESS_TOKEN: mask(process.env.SQUARE_ACCESS_TOKEN),
    SQUARE_APP_ID:       mask(process.env.SQUARE_APP_ID),
    SQUARE_LOCATION_ID:  mask(process.env.SQUARE_LOCATION_ID),
    node_env:            process.env.NODE_ENV || '(not set)',
    uptime_seconds:      Math.floor(process.uptime())
  });
});

// ── POST /api/pay ─────────────────────────────────────────────
// Receives a Square nonce (sourceId) from the browser,
// creates a payment, fires the Discord notification.
app.post('/api/pay', async (req, res) => {
  const { sourceId, tier, verificationToken, promoCode } = req.body;

  if (!sourceId) {
    return res.status(400).json({ error: 'Missing sourceId' });
  }

  const resolvedTier = AMOUNTS[tier] ? tier : 'basic';
  const locationId   = process.env.SQUARE_LOCATION_ID;

  // Apply promo code discount server-side — client display is cosmetic only
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

    // Include buyer verification token when present (3DS / card-on-file)
    if (verificationToken) body.verificationToken = verificationToken;

    const { result } = await square.paymentsApi.createPayment(body);
    const payment = result.payment;

    // Fire Discord — non-blocking
    notifyDiscord(resolvedTier, payment.amountMoney.amount, payment.id)
      .catch(console.error);

    res.json({ success: true, tier: resolvedTier, paymentId: payment.id });
  } catch (err) {
    console.error('[pay]', JSON.stringify(err, null, 2));
    const detail = err.result?.errors?.[0]?.detail || err.message || 'Payment failed';
    res.status(400).json({ error: detail });
  }
});

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
        { name: 'Tier',       value: label,                 inline: true  },
        { name: 'Amount',     value: price,                 inline: true  },
        { name: 'Channel',    value: INVITE_LINKS[tier],    inline: false },
        { name: 'Payment ID', value: `\`${paymentId}\``,   inline: false }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'hoejabi.cloud' }
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
// Receives crypto payment submission, fires Discord for manual verification.
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
          { name: 'Tier',       value: label,                   inline: true  },
          { name: 'Amount',     value: amount || PRICES[resolvedTier], inline: true  },
          { name: 'Coin',       value: coinLabel,               inline: true  },
          { name: 'TX Hash',    value: `\`${txHash}\``,         inline: false },
          { name: 'Address',    value: `\`${address}\``,        inline: false },
          { name: 'Channel',    value: INVITE_LINKS[resolvedTier], inline: false }
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

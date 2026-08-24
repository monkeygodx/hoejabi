const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────
const DISCORD_WEBHOOK =
  'https://discord.com/api/webhooks/1541257404644073492/utlSCLMUQs7zfnzllT7eeJmWj8dTXepBDGwqpnzd3zyRvZ5OwJdghIACml2GdwJgblWe';

const AMOUNTS = { basic: 999, premium: 1999, exclusive: 3999 };
const LABELS  = { basic: 'Basic', premium: 'Premium', exclusive: 'Exclusive' };
const PRICES  = { basic: '$9.99', premium: '$19.99', exclusive: '$39.99' };

const INVITE_LINKS = {
  basic:     'https://t.me/+8dKaklm2kkwzOTYx',
  premium:   'https://t.me/+jdXXrUwbQpo5MmNh',
  exclusive: 'https://t.me/+mzQYI5L1qcs1MGUx'
};

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /api/create-payment-intent ──────────────────────────
// Called when the checkout page loads — creates a Stripe PaymentIntent
// and returns the clientSecret so Stripe.js can mount the payment form.
app.post('/api/create-payment-intent', async (req, res) => {
  const tier   = (req.body.tier || 'basic').toLowerCase();
  const amount = AMOUNTS[tier] || AMOUNTS.basic;

  try {
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      description: `${LABELS[tier] || tier} Membership — HOEJABI HAVEN`,
      automatic_payment_methods: { enabled: true },
      metadata: { tier }
    });
    res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    console.error('[create-payment-intent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/confirm ──────────────────────────────────────────
// Called by success.html after Stripe redirects back.
// Verifies the payment server-side, fires Discord notification,
// returns the correct Telegram invite link.
app.get('/api/confirm', async (req, res) => {
  const { payment_intent, tier } = req.query;

  if (!payment_intent) {
    return res.status(400).json({ error: 'Missing payment_intent' });
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(payment_intent);

    if (pi.status !== 'succeeded') {
      return res.status(402).json({ error: 'Payment not completed', status: pi.status });
    }

    // Use the tier stored in Stripe metadata (most reliable) or fall back to query param
    const confirmedTier = (pi.metadata && pi.metadata.tier) || tier || 'basic';
    const inviteLink    = INVITE_LINKS[confirmedTier] || INVITE_LINKS.basic;

    // Fire Discord notification — don't block the response
    notifyDiscord(confirmedTier, pi.amount, pi.id).catch(console.error);

    res.json({ success: true, tier: confirmedTier, inviteLink });
  } catch (err) {
    console.error('[confirm]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Discord notification ──────────────────────────────────────
async function notifyDiscord(tier, amount, paymentId) {
  const label  = LABELS[tier]  || tier;
  const price  = PRICES[tier]  || '$?.??';
  const invite = INVITE_LINKS[tier] || '—';

  const payload = {
    embeds: [{
      title:       '💸 New Payment — HOEJABI HAVEN',
      color:       0xb8c4ff,
      description: `**${label}** tier purchased successfully.`,
      fields: [
        { name: 'Tier',       value: label,         inline: true  },
        { name: 'Amount',     value: price,          inline: true  },
        { name: 'Channel',    value: invite,         inline: false },
        { name: 'Payment ID', value: `\`${paymentId}\``, inline: false }
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

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Discord webhook ${r.status}: ${body}`);
  }
}

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`hoejabi.cloud server running on port ${PORT}`);
});

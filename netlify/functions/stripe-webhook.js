// Handles Stripe webhook events and syncs subscription state into Supabase.
// Set this function's URL as the endpoint in Stripe: Developers -> Webhooks -> Add endpoint.
// After creating the endpoint, copy its "Signing secret" into Netlify as STRIPE_WEBHOOK_SECRET.

const crypto = require('crypto');

// Season Pass is a one-time purchase that expires on a fixed date rather than renewing.
const SEASON_PASS_EXPIRY = '2026-10-16T23:59:59Z';

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

async function supabaseUpsert(table, row) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=user_id`, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase upsert failed: ${errText.slice(0, 300)}`);
  }
}

async function fetchStripeSubscription(subscriptionId) {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  return res.json();
}

// Newer Stripe API versions moved current_period_end off the top-level Subscription
// object and onto each subscription item. Check both spots so this keeps working
// regardless of which API version the Stripe account is pinned to.
function getPeriodEnd(sub) {
  if (sub && sub.current_period_end) return sub.current_period_end;
  if (sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0] && sub.items.data[0].current_period_end) {
    return sub.items.data[0].current_period_end;
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  if (!verifyStripeSignature(rawBody, sigHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid payload' };
  }

  try {
    const obj = stripeEvent.data.object;

    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const userId = obj.client_reference_id || obj.metadata?.supabase_user_id;
        const plan = obj.metadata?.plan;
        if (!userId || !plan) break;

        if (obj.mode === 'subscription' && obj.subscription) {
          const sub = await fetchStripeSubscription(obj.subscription);
          await supabaseUpsert('subscriptions', {
            user_id: userId,
            stripe_customer_id: obj.customer,
            stripe_subscription_id: obj.subscription,
            plan,
            status: sub.status,
            cancel_at_period_end: false,
            current_period_end: getPeriodEnd(sub)
              ? new Date(getPeriodEnd(sub) * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString()
          });
        } else {
          // One-time purchase (Season Pass) — expires at a fixed date rather than a
          // recurring billing cycle. Update SEASON_PASS_EXPIRY below if the date changes.
          await supabaseUpsert('subscriptions', {
            user_id: userId,
            stripe_customer_id: obj.customer,
            stripe_subscription_id: null,
            plan,
            status: 'active',
            current_period_end: SEASON_PASS_EXPIRY,
            updated_at: new Date().toISOString()
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const userId = obj.metadata?.supabase_user_id;
        if (!userId) break;
        await supabaseUpsert('subscriptions', {
          user_id: userId,
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.id,
          plan: obj.metadata?.plan,
          status: obj.status,
          cancel_at_period_end: !!obj.cancel_at_period_end,
          current_period_end: getPeriodEnd(obj)
            ? new Date(getPeriodEnd(obj) * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString()
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const userId = obj.metadata?.supabase_user_id;
        if (!userId) break;
        await supabaseUpsert('subscriptions', {
          user_id: userId,
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.id,
          plan: obj.metadata?.plan,
          status: 'canceled',
          current_period_end: null,
          updated_at: new Date().toISOString()
        });
        break;
      }

      default:
        // Ignore other event types.
        break;
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

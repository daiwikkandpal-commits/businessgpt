// ONE-TIME USE. Fixes existing subscription rows in Supabase that have
// current_period_end = null because of a bug where the webhook was reading
// current_period_end off the wrong field (Stripe moved it onto subscription
// items in newer API versions). stripe-webhook.js is already fixed for new
// events going forward — this just repairs rows written before the fix.
//
// Run it once after deploying, then you can delete this file:
//   curl -X POST https://igcsemark.com/.netlify/functions/backfill-subscription-dates \
//     -H "Authorization: Bearer <your SUPABASE_SERVICE_ROLE_KEY>"
//
// Gated by the service role key so only you can trigger it.

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

  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = authHeader ? authHeader.replace('Bearer ', '') : '';
  if (!token || token !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    // Find active, recurring subscriptions (skip season_pass — that already has a fixed date)
    // that are missing current_period_end.
    const selectRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscriptions?status=eq.active&current_period_end=is.null&stripe_subscription_id=not.is.null&select=user_id,stripe_subscription_id`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    if (!selectRes.ok) {
      const errText = await selectRes.text();
      throw new Error(`Supabase select failed: ${errText.slice(0, 300)}`);
    }
    const rows = await selectRes.json();

    const results = [];
    for (const row of rows) {
      try {
        const stripeRes = await fetch(`https://api.stripe.com/v1/subscriptions/${row.stripe_subscription_id}`, {
          headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
        });
        const sub = await stripeRes.json();
        const periodEnd = getPeriodEnd(sub);

        if (!periodEnd) {
          results.push({ user_id: row.user_id, updated: false, reason: 'no period end found on Stripe subscription' });
          continue;
        }

        const patchRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${row.user_id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              current_period_end: new Date(periodEnd * 1000).toISOString(),
              updated_at: new Date().toISOString()
            })
          }
        );

        results.push({ user_id: row.user_id, updated: patchRes.ok, status: patchRes.status });
      } catch (e) {
        results.push({ user_id: row.user_id, updated: false, error: e.message });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: rows.length, results }, null, 2)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

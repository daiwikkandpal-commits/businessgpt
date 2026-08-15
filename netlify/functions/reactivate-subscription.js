// Reverses a pending cancellation (cancel_at_period_end) so the subscription
// goes back to renewing normally. Only works before the period actually ends —
// once it's genuinely expired, the user needs to check out again instead.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: 'You must be signed in.' }) };
    }
    const token = authHeader.replace('Bearer ', '');

    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY
      }
    });
    if (!userRes.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Your session has expired. Please sign in again.' }) };
    }
    const user = await userRes.json();

    const subRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user.id}&select=stripe_subscription_id,status,cancel_at_period_end`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    const rows = await subRes.json();
    const sub = rows && rows[0];

    if (!sub || !sub.stripe_subscription_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No subscription found to reactivate.' }) };
    }
    if (!sub.cancel_at_period_end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Your subscription is not scheduled to cancel.' }) };
    }

    const params = new URLSearchParams();
    params.append('cancel_at_period_end', 'false');

    const stripeRes = await fetch(`https://api.stripe.com/v1/subscriptions/${sub.stripe_subscription_id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const updated = await stripeRes.json();
    if (updated.error) throw new Error(updated.error.message);

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        cancel_at_period_end: false,
        updated_at: new Date().toISOString()
      })
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

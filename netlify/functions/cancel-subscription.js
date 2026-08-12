// Cancels the signed-in user's subscription at the END of their current billing period.
// They keep full access until then — no immediate cutoff, no partial refund, and Stripe
// simply won't charge them again after this period. Only applies to Basic/Premium
// (recurring). Season Pass has nothing to cancel since it's a one-time purchase.

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

    // Look up their subscription row to get the Stripe subscription id
    const subRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user.id}&select=stripe_subscription_id,plan,status`,
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
      return { statusCode: 400, body: JSON.stringify({ error: 'No active subscription found to cancel. (Season Pass is one-time and has nothing to cancel.)' }) };
    }
    if (sub.status !== 'active') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Your subscription is not currently active.' }) };
    }

    // Tell Stripe to cancel at period end — NOT an immediate cancellation.
    const params = new URLSearchParams();
    params.append('cancel_at_period_end', 'true');

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

    // Reflect it in Supabase right away too (the subscription.updated webhook will also
    // confirm this shortly after, but updating now means the UI shows it immediately).
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        cancel_at_period_end: true,
        updated_at: new Date().toISOString()
      })
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        current_period_end: updated.current_period_end
          ? new Date(updated.current_period_end * 1000).toISOString()
          : null
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

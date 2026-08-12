// Creates a Stripe Checkout Session for the signed-in user and returns its URL.
// Frontend calls this, then redirects the browser to the returned url.

const PRICES = {
  basic:       { id: 'price_1U3iN3FG7pAUe2A2px1vdKti', mode: 'subscription' },
  premium:     { id: 'price_1U3iNQFG7pAUe2A2Tms6OfSo', mode: 'subscription' },
  season_pass: { id: 'price_1U3iNrFG7pAUe2A2XqqxWaIu', mode: 'payment' }
};

const SITE_URL = 'https://igcsemark.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  try {
    const { plan } = JSON.parse(event.body || '{}');
    if (!PRICES.hasOwnProperty(plan)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan.' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: 'You must be signed in to upgrade.' }) };
    }
    const token = authHeader.replace('Bearer ', '');

    // Verify the user's session token with Supabase Auth (same pattern as check-limit.js)
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

    const { id: priceId, mode } = PRICES[plan];

    // Build the Checkout Session via Stripe's REST API directly (form-encoded, no SDK needed)
    const params = new URLSearchParams();
    params.append('mode', mode);
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', `${SITE_URL}/?checkout=success`);
    params.append('cancel_url', `${SITE_URL}/?checkout=cancelled`);
    params.append('client_reference_id', user.id);
    params.append('customer_email', user.email);
    params.append('metadata[supabase_user_id]', user.id);
    params.append('metadata[plan]', plan);
    if (mode === 'subscription') {
      params.append('subscription_data[metadata][supabase_user_id]', user.id);
      params.append('subscription_data[metadata][plan]', plan);
    }

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const session = await stripeRes.json();
    if (session.error) throw new Error(session.error.message);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

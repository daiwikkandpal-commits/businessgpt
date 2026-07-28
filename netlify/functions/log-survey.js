exports.handler = async (event) => {
  try {
    const { willing, limitType } = JSON.parse(event.body || '{}');
    if (typeof willing !== 'boolean' || !['individual', 'full_paper'].includes(limitType)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid survey response.' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in.' }) };
    }
    const token = authHeader.replace('Bearer ', '');

    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY
      }
    });
    if (!userRes.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Session expired.' }) };
    }
    const user = await userRes.json();

    const insertRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pricing_survey_responses`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        user_id: user.id,
        willing,
        limit_type: limitType,
        amount_cents: 399
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return { statusCode: 500, body: JSON.stringify({ error: errText.slice(0, 200) }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

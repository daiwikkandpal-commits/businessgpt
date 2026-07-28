const LIMITS = { individual: 10, full_paper: 3 };

exports.handler = async (event) => {
  try {
    const { type } = JSON.parse(event.body || '{}');
    if (!LIMITS.hasOwnProperty(type)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid limit type.' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: 'You must be signed in to use the marker.' }) };
    }
    const token = authHeader.replace('Bearer ', '');

    // Verify the user's session token with Supabase Auth
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

    const fn = type === 'full_paper' ? 'increment_full_paper_usage' : 'increment_individual_usage';
    const rpcRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_user_id: user.id, p_limit: LIMITS[type] })
    });

    if (!rpcRes.ok) {
      const errText = await rpcRes.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not check usage limit: ' + errText.slice(0, 200) }) };
    }

    const result = await rpcRes.json();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

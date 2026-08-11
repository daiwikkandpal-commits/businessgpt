// Checks + increments the user's marking usage against their plan:
//   Premium / Season Pass -> unlimited
//   Basic                 -> unlimited individual, 3/day full paper marking
//   Free (no subscription)-> 3 lifetime individual, 1 lifetime full paper per paper (P1 + P2 separately)
// All the tier logic lives in the check_and_increment_usage Postgres function (see
// supabase-usage-limits-schema.sql) so it stays consistent no matter which client calls this.

exports.handler = async (event) => {
  try {
    const { type, paper } = JSON.parse(event.body || '{}');
    if (type !== 'individual' && type !== 'full_paper') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid limit type.' }) };
    }
    if (type === 'full_paper' && paper !== 1 && paper !== 2) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid paper number.' }) };
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

    const rpcRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_and_increment_usage`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_user_id: user.id,
        p_type: type,
        p_paper: type === 'full_paper' ? paper : null
      })
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

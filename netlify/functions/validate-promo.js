// Read-only check: does this code exist, is it active, and are slots left?
// Does NOT reserve a slot — that only happens in create-checkout.js at the
// moment someone actually starts checkout, so browsing with a code typed in
// doesn't burn slots.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  try {
    const { code } = JSON.parse(event.body || '{}');
    if (!code || typeof code !== 'string') {
      return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'Enter a code.' }) };
    }
    const normalized = code.trim().toUpperCase();

    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/promo_codes?code=eq.${encodeURIComponent(normalized)}&select=code,discount_basic_cents,discount_premium_cents,discount_season_cents,max_uses,used_count,active`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;

    if (!row) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, reason: "That code doesn't exist." }) };
    }
    if (!row.active) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'That code is no longer active.' }) };
    }
    const remaining = row.max_uses - row.used_count;
    if (remaining <= 0) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'That code has been fully redeemed.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valid: true,
        remaining,
        discounts: {
          basic: row.discount_basic_cents,
          premium: row.discount_premium_cents,
          season_pass: row.discount_season_cents
        }
      })
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'Could not check that code right now.' }) };
  }
};

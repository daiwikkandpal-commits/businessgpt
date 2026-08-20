// ONE-TIME USE. Creates the 3 Stripe coupons the promo code system applies
// (fixed $ off, one per plan, applied only to the first payment). Run once
// after deploying, then you can delete this file.
//
//   curl -X POST https://igcsemark.com/.netlify/functions/setup-promo-coupons \
//     -H "Authorization: Bearer <your SUPABASE_SERVICE_ROLE_KEY>"
//
// Safe to run more than once — if a coupon ID already exists, it's skipped.

const COUPONS = [
  { id: 'igcm_basic_1usd_off',   amount_off: 100, name: 'Student promo — Basic $1 off' },
  { id: 'igcm_premium_2usd_off', amount_off: 200, name: 'Student promo — Premium $2 off' },
  { id: 'igcm_season_3usd_off',  amount_off: 300, name: 'Student promo — Season Pass $3 off' }
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  const token = authHeader ? authHeader.replace('Bearer ', '') : '';
  if (!token || token !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const results = [];
  for (const c of COUPONS) {
    const params = new URLSearchParams();
    params.append('id', c.id);
    params.append('amount_off', String(c.amount_off));
    params.append('currency', 'usd');
    params.append('duration', 'once');
    params.append('name', c.name);

    const res = await fetch('https://api.stripe.com/v1/coupons', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await res.json();

    if (data.error) {
      // Already exists is fine — that just means a previous run created it.
      const alreadyExists = data.error.code === 'resource_already_exists';
      results.push({ id: c.id, ok: alreadyExists, error: alreadyExists ? 'already existed' : data.error.message });
    } else {
      results.push({ id: c.id, ok: true, created: true });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results }, null, 2)
  };
};

const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Vercel environment variable FIREBASE_SERVICE_ACCOUNT_JSON is missing.');

  const serviceAccount = JSON.parse(raw);
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL ||
      'https://neocure-live-2026-default-rtdb.asia-southeast1.firebasedatabase.app'
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const app = getAdminApp();
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Applicator login token missing.' });

    const decoded = await app.auth().verifyIdToken(match[1]);
    const uid = decoded.uid;
    const code = String((req.body && req.body.code) || '')
      .trim().replace(/\s+/g, '').toUpperCase();

    if (!/^[A-Z0-9_-]{6,40}$/.test(code)) {
      return res.status(400).json({ error: 'ಮಾನ್ಯ Coupon Code ನಮೂದಿಸಿ.' });
    }

    const db = app.database();
    const userRef = db.ref('users/' + uid);
    const userSnap = await userRef.once('value');
    const user = userSnap.val();

    if (!user || user.role !== 'worker' || user.status !== 'active') {
      return res.status(403).json({ error: 'Active Applicator account ಮಾತ್ರ Coupon Claim ಮಾಡಬಹುದು.' });
    }

    const couponRef = db.ref('coupons/' + code);
    const claimTx = await couponRef.transaction(current => {
      if (!current) return;
      if (current.status === 'Unused') {
        return {
          ...current,
          status: 'Claimed',
          claimedBy: uid,
          claimedPhone: String(user.phone || ''),
          claimedAt: Date.now()
        };
      }
      // Same-user retry can safely finish a claim interrupted after coupon marking.
      if (current.status === 'Claimed' && current.claimedBy === uid) return current;
      return;
    });

    if (!claimTx.committed || !claimTx.snapshot.exists()) {
      return res.status(409).json({ error: 'ಈ Coupon ಈಗಾಗಲೇ ಬಳಕೆಯಾಗಿದೆ ಅಥವಾ ಮಾನ್ಯವಲ್ಲ.' });
    }

    const coupon = claimTx.snapshot.val();
    const reward = Number(coupon.reward || 0);
    if (!Number.isFinite(reward) || reward <= 0) {
      return res.status(400).json({ error: 'Coupon reward amount ಸರಿಯಿಲ್ಲ. Admin ಪರಿಶೀಲಿಸಿ.' });
    }

    // Atomic user-node transaction: code-keyed rewardHistory prevents double wallet credit.
    const creditTx = await userRef.transaction(current => {
      if (!current || current.role !== 'worker' || current.status !== 'active') return;
      const history = current.rewardHistory && typeof current.rewardHistory === 'object'
        ? current.rewardHistory : {};
      if (history[code]) return current;

      current.rewardBalance = Number(current.rewardBalance || 0) + reward;
      history[code] = {
        code,
        reward,
        batch: String(coupon.batch || ''),
        claimedAt: Number(coupon.claimedAt || Date.now())
      };
      current.rewardHistory = history;
      return current;
    });

    if (!creditTx.committed || !creditTx.snapshot.exists()) {
      return res.status(409).json({ error: 'Reward Wallet update ಆಗಲಿಲ್ಲ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.' });
    }

    const finalUser = creditTx.snapshot.val();
    return res.status(200).json({
      ok: true,
      code,
      reward,
      balance: Number(finalUser.rewardBalance || 0)
    });
  } catch (err) {
    console.error('redeemCoupon error:', err);
    const status = err && err.code === 'auth/id-token-expired' ? 401 : 500;
    return res.status(status).json({
      error: status === 401 ? 'Login session expired. ಮತ್ತೆ login ಮಾಡಿ.' : 'Secure QR service error. Vercel logs ಪರಿಶೀಲಿಸಿ.'
    });
  }
};

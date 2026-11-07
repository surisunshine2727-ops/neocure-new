const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp({
  databaseURL: 'https://neocure-live-2026-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const REGION = 'asia-southeast1';
const ADMIN_EMAIL = 'suri.sunshine2727@gmail.com';
const AUTH_DOMAIN = 'neocure-live-2026.app';

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePortalRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'worker' || role === 'application') return 'applicator';
  return role;
}

function authRolePrefix(role) {
  return normalizePortalRole(role) === 'applicator' ? 'worker' : 'dealer';
}

function profileRole(profile, fallbackRole) {
  return normalizePortalRole(
    profile && (profile.role || profile.accountRole || profile.portalRole) || fallbackRole
  );
}

function profilePhone(profile) {
  if (!profile) return '';
  return normalizePhone(
    profile.phone || profile.mobile || profile.mobileNumber || profile.phoneNumber || profile.contactNumber || ''
  );
}

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Admin login ಅಗತ್ಯವಿದೆ.');
  }

  const email = String(request.auth.token.email || '').trim().toLowerCase();
  if (email !== ADMIN_EMAIL.toLowerCase()) {
    throw new HttpsError('permission-denied', 'ಅನುಮತಿಸಲಾದ Admin ಮಾತ್ರ ಈ ಕಾರ್ಯ ಮಾಡಬಹುದು.');
  }

  const adminFlag = await getDatabase().ref(`admins/${request.auth.uid}`).get();
  if (adminFlag.val() !== true) {
    throw new HttpsError('permission-denied', 'ಈ Firebase accountಗೆ Admin ಅನುಮತಿ ಇಲ್ಲ.');
  }

  return request.auth.uid;
}

exports.sendAdminPushTest = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Admin login ಅಗತ್ಯವಿದೆ.');
  }

  const email = String(request.auth.token.email || '').toLowerCase();

  if (email !== ADMIN_EMAIL.toLowerCase()) {
    throw new HttpsError('permission-denied', 'Admin ಮಾತ್ರ Test Push ಕಳುಹಿಸಬಹುದು.');
  }

  const uid = request.auth.uid;
  const ref = getDatabase().ref(`adminFcmTokens/${uid}`);
  const snap = await ref.get();

  if (!snap.exists()) {
    throw new HttpsError(
      'failed-precondition',
      'ಈ Admin ಸಾಧನದ FCM Token ಸಿಕ್ಕಿಲ್ಲ. ಮೊದಲು Admin Push Enable ಮಾಡಿ.'
    );
  }

  // V98 token storage: adminFcmTokens/{uid}/{token}
  const tokenEntries = [];
  const seenTokens = new Set();

  snap.forEach(child => {
    const value = child.val();
    const token = typeof value === 'string'
      ? value
      : value && value.token;

    if (token && !seenTokens.has(token)) {
      seenTokens.add(token);
      tokenEntries.push({
        key: child.key,
        token: token
      });
    }
  });

  if (!tokenEntries.length) {
    throw new HttpsError(
      'failed-precondition',
      'FCM Token ಖಾಲಿಯಾಗಿದೆ.'
    );
  }

  let successCount = 0;
  let failureCount = 0;
  const messaging = getMessaging();

  for (let i = 0; i < tokenEntries.length; i += 500) {
    const batchEntries = tokenEntries.slice(i, i + 500);
    const batch = batchEntries.map(entry => entry.token);

    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: {
        title: 'NEOCURE Admin Test',
        body: 'Admin Push Notification ಸರಿಯಾಗಿ ಕೆಲಸ ಮಾಡುತ್ತಿದೆ.'
      },
      data: {
        type: 'ADMIN_PUSH_TEST',
        url: '/admin/'
      },
      webpush: {
        fcmOptions: {
          link: 'https://neocure-new.vercel.app/admin/'
        },
        notification: {
          icon: '/favicon.ico',
          tag: 'neocure-admin-test'
        }
      }
    });

    successCount += result.successCount;
    failureCount += result.failureCount;

    // Delete invalid tokens using their actual Firebase child keys.
    const tokenUpdates = {};

    result.responses.forEach((response, index) => {
      const code = response.error && response.error.code;

      if (!response.success && (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      )) {
        tokenUpdates[batchEntries[index].key] = null;
      }
    });

    if (Object.keys(tokenUpdates).length) {
      await ref.update(tokenUpdates);
    }
  }

  return {
    successCount,
    failureCount,
    tokenCount: tokenEntries.length
  };
});

// Called from the Dealer / Applicator login screen before authentication.
// It accepts no MPIN and never writes or exposes a user's password.
exports.createMpinResetRequest = onCall({ region: REGION }, async (request) => {
  try {
    const data = request.data || {};
    const phone = normalizePhone(data.phone);
    const role = normalizePortalRole(data.role);

    if (!/^\d{10}$/.test(phone)) {
      throw new HttpsError('invalid-argument', 'ಸರಿಯಾದ 10 ಅಂಕಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯನ್ನು ನಮೂದಿಸಿ.');
    }
    if (!['dealer', 'applicator'].includes(role)) {
      throw new HttpsError('invalid-argument', 'Portal role Dealer ಅಥವಾ Applicator ಆಗಿರಬೇಕು.');
    }

    // Resolve the exact Firebase Auth account used by the Dealer/Applicator app.
    const accountEmail = `${authRolePrefix(role)}.${phone}@${AUTH_DOMAIN}`;
    let userRecord;
    try {
      userRecord = await getAuth().getUserByEmail(accountEmail);
    } catch (error) {
      if (error && error.code === 'auth/user-not-found') {
        throw new HttpsError('not-found', 'ಈ Portalಗೆ ಈ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯ Registered Account ಸಿಗಲಿಲ್ಲ.');
      }
      throw error;
    }

    const profileSnap = await getDatabase().ref(`users/${userRecord.uid}`).get();
    if (!profileSnap.exists()) {
      throw new HttpsError('failed-precondition', 'ಈ Accountನ User Profile ಸಿಗಲಿಲ್ಲ. Admin ಪರಿಶೀಲಿಸಿ.');
    }

    const profile = profileSnap.val() || {};
    const savedRole = profileRole(profile, role);
    const savedPhone = profilePhone(profile);
    if (savedRole !== role || (savedPhone && savedPhone !== phone)) {
      throw new HttpsError('failed-precondition', 'Mobile Number ಅಥವಾ Portal Role Accountಗೆ ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.');
    }

    const requestsRef = getDatabase().ref('mpinResetRequests');
    const existingSnap = await requestsRef.get();
    let existingPending = null;
    existingSnap.forEach(child => {
      const value = child.val() || {};
      if (
        normalizePhone(value.phone) === phone &&
        normalizePortalRole(value.role) === role &&
        String(value.status || '').toLowerCase() === 'pending'
      ) {
        existingPending = child.key;
      }
    });

    if (existingPending) {
      return { success: true, requestId: existingPending, status: 'Pending', alreadyPending: true };
    }

    const newRequestRef = requestsRef.push();
    await newRequestRef.set({
      phone,
      role,
      status: 'Pending',
      requestedAt: Date.now(),
      source: 'dealer_app'
    });

    console.info('MPIN reset request created', { requestId: newRequestRef.key, role });
    return { success: true, requestId: newRequestRef.key, status: 'Pending' };
  } catch (error) {
    console.error('createMpinResetRequest failed', {
      code: error && error.code ? error.code : 'unknown',
      message: error && error.message ? error.message : String(error)
    });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'MPIN reset request ಕಳುಹಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.');
  }
});

// Called only by the authenticated Admin MPIN Reset screen.
// The Admin supplies the new 4-digit MPIN; this function updates Firebase
// Authentication using the same password format as dealer(1).html.
// The actual MPIN is never stored in Realtime Database or function logs.
exports.adminResetMpin = onCall({ region: REGION }, async (request) => {
  try {
    const adminUid = await requireAdmin(request);
    const data = request.data || {};
    const requestId = String(data.requestId || '').trim();
    const phone = normalizePhone(data.phone);
    const role = normalizePortalRole(data.role);
    const newPin = String(data.newPin || '').trim();

    if (!requestId) throw new HttpsError('invalid-argument', 'MPIN Reset Request ID ಸಿಗಲಿಲ್ಲ.');
    if (!/^\d{10}$/.test(phone)) throw new HttpsError('invalid-argument', 'ಸರಿಯಾದ 10 ಅಂಕಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ಅಗತ್ಯವಿದೆ.');
    if (!['dealer', 'applicator'].includes(role)) throw new HttpsError('invalid-argument', 'Dealer ಅಥವಾ Applicator role ಆಯ್ಕೆಮಾಡಿ.');
    if (!/^\d{4}$/.test(newPin)) throw new HttpsError('invalid-argument', 'ಹೊಸ MPIN ನಿಖರವಾಗಿ 4 ಅಂಕಿಗಳಾಗಿರಬೇಕು.');

    const requestRef = getDatabase().ref(`mpinResetRequests/${requestId}`);
    const resetSnap = await requestRef.get();
    if (!resetSnap.exists()) throw new HttpsError('not-found', 'MPIN Reset Request ಸಿಗಲಿಲ್ಲ.');

    const resetRequest = resetSnap.val() || {};
    if (String(resetRequest.status || '').toLowerCase() !== 'pending') {
      throw new HttpsError('failed-precondition', 'ಈ MPIN Reset Request ಈಗ Pending ಸ್ಥಿತಿಯಲ್ಲಿಲ್ಲ.');
    }
    if (
      normalizePhone(resetRequest.phone) !== phone ||
      normalizePortalRole(resetRequest.role) !== role
    ) {
      throw new HttpsError('permission-denied', 'Requestನ Mobile Number ಅಥವಾ Role ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.');
    }

    const accountEmail = `${authRolePrefix(role)}.${phone}@${AUTH_DOMAIN}`;
    let targetUser;
    try {
      targetUser = await getAuth().getUserByEmail(accountEmail);
    } catch (error) {
      if (error && error.code === 'auth/user-not-found') {
        throw new HttpsError('not-found', 'ಈ Mobile Numberಗೆ Firebase Login Account ಸಿಗಲಿಲ್ಲ.');
      }
      throw error;
    }

    const profileSnap = await getDatabase().ref(`users/${targetUser.uid}`).get();
    if (!profileSnap.exists()) throw new HttpsError('failed-precondition', 'User Profile ಸಿಗಲಿಲ್ಲ; MPIN ಬದಲಾಯಿಸಲಾಗಿಲ್ಲ.');

    const profile = profileSnap.val() || {};
    if (profileRole(profile, role) !== role) {
      throw new HttpsError('failed-precondition', 'Firebase User Role ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ; MPIN ಬದಲಾಯಿಸಲಾಗಿಲ್ಲ.');
    }
    const savedPhone = profilePhone(profile);
    if (savedPhone && savedPhone !== phone) {
      throw new HttpsError('failed-precondition', 'Firebase User Mobile Number ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ; MPIN ಬದಲಾಯಿಸಲಾಗಿಲ್ಲ.');
    }

    const firebasePassword = `NcLive!${newPin}#26`;
    await getAuth().updateUser(targetUser.uid, { password: firebasePassword });

    // Do not store newPin / firebasePassword in the database.
    await requestRef.update({
      status: 'Completed',
      completedAt: Date.now(),
      completedBy: adminUid,
      authUid: targetUser.uid
    });

    console.info('Admin completed MPIN reset', { requestId, role, adminUid });
    return { success: true, status: 'Completed', phone, role };
  } catch (error) {
    console.error('adminResetMpin failed', {
      code: error && error.code ? error.code : 'unknown',
      message: error && error.message ? error.message : String(error)
    });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'MPIN ಬದಲಾಯಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. Firebase Functions Logs ಪರಿಶೀಲಿಸಿ.');
  }
});

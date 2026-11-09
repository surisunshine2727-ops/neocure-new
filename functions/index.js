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

// -----------------------------------------------------------------------------
// NEOCURE WebAuthn / Passkey (Fingerprint / Face unlock)
// Credentials and challenges are stored server-side in Realtime Database.
// Never store MPIN/password or private authenticator keys in this database.
// -----------------------------------------------------------------------------
const { randomBytes } = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const PASSKEY_RP_NAME = 'NEOCURE';
const PASSKEY_RP_ID = 'neocure-new.vercel.app';
const PASSKEY_ORIGINS = ['https://neocure-new.vercel.app'];
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function passkeyOrigin(request) {
  const origin = String(request.rawRequest && request.rawRequest.headers && request.rawRequest.headers.origin || '').replace(/\/$/, '');
  if (!PASSKEY_ORIGINS.includes(origin)) {
    throw new HttpsError('permission-denied', 'Passkeyಗೆ ಅನುಮತಿಸದ website origin.');
  }
  return origin;
}

function passkeyCredentialKey(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function passkeyBytes(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function passkeyJsonCredential(credential) {
  if (!credential || !credential.id || !credential.rawId || !credential.response) {
    throw new HttpsError('invalid-argument', 'Passkey credential ಅಪೂರ್ಣವಾಗಿದೆ.');
  }
  return credential;
}

async function findPortalUser(phone, role) {
  const accountEmail = `${authRolePrefix(role)}.${phone}@${AUTH_DOMAIN}`;
  let userRecord;
  try {
    userRecord = await getAuth().getUserByEmail(accountEmail);
  } catch (error) {
    if (error && error.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'ಈ Mobile Number ಮತ್ತು Portalಗೆ Passkey account ಸಿಗಲಿಲ್ಲ. ಮೊದಲು MPIN ಬಳಸಿ Login ಮಾಡಿ.');
    }
    throw error;
  }
  const profileSnap = await getDatabase().ref(`users/${userRecord.uid}`).get();
  if (!profileSnap.exists()) throw new HttpsError('failed-precondition', 'User profile ಸಿಗಲಿಲ್ಲ.');
  const profile = profileSnap.val() || {};
  if (profileRole(profile, role) !== role) throw new HttpsError('permission-denied', 'Portal role ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.');
  const savedPhone = profilePhone(profile);
  if (savedPhone && savedPhone !== phone) throw new HttpsError('permission-denied', 'Mobile number ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.');
  return { userRecord, profile };
}

exports.passkeyRegistrationOptions = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  try {
    if (!request.auth) throw new HttpsError('unauthenticated', 'ಮೊದಲು MPIN ಮೂಲಕ Login ಮಾಡಿ.');
    const origin = passkeyOrigin(request);
    const uid = request.auth.uid;
    const userRecord = await getAuth().getUser(uid);
    const profileSnap = await getDatabase().ref(`users/${uid}`).get();
    if (!profileSnap.exists()) throw new HttpsError('failed-precondition', 'User profile ಸಿಗಲಿಲ್ಲ.');
    const profile = profileSnap.val() || {};
    const role = profileRole(profile, '');
    if (!['dealer', 'applicator'].includes(role)) throw new HttpsError('permission-denied', 'Dealer ಅಥವಾ Applicator account ಮಾತ್ರ Passkey register ಮಾಡಬಹುದು.');
    const phone = profilePhone(profile);
    if (!/^\d{10}$/.test(phone)) throw new HttpsError('failed-precondition', 'Accountನಲ್ಲಿ ಸರಿಯಾದ 10 ಅಂಕಿಯ mobile number ಇಲ್ಲ.');

    const credentialsSnap = await getDatabase().ref(`passkeys/${uid}`).get();
    const excludeCredentials = [];
    credentialsSnap.forEach(child => {
      const c = child.val() || {};
      if (c.credentialID) excludeCredentials.push({ id: c.credentialID, transports: c.transports || [] });
    });

    const options = await generateRegistrationOptions({
      rpName: PASSKEY_RP_NAME,
      rpID: PASSKEY_RP_ID,
      userID: Buffer.from(uid),
      userName: userRecord.email || `${role}.${phone}`,
      userDisplayName: String(profile.name || profile.businessName || `${role} ${phone}`).slice(0, 64),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      },
      supportedAlgorithmIDs: [-7, -257]
    });
    await getDatabase().ref(`passkeyChallenges/${uid}/registration`).set({
      challenge: options.challenge,
      createdAt: Date.now(),
      origin
    });
    return { options };
  } catch (error) {
    console.error('passkeyRegistrationOptions failed', { code: error.code || 'unknown', message: error.message || String(error) });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', `Passkey registration options failed: ${error.message || 'unknown error'}`);
  }
});

exports.verifyPasskeyRegistration = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  try {
    if (!request.auth) throw new HttpsError('unauthenticated', 'ಮೊದಲು MPIN ಮೂಲಕ Login ಮಾಡಿ.');
    const origin = passkeyOrigin(request);
    const uid = request.auth.uid;
    const credential = passkeyJsonCredential(request.data && request.data.credential);
    const challengeRef = getDatabase().ref(`passkeyChallenges/${uid}/registration`);
    const challengeSnap = await challengeRef.get();
    const pending = challengeSnap.val() || {};
    if (!pending.challenge || Date.now() - Number(pending.createdAt || 0) > PASSKEY_CHALLENGE_TTL_MS) {
      throw new HttpsError('deadline-exceeded', 'Passkey registration session ಮುಗಿದಿದೆ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.');
    }
    if (pending.origin !== origin) throw new HttpsError('permission-denied', 'Passkey origin ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.');

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: PASSKEY_RP_ID,
      requireUserVerification: false
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpsError('permission-denied', 'Fingerprint / Passkey verification ವಿಫಲವಾಗಿದೆ.');
    }
    const info = verification.registrationInfo;
    const credentialID = Buffer.from(info.credential.id).toString('base64url');
    const credentialPublicKey = Buffer.from(info.credential.publicKey).toString('base64');
    const credentialRef = getDatabase().ref(`passkeys/${uid}/${passkeyCredentialKey(credentialID)}`);
    await credentialRef.set({
      credentialID,
      credentialPublicKey,
      counter: Number(info.credential.counter || 0),
      transports: (credential.response && credential.response.transports) || [],
      deviceType: info.credentialDeviceType || 'unknown',
      backedUp: !!info.credentialBackedUp,
      createdAt: Date.now(),
      rpID: PASSKEY_RP_ID
    });
    await challengeRef.remove();
    return { success: true, verified: true };
  } catch (error) {
    console.error('verifyPasskeyRegistration failed', { code: error.code || 'unknown', message: error.message || String(error) });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', `Passkey registration verification failed: ${error.message || 'unknown error'}`);
  }
});

exports.passkeyLoginOptions = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  try {
    const phone = normalizePhone(request.data && request.data.phone);
    const role = normalizePortalRole(request.data && request.data.role);
    if (!/^\d{10}$/.test(phone)) throw new HttpsError('invalid-argument', 'ಸರಿಯಾದ 10 ಅಂಕಿಯ mobile number ನಮೂದಿಸಿ.');
    if (!['dealer', 'applicator'].includes(role)) throw new HttpsError('invalid-argument', 'Dealer ಅಥವಾ Applicator role ಆಯ್ಕೆಮಾಡಿ.');
    const origin = passkeyOrigin(request);
    const { userRecord } = await findPortalUser(phone, role);
    const credentialsSnap = await getDatabase().ref(`passkeys/${userRecord.uid}`).get();
    const allowCredentials = [];
    credentialsSnap.forEach(child => {
      const c = child.val() || {};
      if (c.credentialID) allowCredentials.push({ id: c.credentialID, transports: c.transports || [] });
    });
    if (!allowCredentials.length) throw new HttpsError('failed-precondition', 'ಈ accountನಲ್ಲಿ Fingerprint register ಆಗಿಲ್ಲ. MPIN ಮೂಲಕ Login ಮಾಡಿ register ಮಾಡಿ.');

    const options = await generateAuthenticationOptions({
      rpID: PASSKEY_RP_ID,
      allowCredentials,
      userVerification: 'preferred'
    });
    const challengeKey = `${role}_${phone}`;
    await getDatabase().ref(`passkeyChallenges/login/${challengeKey}`).set({
      challenge: options.challenge,
      uid: userRecord.uid,
      createdAt: Date.now(),
      origin
    });
    return { options };
  } catch (error) {
    console.error('passkeyLoginOptions failed', { code: error.code || 'unknown', message: error.message || String(error) });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', `Passkey login options failed: ${error.message || 'unknown error'}`);
  }
});

exports.verifyPasskeyLogin = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  try {
    const phone = normalizePhone(request.data && request.data.phone);
    const role = normalizePortalRole(request.data && request.data.role);
    if (!/^\d{10}$/.test(phone) || !['dealer', 'applicator'].includes(role)) throw new HttpsError('invalid-argument', 'Mobile number ಅಥವಾ portal role ತಪ್ಪಾಗಿದೆ.');
    const origin = passkeyOrigin(request);
    const credential = passkeyJsonCredential(request.data && request.data.credential);
    const { userRecord, profile } = await findPortalUser(phone, role);
    const challengeKey = `${role}_${phone}`;
    const challengeRef = getDatabase().ref(`passkeyChallenges/login/${challengeKey}`);
    const challengeSnap = await challengeRef.get();
    const pending = challengeSnap.val() || {};
    if (pending.uid !== userRecord.uid || !pending.challenge || Date.now() - Number(pending.createdAt || 0) > PASSKEY_CHALLENGE_TTL_MS) {
      throw new HttpsError('deadline-exceeded', 'Passkey login session ಮುಗಿದಿದೆ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.');
    }
    if (pending.origin !== origin) throw new HttpsError('permission-denied', 'Passkey origin ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.');

    const credentialID = String(credential.id || credential.rawId || '');
    const storedSnap = await getDatabase().ref(`passkeys/${userRecord.uid}/${passkeyCredentialKey(credentialID)}`).get();
    if (!storedSnap.exists()) throw new HttpsError('permission-denied', 'ಈ Fingerprint accountಗೆ register ಆಗಿಲ್ಲ.');
    const stored = storedSnap.val() || {};
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: PASSKEY_RP_ID,
      credential: {
        id: stored.credentialID,
        publicKey: Buffer.from(stored.credentialPublicKey, 'base64'),
        counter: Number(stored.counter || 0),
        transports: stored.transports || []
      },
      requireUserVerification: false
    });
    if (!verification.verified) throw new HttpsError('permission-denied', 'Fingerprint / Passkey verification ವಿಫಲವಾಗಿದೆ.');
    await getDatabase().ref(`passkeys/${userRecord.uid}/${passkeyCredentialKey(credentialID)}`).update({
      counter: Number(verification.authenticationInfo.newCounter || 0),
      lastUsedAt: Date.now()
    });
    await challengeRef.remove();

    const status = String(profile.status || '').toLowerCase();
    if (!(profile.approved === true || status === 'active')) {
      throw new HttpsError('permission-denied', 'ಈ account ಇನ್ನೂ Admin approval ಪಡೆಯಬೇಕಿದೆ.');
    }
    const customToken = await getAuth().createCustomToken(userRecord.uid, { portalRole: role, passkeyLogin: true });
    return { success: true, customToken };
  } catch (error) {
    console.error('verifyPasskeyLogin failed', { code: error.code || 'unknown', message: error.message || String(error) });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', `Passkey login verification failed: ${error.message || 'unknown error'}`);
  }
});


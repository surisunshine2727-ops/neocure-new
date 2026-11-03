NEOCURE DEALER + ADMIN PUSH RELEASE — V7

CONTENTS
- index.html: Dealer App (root; original file retained)
- admin/index.html: Admin App (existing UI retained; FCM errors no longer become login-failure popups)
- firebase-messaging-sw.js: root-scope Firebase 8.10.1 service worker
- functions/index.js and functions/package.json: dealer-request push function
- database.rules.json: user's supplied rules preserved, coupons preserved, adminFcmTokens added

IMPORTANT DEPLOYMENT
1. Do not replace root index.html with admin/index.html. Put admin/index.html in GitHub /admin/index.html.
2. Put firebase-messaging-sw.js at the website root beside root index.html.
3. This release's database.rules.json preserves the rules text provided by the user, including coupons, and adds adminFcmTokens. Review before publishing.
4. Admin account must have admins/{adminUid} = true.
5. Enable Firebase Authentication Email/Password for Admin. Dealer app's anonymous auth requirement must remain enabled if the dealer app uses it.
6. Set/verify the FCM Web Push certificate VAPID public key in Firebase Console; Admin page contains the provided public key.
7. Deploy only the function first: firebase use neocure-live-2026; firebase deploy --only functions:notifyAdminsOnDealerRequest
8. Do not blindly deploy database rules with the function deployment. Publish rules separately only after reviewing.
9. HTTPS and browser notification permission are required. Test with a new pending dealer record after deployment.

WHAT WAS CHANGED
- Admin push setup failure is logged to console and does not show a Login failed popup after successful authentication.
- FCM availability is checked before attempting registration.
- Service worker imports the matching Firebase 8.10.1 app + messaging scripts and uses setBackgroundMessageHandler for SDK v8.
- User's existing rules were retained; coupons were retained; adminFcmTokens rules were added.

NOT CLAIMED
This ZIP has not been deployed to the user's GitHub/Vercel/Firebase project and has not been tested on a real Android device. Background push delivery still requires successful Firebase function deployment, valid VAPID configuration, token registration, and an end-to-end test.


DEALER APPROVAL PUSH (ಹೊಸದು)
- Dealer App login/pending screen ನಲ್ಲಿ Notification permission ಅನುಮತಿ ನೀಡಿದರೆ FCM token `dealerFcmTokens/{uid}/{deviceId}` ನಲ್ಲಿ ಉಳಿಯುತ್ತದೆ.
- Admin `Approve Dealer` ಅಥವಾ `Reject Request` ಮಾಡಿದಾಗ `notifyDealerOnApproval` Cloud Function Dealer‌ಗೆ Push ಕಳುಹಿಸುತ್ತದೆ.
- Dealer ಮೊಬೈಲ್‌ನಲ್ಲಿ Notification permission Allow ಇರಬೇಕು; HTTPS ಮತ್ತು FCM VAPID key ಸರಿಯಾಗಿರಬೇಕು.
- Firebase Console ನಲ್ಲಿ Cloud Functions deploy ಮಾಡಿದ ನಂತರ ಮಾತ್ರ server push ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತದೆ.
- Dealer App ಅನ್ನು ಒಮ್ಮೆ ತೆರೆಯಿ login ಮಾಡಿ Notification Allow ಮಾಡಬೇಕು; ಹಿಂದಿನ token ನೋಂದಾಯಿಸದ device ಗೆ ಹಳೆಯ approval event ಮರುಕಳುಹಿಸಲಾಗುವುದಿಲ್ಲ.


V5 CROSS-CHECK FIX
- Approval trigger compares normalized old/new decisions (pending/approved/rejected), so changing approved=true is detected even if a stale status string remains.
- Static checks: functions/index.js passes Node syntax check; database.rules.json parses as valid JSON.
- Browser/FCM delivery and Firebase deployment have NOT been executed from this environment.


V7 ADMIN APPROVAL RULE FIX
- The previous rules allowed a dealer to write their own users/{uid}, but did not allow an Admin to update another dealer record. This blocked Approve/Reject. V7 adds the Admin condition at users/$uid/.write.
- This is a necessary permission for the existing Admin approve/reject code. Review the full rules before publishing; do not deploy unrelated rules blindly.


V7.1 SAFETY PATCH (generated after static review)
- Dealer registration now writes only non-approval user fields; Dealer client no longer writes approved/status.
- Reworked users/{uid} rules: only Admin can write approval/status/reviewedAt; Dealer can write permitted own profile/metadata fields.
- Added dealer_ledger rules: Admin access and Dealer access matched to the phone stored in users/{uid}; Dealer phone is write-once.
- Added Admin 5-minute inactivity logout with expiry checks on visibility/pageshow/back navigation; logout signs out Firebase Auth.
- Static checks passed: JSON parse and Node syntax checks for Dealer/Admin inline JS and Cloud Functions.

IMPORTANT LIMITATIONS
- This patch does NOT migrate Dealer localStorage Orders, Khata, and other browser-only data to Firebase. Admin/Dealer cross-device Order and History synchronization still needs a separate data-model migration and live testing.
- appData rules remain broad for the current Admin/Dealer appData structure; review before production.
- Rules and HTML are not deployed. Back up live Realtime Database before publishing rules.
- Push notification delivery, approval flow, ledger writes, and idle timeout must be tested on the live HTTPS site and Android browser after deployment.

V7.2 DATA SYNC ADDITION
- Dealer Orders, Payments, and Khata local writes now also attempt to sync the same dealer-prefixed keys into appData/{uid}/{encodedKey}, which is the path the Admin Dealer Details page already reads.
- On Dealer account watcher start, existing local Orders/Payments/Khata are merged with the existing cloud arrays by record ID, then synchronized; this avoids blindly overwriting remote history.
- This is a best-effort sync; test write permissions and old local data merge behavior on a staging/live backup before production. Existing browser-only items outside these three data sets are not migrated.
- Payment screenshot image bytes are not uploaded by this change; only payment metadata and the existing ledger entry are synced.

V7.3 COMPLETION PATCH
- Added Firebase Storage SDK 8.10.1 to Dealer App.
- Payment submission now uploads the actual screenshot to Firebase Storage first, then saves payment metadata, proof URL/path, and ledger entry to Firebase. Failed upload stops submission and displays an error.
- Admin Payment History now includes a View Proof link when proofUrl is present.
- Dealer feature-store writes are synchronized to the existing appData/{uid}/{encodedKey} structure; startup migration merges array records by id for dealer data and also migrates additional dealer-owned local storage namespaces.
- Added storage.rules and firebase.json Storage rules mapping.
- Static syntax/JSON/ZIP checks are required before delivery.

DEPLOYMENT / TEST NOTES
- Enable Firebase Storage in the same Firebase project and deploy Storage rules (`firebase deploy --only storage`).
- Deploy Realtime Database rules separately only after backup (`firebase deploy --only database`).
- Deploy both notification functions (`firebase deploy --only functions`).
- Then deploy Hosting files. Do not deploy partial files from different versions.
- Storage read is restricted to authenticated sessions; upload is restricted to the matching Dealer UID and image files under 5 MB. Download URLs are stored with payment metadata for Admin's View Proof action.
- This remains untested against the live Firebase project. Storage billing/plan and bucket setup may be required by Firebase.
- Cross-device migration only covers the app's identified local-storage namespaces; run a full feature-by-feature live acceptance test before production use.

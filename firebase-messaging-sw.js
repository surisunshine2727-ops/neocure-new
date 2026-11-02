/* NEOCURE Admin background push notifications */
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: "AIzaSyABFEnv_KFSxvUvw7KpnW29QB34w4TTc14",
  authDomain: "neocure-live-2026.firebaseapp.com",
  databaseURL: "https://neocure-live-2026-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "neocure-live-2026",
  storageBucket: "neocure-live-2026.firebasestorage.app",
  messagingSenderId: "651603399266",
  appId: "1:651603399266:web:6a5004ed3e95283f81773b"
});
const messaging=firebase.messaging();
messaging.onBackgroundMessage(payload=>{
  const title=payload.notification?.title||'NEOCURE – New Dealer Request';
  self.registration.showNotification(title,{
    body:payload.notification?.body||'ಹೊಸ Dealer Request ಬಂದಿದೆ. Admin App ತೆರೆಯಿರಿ.',
    data:payload.data||{url:'/admin/'},icon:'/favicon.ico',tag:'neocure-dealer-request'
  });
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const target=event.notification.data?.url||'/admin/';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){if('focus'in client){client.navigate(target);return client.focus();}}
    return clients.openWindow(target);
  }));
});

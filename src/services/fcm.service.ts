import { query } from '../config/db';

let isFirebaseInitialized = false;
let admin: any = null;

try {
  admin = require('firebase-admin');
  const serviceAccountVar = process.env.FIREBASE_CREDENTIALS;
  if (serviceAccountVar) {
    const serviceAccount = JSON.parse(serviceAccountVar);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    isFirebaseInitialized = true;
    console.log('Firebase Admin SDK initialized successfully via env var.');
  } else {
    // Check if the serviceAccountKey.json file exists
    const fs = require('fs');
    const path = require('path');
    const keyPath = path.join(__dirname, '../../serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
      const serviceAccount = require(keyPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      isFirebaseInitialized = true;
      console.log('Firebase Admin SDK initialized successfully via file.');
    } else {
      console.warn('Firebase Admin credentials not found. Push notifications will run in dry-run/logging mode.');
    }
  }
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
}

export class FcmService {
  static async sendPushNotification(
    userId: number,
    title: string,
    body: string,
    data: Record<string, string> = {}
  ): Promise<boolean> {
    if (!isFirebaseInitialized || !admin) {
      console.log(`[FCM Dry-Run] Push to user ${userId}: "${title}" - "${body}"`);
      return false;
    }

    try {
      // Fetch user's FCM token and notifications_enabled status
      const userRes = await query(
        'SELECT fcm_token, notifications_enabled FROM users WHERE id = $1',
        [userId]
      );

      if (userRes.rowCount === 0) return false;
      const user = userRes.rows[0];

      if (!user.fcm_token || !user.notifications_enabled) {
        console.log(`FCM skipped for user ${userId}: token is empty or notifications are disabled.`);
        return false;
      }

      const message = {
        token: user.fcm_token,
        notification: {
          title,
          body,
        },
        data: {
          ...data,
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'high_importance_channel',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const response = await admin.messaging().send(message);
      console.log(`Successfully sent push notification to user ${userId}. Message ID: ${response}`);
      return true;
    } catch (error) {
      console.error(`Error sending push notification to user ${userId}:`, error);
      return false;
    }
  }
}

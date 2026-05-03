import { sendWhatsappMessage } from './lib/services/unipile';
import * as admin from 'firebase-admin';

import dotenv from 'dotenv';
dotenv.config();

// Initialize firebase admin to access connections
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

async function test() {
  console.log('Testing Unipile API...');
  try {
    // Need to get the primary connection account ID first
    const snapshot = await admin
      .firestore()
      .collection('connections')
      .where('status', '==', 'connected')
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log('No active connections found in DB.');
      return;
    }

    const accountId = snapshot.docs[0].data().instanceId;
    console.log(`Using account ID: ${accountId}`);

    const result = await sendWhatsappMessage(
      accountId,
      '+971501477891',
      'Hello from AI Content Outreach Agent! This is a test message.'
    );
    console.log('Result:', result);
  } catch (error) {
    console.error('Test failed:', error);
  }
}

test();

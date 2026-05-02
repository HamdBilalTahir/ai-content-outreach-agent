import * as admin from 'firebase-admin';

const requiredEnvVars = {
  projectId: {
    value: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    name: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  },
  clientEmail: {
    value: process.env.FIREBASE_CLIENT_EMAIL,
    name: 'FIREBASE_CLIENT_EMAIL',
  },
  privateKey: {
    value: process.env.FIREBASE_PRIVATE_KEY,
    name: 'FIREBASE_PRIVATE_KEY',
  },
};

for (const envVar of Object.values(requiredEnvVars)) {
  if (!envVar.value) {
    throw new Error(`Missing required environment variable: ${envVar.name}`);
  }
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: requiredEnvVars.projectId.value,
      clientEmail: requiredEnvVars.clientEmail.value,
      privateKey: requiredEnvVars.privateKey.value!.replace(/\\n/g, '\n'),
    }),
  });
}

export const db = admin.firestore();
export const adminAuth = admin.auth();

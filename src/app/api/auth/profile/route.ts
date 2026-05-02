import { NextResponse } from 'next/server';
import {
  getUserProfile,
  createUserProfile,
} from '../../../../../lib/db/userProfiles';

export async function POST(request: Request) {
  try {
    const { userId, email, name } = await request.json();

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    }

    let profile = await getUserProfile(userId);

    if (!profile) {
      profile = await createUserProfile(userId, email, name);
    }

    return NextResponse.json({ profile });
  } catch (error) {
    console.error('Error in profile route:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

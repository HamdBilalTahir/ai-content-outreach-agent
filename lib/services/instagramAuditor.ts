import { ApifyClient } from 'apify-client';

if (!process.env.APIFY_TOKEN) {
  throw new Error('Missing required environment variable: APIFY_TOKEN');
}

const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });

export interface InstagramPost {
  isVideo: boolean;
  viewCount: number | null;
  likeCount: number;
  thumbnailUrl: string;
  timestamp: string;
}

export interface InstagramAudit {
  postCount: number;
  posts: InstagramPost[];
  hasReels: boolean;
  avgEngagement: number;
}

function extractUsername(instagramUrl: string): string | null {
  const match = instagramUrl.match(/instagram\.com\/([^/?#]+)/);
  return match ? match[1] : null;
}

export async function auditInstagram(
  instagramUrl: string | null
): Promise<InstagramAudit | null> {
  if (!instagramUrl) return null;

  console.log(
    `\n[API: InstagramAuditor] Auditing Instagram profile: ${instagramUrl}`
  );
  const username = extractUsername(instagramUrl);
  if (!username) {
    console.error(
      `instagramAuditor: could not parse username from ${instagramUrl}`
    );
    return null;
  }

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 30_000)
  );

  try {
    console.log(
      `[API: InstagramAuditor] 📤 Summoning Apify bots to investigate @${username}...`
    );
    const payload = {
      directUrls: [`https://www.instagram.com/${username}/`],
      resultsType: 'posts',
      resultsLimit: 5,
    };
    console.log(
      `[API: InstagramAuditor] 📤 The Hit List:\n${JSON.stringify(payload, null, 2)}`
    );
    const run = await Promise.race([
      apify.actor('apify/instagram-scraper').call(payload),
      timeout,
    ]);
    console.log(
      `[API: InstagramAuditor] 📥 Apify bots returned from the mission.`
    );

    if (!run) {
      console.error(`instagramAuditor: Apify timed out for @${username}`);
      return null;
    }

    const { items } = await apify.dataset(run.defaultDatasetId).listItems();

    console.log(
      `[API: InstagramAuditor] 📥 Unpacking ${items.length} items of intel...`
    );

    if (!items.length) return null;

    const posts: InstagramPost[] = items.map((item) => {
      const raw = item as Record<string, unknown>;
      return {
        isVideo: Boolean(raw.isVideo ?? raw.type === 'Video'),
        viewCount:
          typeof raw.videoViewCount === 'number' ? raw.videoViewCount : null,
        likeCount: typeof raw.likesCount === 'number' ? raw.likesCount : 0,
        thumbnailUrl: String(raw.displayUrl ?? raw.thumbnailUrl ?? ''),
        timestamp: String(raw.timestamp ?? raw.takenAt ?? ''),
      };
    });

    const totalLikes = posts.reduce((sum, p) => sum + p.likeCount, 0);

    console.log(
      `[API: InstagramAuditor] ✅ Audit finished for @${username}. Posts: ${posts.length}`
    );
    return {
      postCount: posts.length,
      posts,
      hasReels: posts.some((p) => p.isVideo),
      avgEngagement: posts.length ? Math.round(totalLikes / posts.length) : 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `instagramAuditor: Apify call failed for @${username} — ${message}`
    );
    return null;
  }
}

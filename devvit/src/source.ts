import { MAX_SCAN, SOURCE, type Post, type Source } from './core.ts';

export type SdkPost = {
  id: string; subredditName: string; title: string; permalink: string; createdAt: Date;
  removed: boolean; removedByCategory?: string; spam: boolean; nsfw: boolean; stickied: boolean;
};
export type RedditReader = {
  getNewPosts(options: { subredditName: string; limit: number; pageSize: number }): { all(): Promise<SdkPost[]> };
  getPostById(id: `t3_${string}`): Promise<SdkPost>;
};
function normalize(p: SdkPost): Post {
  return {
    id: p.id, subredditName: p.subredditName, title: p.title,
    permalink: p.permalink, createdAt: p.createdAt.getTime(),
    unavailable: p.removed || p.spam || !!p.removedByCategory || p.title === '[deleted]' || p.title === '[removed]',
    nsfw: p.nsfw, stickied: p.stickied,
  };
}
export function makeSource(reddit: RedditReader): Source {
  return {
    latest: async () => (await reddit.getNewPosts({
      subredditName: SOURCE, limit: MAX_SCAN, pageSize: 100,
    }).all()).map(normalize),
    byId: async id => {
      if (!/^t3_[a-z0-9]+$/.test(id)) throw new Error('INVALID_POST_ID');
      return normalize(await reddit.getPostById(id as `t3_${string}`));
    },
  };
}

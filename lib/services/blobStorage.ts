import { put, del } from '@vercel/blob';

export async function uploadPlaybook(
  userId: string,
  agentRole: string,
  content: string
): Promise<string> {
  const filename = `playbooks/${userId}/${agentRole}_${Date.now()}.md`;
  const blob = await put(filename, content, {
    access: 'public',
  });
  return blob.url;
}

export async function deletePlaybook(url: string): Promise<void> {
  await del(url);
}

export async function getPlaybook(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch playbook');
  return res.text();
}

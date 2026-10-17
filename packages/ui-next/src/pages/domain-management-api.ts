import type { AutoCompleteItem } from '../components';

export function domainApiPrefix(domainId: string): string {
  return `/d/${encodeURIComponent(domainId)}`;
}

export async function searchDomainUsers(domainId: string, search: string): Promise<AutoCompleteItem[]> {
  const response = await fetch(`${domainApiPrefix(domainId)}/api/user.users`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: { search, limit: 10 }, projection: ['_id', 'uname'] }),
  });
  if (!response.ok) throw new Error(`User search failed: ${response.status}`);
  const result = await response.json() as Array<{ _id: number; uname?: string }> | { error?: string };
  if (!Array.isArray(result)) throw new Error(result.error || 'User search failed');
  return result.map((user) => ({
    key: String(user._id),
    label: user.uname || `#${user._id}`,
    hint: `#${user._id}`,
  }));
}

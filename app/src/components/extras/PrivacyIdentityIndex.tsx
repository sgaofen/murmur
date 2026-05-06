import { useEffect } from 'react';
import { getAllFriends, listReports } from '../../data/api';
import { registerIdentities } from '../../utils/privacy';

function reportNamePieces(name: string): string[] {
  const cleaned = name.replace(/\.md$/i, '').replace(/^\d+_/, '');
  const display = cleaned.replace(/^(.*?)__(.*)$/, '$1 ↔ $2').replace(/_/g, ' ');
  const pieces = new Set<string>([display]);
  cleaned.split(/__|↔/).forEach(part => pieces.add(part.replace(/_/g, ' ')));
  return [...pieces].map(s => s.trim()).filter(Boolean);
}

export function PrivacyIdentityIndex() {
  useEffect(() => {
    let cancelled = false;

    getAllFriends({ kind: 'all' })
      .then(friends => {
        if (!cancelled) {
          // Pass isGroup explicitly so groups always alias to "群 N" instead
          // of falling through to "朋友 XX" when the wxid doesn't end
          // @chatroom and the name doesn't contain 群.
          registerIdentities(friends.map(f => ({
            wxid: f.id, name: f.name, isGroup: f.isGroup,
          })));
        }
      })
      .catch(() => { /* Best-effort privacy index; pages still mask ids/patterns. */ });

    listReports()
      .then(reports => {
        if (cancelled) return;
        const entries = [...reports.friends, ...reports.pairs];
        registerIdentities(entries.flatMap(entry =>
          reportNamePieces(entry.name).map(name => ({ wxid: `report:${entry.path}:${name}`, name })),
        ));
      })
      .catch(() => { /* Reports are optional on fresh installs. */ });

    return () => { cancelled = true; };
  }, []);

  return null;
}

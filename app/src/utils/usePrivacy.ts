import { useEffect, useState } from 'react';
import { displayName, isPrivacyMode, subscribePrivacy } from './privacy';

export function usePrivacy(): boolean {
  const [enabled, setEnabled] = useState(isPrivacyMode());
  useEffect(() => subscribePrivacy(setEnabled), []);
  return enabled;
}

export function useDisplayName(
  wxid: string | undefined | null,
  realName: string | undefined | null,
): string {
  usePrivacy();
  return displayName(wxid, realName);
}

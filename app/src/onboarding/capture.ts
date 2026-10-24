// Mac key-capture job state as the dialogs see it — pure functions, no
// runtime imports (tests/js/onboarding_flow_check.mjs runs this file).
//
// A Frida round, the Frida install and a private-copy round all keep running
// in the backend when the screen changes. While one runs, the onboarding must
// not offer anything that kills or re-signs WeChat (the backend also refuses
// with KEY_CAPTURE_BUSY), and coming back to 实时抓取 must show that round
// instead of the method chooser.
import type { LiveKeyStatus, PrivateCopyStatus } from '../data/api';

export type CaptureMethod = 'frida' | 'private-copy';

/** A Frida round or the Frida install is running. */
export function liveBusy(s: Pick<LiveKeyStatus, 'job' | 'install'> | null | undefined): boolean {
  return !!(s?.job?.running || s?.install?.running);
}

/** A private-copy round is running. */
export function privateCopyBusy(s: Pick<PrivateCopyStatus, 'job'> | null | undefined): boolean {
  return !!s?.job?.running;
}

/** Which method to open straight away because its job is already running
 * (null = nothing running, show the chooser). */
export function resumeMethod(
  live: Pick<LiveKeyStatus, 'job' | 'install'> | null | undefined,
  pc: Pick<PrivateCopyStatus, 'job'> | null | undefined,
): CaptureMethod | null {
  if (privateCopyBusy(pc)) return 'private-copy';
  if (liveBusy(live)) return 'frida';
  return null;
}

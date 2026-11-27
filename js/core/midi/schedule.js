// Pacing MIDI output without page timers.
//
// Chrome throttles setTimeout in background tabs (to once a second, and to once a minute after five
// minutes hidden), so pacing that sleeps between messages crawls when the tab is not in front. Web
// MIDI's output.send(data, timestamp) is scheduled by the browser's MIDI clock, which is not
// throttled: senders give each message the time it is due and only wait (with a timer) while they are
// more than a look-ahead window ahead. The window is short while the page is visible (cancelling and
// live edits stay responsive) and long while it is hidden (the timers are slow then).

import { sleep } from '../bits.js';

const hidden = () => typeof document !== 'undefined' && document.hidden === true;

/** How far ahead of now messages may be scheduled (ms). */
export const lookahead = () => (hidden() ? 120000 : 1500);

/** Wait until `at` (a performance.now() time) is within the look-ahead window. */
export async function waitForSlot(at) {
  const ahead = at - performance.now() - lookahead();
  if (ahead > 0) await sleep(ahead);
}

/** Wait until `at` has passed (e.g. before reading back what scheduled messages wrote). */
export async function waitUntil(at) {
  const left = at - performance.now();
  if (left > 0) await sleep(left);
}

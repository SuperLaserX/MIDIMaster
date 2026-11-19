// MIDIMaster entry point.

import { Shell } from './shell/app.js';

const shell = new Shell();
window.midimaster = shell; // handy for console experiments
shell.start();

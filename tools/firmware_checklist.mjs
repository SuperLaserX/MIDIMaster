// Writes docs/FIRMWARE_CHECKLIST.md: every firmware in the firmware folder (all subfolders), one
// checklist line per device, grouped by device type, with the devices MIDIMaster has a finished
// editor for ticked.
//
// usage: node tools/firmware_checklist.mjs [firmware-folder] [--out <file>] [--stdout]
//   firmware-folder  default z:/firmwares
//   --out <file>     default docs/FIRMWARE_CHECKLIST.md
//   --stdout         print the document instead of writing it
//
// Read-only on the firmware folder: nothing is extracted or run. Member names of .zip files are read
// from their central directory; those of .rar/.7z come from tools/firmware/catalog.json when listed.
//
// Which device a firmware belongs to, first match wins:
//   1. RULES below (path relative to the firmware folder, with forward slashes);
//   2. the `archives` of the MIDIMaster catalog (js/devices/catalog-data.js, catalog-extra.js);
//   3. the catalog builder's rules (tools/firmware/devices.py), for files added since the catalog was built.
// A folder that none of these names is walked into when it holds archives or folders, otherwise it
// is one item. Anything left is listed under "Not identified".
// Editor state: the registry (js/devices/registry.js), js/devices/levels.js, EDITORS below (wording
// from docs/devices/*.md and docs/FUTURE_WORK.md) and the translator backlog in tests/mainlib.test.js.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Tables to extend
// ---------------------------------------------------------------------------------------------

/** Devices with firmware in the folder that the MIDIMaster catalog does not have yet. type: catalog codes (GROUPS). */
const NEW_DEVICES = {
  'korg-grandstage-x': { maker: 'Korg', model: 'Grandstage X', type: 'pno', midi: 'Y' },
  'korg-modwave': { maker: 'Korg', model: 'modwave (mkII, module)', type: 'syn', midi: 'Y' },
  'korg-multipoly': { maker: 'Korg', model: 'multipoly (module)', type: 'syn', midi: 'Y' },
  'korg-opsix': { maker: 'Korg', model: 'opsix (mkII, module, SE)', type: 'syn', midi: 'Y' },
  'korg-wavestate': { maker: 'Korg', model: 'wavestate (mkII, module, SE)', type: 'syn', midi: 'Y' },
  'roland-system-8': { maker: 'Roland', model: 'System-8', type: 'syn', midi: 'Y' },
  'yamaha-kx88': { maker: 'Yamaha', model: 'KX88 / KX76', type: 'ctl', midi: 'Y' },
  // Novation OS updates the user downloaded from Novation (2026-11-25), top level of z:/firmwares
  'novation-a-station': { maker: 'Novation', model: 'A-Station', type: 'syn', midi: 'Y' },
  'novation-k-station': { maker: 'Novation', model: 'K-Station', type: 'syn', midi: 'Y' },
  'novation-ks-rack': { maker: 'Novation', model: 'KS4 / KS5 / KS Rack', type: 'syn', midi: 'Y' },
  'novation-x-station': { maker: 'Novation', model: 'X-Station', type: 'syn', midi: 'Y' },
  'novation-xiosynth': { maker: 'Novation', model: 'XioSynth', type: 'syn', midi: 'Y' },
  // Split from the catalog's grouping (files checked; ids as in tools/firmware/midi_devices.json)
  'korg-01r-w': { maker: 'Korg', model: '01R/W', type: 'syn', midi: 'Y' },
  'roland-r-8-mkii': { maker: 'Roland', model: 'R-8 MKII', type: 'drm', midi: 'Y' },
  'roland-r-8m': { maker: 'Roland', model: 'R-8M', type: 'drm', midi: 'Y' },
  'e-mu-emulator': { maker: 'E-mu', model: 'Emulator', type: 'smp', midi: '?' },
  // Official downloads in z:/firmwares/<Maker>/<Model>/ (see z:/firmwares/DOWNLOADS.md and each maker's MANIFEST.md);
  // ids, makers and models as in tools/firmware/midi_devices.json. The two download blocks are written by the
  // script that fetched the files; edit them by hand only to fix an entry.
  // --- downloads: devices (generated) ---
  '1010music-blackbox': { maker: '1010music', model: 'Blackbox', type: 'smp', midi: 'Y' },
  '1010music-bluebox': { maker: '1010music', model: 'Bluebox', type: 'mix', midi: 'Y' },
  '1010music-lemondrop': { maker: '1010music', model: 'Lemondrop', type: 'syn', midi: 'Y' },
  'akai-ewi4000s': { maker: 'Akai', model: 'EWI4000s', type: 'oth', midi: 'Y' },
  'akai-force': { maker: 'Akai', model: 'Force', type: 'smp', midi: 'Y' },
  'akai-mpc-key-61': { maker: 'Akai', model: 'MPC Key 61', type: 'smp', midi: 'Y' },
  'akai-mpc-live': { maker: 'Akai', model: 'MPC Live', type: 'smp', midi: 'Y' },
  'akai-mpc-one': { maker: 'Akai', model: 'MPC One', type: 'smp', midi: 'Y' },
  'akai-mpc-renaissance': { maker: 'Akai', model: 'MPC Renaissance', type: 'oth', midi: 'Y' },
  'akai-mpc-x': { maker: 'Akai', model: 'MPC X', type: 'smp', midi: 'Y' },
  'akai-mpk49': { maker: 'Akai', model: 'MPK49', type: 'oth', midi: 'Y' },
  'akai-mpx16': { maker: 'Akai', model: 'MPX16', type: 'smp', midi: 'Y' },
  'alesis-adat-hd24': { maker: 'Alesis', model: 'ADAT HD24', type: 'rec', midi: 'Y' },
  'alesis-andromeda-a6': { maker: 'Alesis', model: 'Andromeda A6', type: 'syn', midi: 'Y' },
  'alesis-dm10': { maker: 'Alesis', model: 'DM10', type: 'drm', midi: 'Y' },
  'alesis-fusion': { maker: 'Alesis', model: 'Fusion', type: 'syn', midi: 'Y' },
  'alesis-ion': { maker: 'Alesis', model: 'Ion', type: 'syn', midi: 'Y' },
  'alesis-photon-x25': { maker: 'Alesis', model: 'Photon X25', type: 'oth', midi: 'Y' },
  'alesis-samplepad': { maker: 'Alesis', model: 'SamplePad', type: 'drm', midi: 'Y' },
  'alesis-strike': { maker: 'Alesis', model: 'Strike', type: 'drm', midi: 'Y' },
  'alesis-vortex': { maker: 'Alesis', model: 'Vortex', type: 'oth', midi: 'Y' },
  'arturia-astrolab': { maker: 'Arturia', model: 'AstroLab', type: 'syn', midi: 'Y' },
  'arturia-beatstep': { maker: 'Arturia', model: 'BeatStep', type: 'oth', midi: 'Y' },
  'arturia-beatstep-pro': { maker: 'Arturia', model: 'BeatStep Pro', type: 'seq', midi: 'Y' },
  'arturia-drumbrute': { maker: 'Arturia', model: 'DrumBrute', type: 'drm', midi: 'Y' },
  'arturia-keylab': { maker: 'Arturia', model: 'KeyLab', type: 'oth', midi: 'Y' },
  'arturia-keystep': { maker: 'Arturia', model: 'KeyStep', type: 'oth', midi: 'Y' },
  'arturia-keystep-pro': { maker: 'Arturia', model: 'KeyStep Pro', type: 'seq', midi: 'Y' },
  'arturia-matrixbrute': { maker: 'Arturia', model: 'MatrixBrute', type: 'syn', midi: 'Y' },
  'arturia-microbrute': { maker: 'Arturia', model: 'MicroBrute', type: 'syn', midi: 'Y' },
  'arturia-microfreak': { maker: 'Arturia', model: 'MicroFreak', type: 'syn', midi: 'Y' },
  'arturia-minibrute-2': { maker: 'Arturia', model: 'MiniBrute 2', type: 'syn', midi: 'Y' },
  'arturia-minifreak': { maker: 'Arturia', model: 'MiniFreak', type: 'syn', midi: 'Y' },
  'arturia-polybrute': { maker: 'Arturia', model: 'PolyBrute', type: 'syn', midi: 'Y' },
  'asm-hydrasynth': { maker: 'ASM', model: 'Hydrasynth', type: 'syn', midi: 'Y' },
  'asm-leviasynth': { maker: 'ASM', model: 'Leviasynth', type: 'syn', midi: 'Y' },
  'atari-520-st': { maker: 'Atari', model: '520 ST', type: 'cpu', midi: 'Y' },
  'atari-falcon030': { maker: 'Atari', model: 'Falcon030', type: 'cpu', midi: 'Y' },
  'atari-tt030': { maker: 'Atari', model: 'TT030', type: 'cpu', midi: 'Y' },
  'behringer-crave': { maker: 'Behringer', model: 'Crave', type: 'syn', midi: 'Y' },
  'behringer-deepmind-12': { maker: 'Behringer', model: 'DeepMind 12', type: 'syn', midi: 'Y' },
  'behringer-model-d': { maker: 'Behringer', model: 'Model D', type: 'syn', midi: 'Y' },
  'behringer-neutron': { maker: 'Behringer', model: 'Neutron', type: 'syn', midi: 'Y' },
  'behringer-rd-8': { maker: 'Behringer', model: 'RD-8', type: 'drm', midi: 'Y' },
  'behringer-wing': { maker: 'Behringer', model: 'Wing', type: 'mix', midi: 'Y' },
  'behringer-x-touch': { maker: 'Behringer', model: 'X-Touch', type: 'oth', midi: 'Y' },
  'behringer-x32': { maker: 'Behringer', model: 'X32', type: 'mix', midi: 'Y' },
  'behringer-xr18': { maker: 'Behringer', model: 'XR18', type: 'mix', midi: 'Y' },
  'black-corporation-deckard-s-dream': { maker: 'Black Corporation', model: 'Deckard\'s Dream', type: 'syn', midi: 'Y' },
  'black-corporation-kijimi': { maker: 'Black Corporation', model: 'Kijimi', type: 'syn', midi: 'Y' },
  'black-corporation-xerxes': { maker: 'Black Corporation', model: 'Xerxes', type: 'syn', midi: 'Y' },
  'boss-br-1180': { maker: 'Boss', model: 'BR-1180', type: 'rec', midi: 'Y' },
  'boss-br-1600cd': { maker: 'Boss', model: 'BR-1600CD', type: 'rec', midi: 'Y' },
  'boss-br-532': { maker: 'Boss', model: 'BR-532', type: 'rec', midi: 'Y' },
  'boss-br-800': { maker: 'Boss', model: 'BR-800', type: 'rec', midi: 'Y' },
  'boss-br-864': { maker: 'Boss', model: 'BR-864', type: 'rec', midi: 'Y' },
  'boss-br-900cd': { maker: 'Boss', model: 'BR-900CD', type: 'rec', midi: 'Y' },
  'boss-dd-200': { maker: 'Boss', model: 'DD-200', type: 'fx', midi: 'Y' },
  'boss-dd-500': { maker: 'Boss', model: 'DD-500', type: 'fx', midi: 'Y' },
  'boss-dr-880': { maker: 'Boss', model: 'DR-880', type: 'drm', midi: 'Y' },
  'boss-es-8': { maker: 'Boss', model: 'ES-8', type: 'oth', midi: 'Y' },
  'boss-gt-001': { maker: 'Boss', model: 'GT-001', type: 'gtr', midi: 'Y' },
  'boss-gt-1': { maker: 'Boss', model: 'GT-1', type: 'gtr', midi: 'Y' },
  'boss-gt-10': { maker: 'Boss', model: 'GT-10', type: 'gtr', midi: 'Y' },
  'boss-gt-100': { maker: 'Boss', model: 'GT-100', type: 'gtr', midi: 'Y' },
  'boss-gt-1000': { maker: 'Boss', model: 'GT-1000', type: 'gtr', midi: 'Y' },
  'boss-gx-10': { maker: 'Boss', model: 'GX-10', type: 'gtr', midi: 'Y' },
  'boss-gx-100': { maker: 'Boss', model: 'GX-100', type: 'gtr', midi: 'Y' },
  'boss-katana': { maker: 'Boss', model: 'Katana', type: 'gtr', midi: 'Y' },
  'boss-me-90': { maker: 'Boss', model: 'ME-90', type: 'gtr', midi: 'Y' },
  'boss-ms-3': { maker: 'Boss', model: 'MS-3', type: 'gtr', midi: 'Y' },
  'boss-rc-300': { maker: 'Boss', model: 'RC-300', type: 'fx', midi: 'Y' },
  'boss-rc-50': { maker: 'Boss', model: 'RC-50', type: 'fx', midi: 'Y' },
  'boss-rc-505': { maker: 'Boss', model: 'RC-505', type: 'fx', midi: 'Y' },
  'boss-rc-600': { maker: 'Boss', model: 'RC-600', type: 'fx', midi: 'Y' },
  'boss-sp-505': { maker: 'Boss', model: 'SP-505', type: 'smp', midi: 'Y' },
  'boss-sy-1000': { maker: 'Boss', model: 'SY-1000', type: 'gtr', midi: 'Y' },
  'boss-sy-200': { maker: 'Boss', model: 'SY-200', type: 'gtr', midi: 'Y' },
  'boss-sy-300': { maker: 'Boss', model: 'SY-300', type: 'gtr', midi: 'Y' },
  'boss-ve-500': { maker: 'Boss', model: 'VE-500', type: 'voc', midi: 'Y' },
  'boss-vg-800': { maker: 'Boss', model: 'VG-800', type: 'gtr', midi: 'Y' },
  'casio-dg-20': { maker: 'Casio', model: 'DG-20', type: 'gtr', midi: 'Y' },
  'casio-fz-10m': { maker: 'Casio', model: 'FZ-10M', type: 'smp', midi: 'Y' },
  'casio-xw-p1': { maker: 'Casio', model: 'XW-P1', type: 'syn', midi: 'Y' },
  'clavia-nord-drum': { maker: 'Clavia', model: 'Nord Drum', type: 'drm', midi: 'Y' },
  'clavia-nord-electro-2': { maker: 'Clavia', model: 'Nord Electro 2', type: 'pno', midi: 'Y' },
  'clavia-nord-electro-3': { maker: 'Clavia', model: 'Nord Electro 3', type: 'pno', midi: 'Y' },
  'clavia-nord-electro-4': { maker: 'Clavia', model: 'Nord Electro 4', type: 'pno', midi: 'Y' },
  'clavia-nord-electro-5': { maker: 'Clavia', model: 'Nord Electro 5', type: 'pno', midi: 'Y' },
  'clavia-nord-electro-6': { maker: 'Clavia', model: 'Nord Electro 6', type: 'pno', midi: 'Y' },
  'clavia-nord-lead-4': { maker: 'Clavia', model: 'Nord Lead 4', type: 'syn', midi: 'Y' },
  'clavia-nord-lead-a1': { maker: 'Clavia', model: 'Nord Lead A1', type: 'syn', midi: 'Y' },
  'clavia-nord-modular-g2': { maker: 'Clavia', model: 'Nord Modular G2', type: 'syn', midi: 'Y' },
  'clavia-nord-stage': { maker: 'Clavia', model: 'Nord Stage', type: 'pno', midi: 'Y' },
  'clavia-nord-stage-2': { maker: 'Clavia', model: 'Nord Stage 2', type: 'pno', midi: 'Y' },
  'clavia-nord-stage-3': { maker: 'Clavia', model: 'Nord Stage 3', type: 'pno', midi: 'Y' },
  'clavia-nord-stage-4': { maker: 'Clavia', model: 'Nord Stage 4', type: 'pno', midi: 'Y' },
  'clavia-nord-wave': { maker: 'Clavia', model: 'Nord Wave', type: 'syn', midi: 'Y' },
  'clavia-nord-wave-2': { maker: 'Clavia', model: 'Nord Wave 2', type: 'syn', midi: 'Y' },
  'dirtywave-m8': { maker: 'Dirtywave', model: 'M8', type: 'seq', midi: 'Y' },
  'dreadbox-nymphes': { maker: 'Dreadbox', model: 'Nymphes', type: 'syn', midi: 'Y' },
  'dreadbox-typhon': { maker: 'Dreadbox', model: 'Typhon', type: 'syn', midi: 'Y' },
  'e-mu-emulator-iv': { maker: 'E-mu', model: 'Emulator IV', type: 'smp', midi: 'Y' },
  'e-mu-proteus-pk-6': { maker: 'E-mu', model: 'Proteus PK-6', type: 'syn', midi: 'Y' },
  'edirol-pcr-300': { maker: 'Edirol', model: 'PCR-300', type: 'oth', midi: 'Y' },
  'electro-harmonix-45000': { maker: 'Electro-Harmonix', model: '45000', type: 'fx', midi: 'Y' },
  'elektron-analog-four': { maker: 'Elektron', model: 'Analog Four', type: 'syn', midi: 'Y' },
  'elektron-analog-heat': { maker: 'Elektron', model: 'Analog Heat', type: 'fx', midi: 'Y' },
  'elektron-analog-rytm': { maker: 'Elektron', model: 'Analog Rytm', type: 'drm', midi: 'Y' },
  'elektron-digitakt': { maker: 'Elektron', model: 'Digitakt', type: 'smp', midi: 'Y' },
  'elektron-digitone': { maker: 'Elektron', model: 'Digitone', type: 'syn', midi: 'Y' },
  'elektron-machinedrum': { maker: 'Elektron', model: 'Machinedrum', type: 'drm', midi: 'Y' },
  'elektron-model-cycles': { maker: 'Elektron', model: 'Model:Cycles', type: 'drm', midi: 'Y' },
  'elektron-model-samples': { maker: 'Elektron', model: 'Model:Samples', type: 'smp', midi: 'Y' },
  'elektron-monomachine': { maker: 'Elektron', model: 'Monomachine', type: 'syn', midi: 'Y' },
  'elektron-octatrack': { maker: 'Elektron', model: 'Octatrack', type: 'smp', midi: 'Y' },
  'elektron-syntakt': { maker: 'Elektron', model: 'Syntakt', type: 'drm', midi: 'Y' },
  'elektron-tonverk': { maker: 'Elektron', model: 'Tonverk', type: 'smp', midi: 'Y' },
  'encore-electronics-retrofit-midi-kits': { maker: 'Encore Electronics', model: 'Retrofit MIDI kits', type: 'oth', midi: 'Y' },
  'ensoniq-asr-88': { maker: 'Ensoniq', model: 'ASR-88', type: 'smp', midi: 'Y' },
  'erica-synths-bassline-db-01': { maker: 'Erica Synths', model: 'Bassline DB-01', type: 'syn', midi: 'Y' },
  'erica-synths-lxr-02': { maker: 'Erica Synths', model: 'LXR-02', type: 'drm', midi: 'Y' },
  'erica-synths-perkons-hd-01': { maker: 'Erica Synths', model: 'Perkons HD-01', type: 'drm', midi: 'Y' },
  'erica-synths-syntrx-ii': { maker: 'Erica Synths', model: 'Syntrx II', type: 'syn', midi: 'Y' },
  'eventide-eclipse': { maker: 'Eventide', model: 'Eclipse', type: 'fx', midi: 'Y' },
  'eventide-h7600': { maker: 'Eventide', model: 'H7600', type: 'fx', midi: 'Y' },
  'eventide-h8000': { maker: 'Eventide', model: 'H8000', type: 'fx', midi: 'Y' },
  'eventide-h9': { maker: 'Eventide', model: 'H9', type: 'fx', midi: 'Y' },
  'eventide-h9000': { maker: 'Eventide', model: 'H9000', type: 'fx', midi: 'Y' },
  'eventide-timefactor': { maker: 'Eventide', model: 'TimeFactor', type: 'fx', midi: 'Y' },
  'fractal-audio-ax8': { maker: 'Fractal Audio', model: 'AX8', type: 'gtr', midi: 'Y' },
  'fractal-audio-axe-fx-ii': { maker: 'Fractal Audio', model: 'Axe-Fx II', type: 'gtr', midi: 'Y' },
  'fractal-audio-axe-fx-iii': { maker: 'Fractal Audio', model: 'Axe-Fx III', type: 'gtr', midi: 'Y' },
  'fractal-audio-fm3': { maker: 'Fractal Audio', model: 'FM3', type: 'gtr', midi: 'Y' },
  'fractal-audio-mfc-101': { maker: 'Fractal Audio', model: 'MFC-101', type: 'oth', midi: 'Y' },
  'gem-s2': { maker: 'GEM', model: 'S2', type: 'syn', midi: 'Y' },
  'gem-wk4': { maker: 'GEM', model: 'WK4', type: 'arr', midi: 'Y' },
  'genoqs-octopus': { maker: 'genoQs', model: 'Octopus', type: 'seq', midi: 'Y' },
  'haken-audio-continuum': { maker: 'Haken Audio', model: 'Continuum', type: 'oth', midi: 'Y' },
  'headrush-pedalboard': { maker: 'Headrush', model: 'Pedalboard', type: 'gtr', midi: 'Y' },
  'ik-multimedia-uno-synth': { maker: 'IK Multimedia', model: 'UNO Synth', type: 'syn', midi: 'Y' },
  'jomox-alpha-base': { maker: 'Jomox', model: 'Alpha Base', type: 'drm', midi: 'Y' },
  'jomox-moonwind': { maker: 'Jomox', model: 'MoonWind', type: 'fx', midi: 'Y' },
  'jomox-resonator-neuronium': { maker: 'Jomox', model: 'Resonator Neuronium', type: 'syn', midi: 'Y' },
  'jomox-sunsyn': { maker: 'Jomox', model: 'Sunsyn', type: 'syn', midi: 'Y' },
  'jomox-xbase-888': { maker: 'Jomox', model: 'XBase 888', type: 'drm', midi: 'Y' },
  'jomox-xbase-999': { maker: 'Jomox', model: 'XBase 999', type: 'drm', midi: 'Y' },
  'kawai-k5000': { maker: 'Kawai', model: 'K5000', type: 'syn', midi: 'Y' },
  'ketron-sd90': { maker: 'Ketron', model: 'SD90', type: 'arr', midi: 'Y' },
  'korg-cx-3-2008': { maker: 'Korg', model: 'CX-3 (2008)', type: 'pno', midi: 'Y' },
  'korg-d1200': { maker: 'Korg', model: 'D1200', type: 'rec', midi: 'Y' },
  'korg-d1600': { maker: 'Korg', model: 'D1600', type: 'rec', midi: 'Y' },
  'korg-drumlogue': { maker: 'Korg', model: 'drumlogue', type: 'drm', midi: 'Y' },
  'korg-electribe-2': { maker: 'Korg', model: 'electribe 2', type: 'drm', midi: 'Y' },
  'korg-electribe-emx-1': { maker: 'Korg', model: 'Electribe EMX-1', type: 'drm', midi: 'Y' },
  'korg-electribe-esx-1': { maker: 'Korg', model: 'Electribe ESX-1', type: 'smp', midi: 'Y' },
  'korg-i3-2020': { maker: 'Korg', model: 'i3 (2020)', type: 'arr', midi: 'Y' },
  'korg-kaoss-pad-kp3': { maker: 'Korg', model: 'Kaoss Pad KP3', type: 'fx', midi: 'Y' },
  'korg-kaossilator-pro': { maker: 'Korg', model: 'Kaossilator Pro', type: 'syn', midi: 'Y' },
  'korg-karma': { maker: 'Korg', model: 'Karma', type: 'syn', midi: 'Y' },
  'korg-kingkorg': { maker: 'Korg', model: 'Kingkorg', type: 'syn', midi: 'Y' },
  'korg-krome': { maker: 'Korg', model: 'Krome', type: 'syn', midi: 'Y' },
  'korg-kronos': { maker: 'Korg', model: 'Kronos', type: 'syn', midi: 'Y' },
  'korg-m3': { maker: 'Korg', model: 'M3', type: 'syn', midi: 'Y' },
  'korg-m50': { maker: 'Korg', model: 'M50', type: 'syn', midi: 'Y' },
  'korg-microkey': { maker: 'Korg', model: 'microKEY', type: 'oth', midi: 'Y' },
  'korg-microkontrol': { maker: 'Korg', model: 'microKONTROL', type: 'oth', midi: 'Y' },
  'korg-microkorg-2': { maker: 'Korg', model: 'microKORG 2', type: 'syn', midi: 'Y' },
  'korg-microkorg-xl': { maker: 'Korg', model: 'microKORG XL', type: 'syn', midi: 'Y' },
  'korg-microx': { maker: 'Korg', model: 'MicroX', type: 'syn', midi: 'Y' },
  'korg-minilogue': { maker: 'Korg', model: 'minilogue', type: 'syn', midi: 'Y' },
  'korg-mono-poly': { maker: 'Korg', model: 'Mono/Poly', type: 'syn', midi: 'N', midiUpgrades: [{"maker":"Tubbutec","product":"ModyPoly","url":"https://tubbutec.de/modypoly/"},{"maker":"Kenton","product":"Mono/Poly MIDI retrofit kit","url":"https://kentonuk.com/support/retrofit-kit-manuals/"},{"maker":"CHD Elektroservis","product":"MP-KBD(A) Mono/Poly MIDI Interface \"A\"","url":"https://www.chd-el.cz/products/korg-mono-poly-midi-interface-a/"},{"maker":"CHD Elektroservis","product":"MP-KBD(B) Mono/Poly MIDI Interface \"B\"","url":"https://www.chd-el.cz/products/korg-mono-poly-midi-interface-b/"}] },
  'korg-monologue': { maker: 'Korg', model: 'monologue', type: 'syn', midi: 'Y' },
  'korg-ms2000': { maker: 'Korg', model: 'MS2000', type: 'syn', midi: 'Y' },
  'korg-nanokontrol': { maker: 'Korg', model: 'nanoKONTROL', type: 'oth', midi: 'Y' },
  'korg-nautilus': { maker: 'Korg', model: 'Nautilus', type: 'syn', midi: 'Y' },
  'korg-nts-1': { maker: 'Korg', model: 'nts-1', type: 'syn', midi: 'Y' },
  'korg-oasys': { maker: 'Korg', model: 'OASYS', type: 'syn', midi: 'Y' },
  'korg-pa1x': { maker: 'Korg', model: 'Pa1X', type: 'arr', midi: 'Y' },
  'korg-pa300': { maker: 'Korg', model: 'Pa300', type: 'arr', midi: 'Y' },
  'korg-pa3x': { maker: 'Korg', model: 'Pa3X', type: 'arr', midi: 'Y' },
  'korg-pa4x': { maker: 'Korg', model: 'Pa4X', type: 'arr', midi: 'Y' },
  'korg-pa500': { maker: 'Korg', model: 'Pa500', type: 'arr', midi: 'Y' },
  'korg-pa5x': { maker: 'Korg', model: 'Pa5X', type: 'arr', midi: 'Y' },
  'korg-pa700': { maker: 'Korg', model: 'Pa700', type: 'arr', midi: 'Y' },
  'korg-pa80': { maker: 'Korg', model: 'Pa80', type: 'arr', midi: 'Y' },
  'korg-pa800': { maker: 'Korg', model: 'Pa800', type: 'arr', midi: 'Y' },
  'korg-pa900': { maker: 'Korg', model: 'Pa900', type: 'arr', midi: 'Y' },
  'korg-phase8': { maker: 'Korg', model: 'phase8', type: 'syn', midi: 'Y' },
  'korg-prologue': { maker: 'Korg', model: 'prologue', type: 'syn', midi: 'Y' },
  'korg-radias': { maker: 'Korg', model: 'Radias', type: 'syn', midi: 'Y' },
  'korg-rk-100s': { maker: 'Korg', model: 'RK-100S', type: 'oth', midi: 'Y' },
  'korg-sq-64': { maker: 'Korg', model: 'SQ-64', type: 'seq', midi: 'Y' },
  'korg-sv-1': { maker: 'Korg', model: 'SV-1', type: 'pno', midi: 'Y' },
  'korg-sv-2': { maker: 'Korg', model: 'SV-2', type: 'pno', midi: 'Y' },
  'korg-tr': { maker: 'Korg', model: 'TR', type: 'syn', midi: 'Y' },
  'korg-triton-extreme': { maker: 'Korg', model: 'Triton Extreme', type: 'syn', midi: 'Y' },
  'korg-triton-le': { maker: 'Korg', model: 'Triton Le', type: 'syn', midi: 'Y' },
  'korg-triton-os': { maker: 'Korg', model: 'Triton', type: 'syn', midi: 'Y' },
  'korg-triton-rack': { maker: 'Korg', model: 'Triton Rack', type: 'syn', midi: 'Y' },
  'korg-triton-studio': { maker: 'Korg', model: 'Triton Studio', type: 'syn', midi: 'Y' },
  'korg-volca-drum': { maker: 'Korg', model: 'volca drum', type: 'drm', midi: 'Y' },
  'korg-volca-fm': { maker: 'Korg', model: 'volca FM', type: 'syn', midi: 'Y' },
  'korg-volca-modular': { maker: 'Korg', model: 'volca modular', type: 'syn', midi: 'Y' },
  'korg-volca-nubass': { maker: 'Korg', model: 'volca nubass', type: 'syn', midi: 'Y' },
  'korg-volca-sample': { maker: 'Korg', model: 'volca sample', type: 'smp', midi: 'Y' },
  'kurzweil-k2088': { maker: 'Kurzweil', model: 'K2088', type: 'syn', midi: 'Y' },
  'kurzweil-k2600': { maker: 'Kurzweil', model: 'K2600', type: 'syn', midi: 'Y' },
  'kurzweil-k2661': { maker: 'Kurzweil', model: 'K2661', type: 'syn', midi: 'Y' },
  'kurzweil-k2700': { maker: 'Kurzweil', model: 'K2700', type: 'syn', midi: 'Y' },
  'kurzweil-ksp8': { maker: 'Kurzweil', model: 'KSP8', type: 'fx', midi: 'Y' },
  'kurzweil-pc1x': { maker: 'Kurzweil', model: 'PC1X', type: 'pno', midi: 'Y' },
  'kurzweil-pc2': { maker: 'Kurzweil', model: 'PC2', type: 'pno', midi: 'Y' },
  'kurzweil-pc3': { maker: 'Kurzweil', model: 'PC3', type: 'syn', midi: 'Y' },
  'kurzweil-pc361': { maker: 'Kurzweil', model: 'PC361', type: 'syn', midi: 'Y' },
  'kurzweil-pc4': { maker: 'Kurzweil', model: 'PC4', type: 'syn', midi: 'Y' },
  'lexicon-mx200': { maker: 'Lexicon', model: 'MX200', type: 'fx', midi: 'Y' },
  'lexicon-pcm96': { maker: 'Lexicon', model: 'PCM96', type: 'fx', midi: 'Y' },
  'linn-adrenalinn': { maker: 'Linn', model: 'AdrenaLinn', type: 'fx', midi: 'Y' },
  'linn-linnstrument': { maker: 'Linn', model: 'LinnStrument', type: 'oth', midi: 'Y' },
  'm-audio-hammer-88': { maker: 'M-Audio', model: 'Hammer 88', type: 'oth', midi: 'Y' },
  'm-audio-oxygen-8': { maker: 'M-Audio', model: 'Oxygen 8', type: 'oth', midi: 'Y' },
  'manikin-memotron': { maker: 'Manikin', model: 'Memotron', type: 'syn', midi: 'Y' },
  'manikin-schrittmacher': { maker: 'Manikin', model: 'Schrittmacher', type: 'seq', midi: 'Y' },
  'melbourne-instruments-nina': { maker: 'Melbourne Instruments', model: 'Nina', type: 'syn', midi: 'Y' },
  'mfb-tanzbar': { maker: 'MFB', model: 'Tanzbär', type: 'drm', midi: 'Y' },
  'mfb-tanzmaus': { maker: 'MFB', model: 'Tanzmaus', type: 'drm', midi: 'Y' },
  'midiman-midisport-2x2': { maker: 'Midiman', model: 'MIDISPORT 2x2', type: 'if', midi: 'Y' },
  'moog-grandmother': { maker: 'Moog', model: 'Grandmother', type: 'syn', midi: 'Y' },
  'moog-little-phatty': { maker: 'Moog', model: 'Little Phatty', type: 'syn', midi: 'Y' },
  'moog-minitaur': { maker: 'Moog', model: 'Minitaur', type: 'syn', midi: 'Y' },
  'moog-sub-37': { maker: 'Moog', model: 'Sub 37', type: 'syn', midi: 'Y' },
  'moog-sub-phatty': { maker: 'Moog', model: 'Sub Phatty', type: 'syn', midi: 'Y' },
  'moog-taurus-3': { maker: 'Moog', model: 'Taurus 3', type: 'syn', midi: 'Y' },
  'music-quest-pc-midi-card': { maker: 'Music Quest', model: 'PC MIDI Card', type: 'cpu', midi: 'Y' },
  'mutable-instruments-ambika': { maker: 'Mutable Instruments', model: 'Ambika', type: 'syn', midi: 'Y' },
  'mutable-instruments-shruthi-1': { maker: 'Mutable Instruments', model: 'Shruthi-1', type: 'syn', midi: 'Y' },
  'nonlinear-labs-c15': { maker: 'Nonlinear Labs', model: 'C15', type: 'syn', midi: 'Y' },
  'novation-bass-station-ii': { maker: 'Novation', model: 'Bass Station II', type: 'syn', midi: 'Y' },
  'novation-launch-control-xl': { maker: 'Novation', model: 'Launch Control XL', type: 'oth', midi: 'Y' },
  'novation-launchkey': { maker: 'Novation', model: 'Launchkey', type: 'oth', midi: 'Y' },
  'novation-launchpad': { maker: 'Novation', model: 'Launchpad', type: 'oth', midi: 'Y' },
  'novation-ultranova': { maker: 'Novation', model: 'UltraNova', type: 'syn', midi: 'Y' },
  'oberheim-ob-6': { maker: 'Oberheim', model: 'OB-6', type: 'syn', midi: 'Y' },
  'oberheim-ob-x8': { maker: 'Oberheim', model: 'OB-X8', type: 'syn', midi: 'Y' },
  'oberheim-teo-5': { maker: 'Oberheim', model: 'Teo-5', type: 'syn', midi: 'Y' },
  'polyend-medusa': { maker: 'Polyend', model: 'Medusa', type: 'syn', midi: 'Y' },
  'polyend-play': { maker: 'Polyend', model: 'Play', type: 'drm', midi: 'Y' },
  'polyend-seq': { maker: 'Polyend', model: 'Seq', type: 'seq', midi: 'Y' },
  'polyend-synth': { maker: 'Polyend', model: 'Synth', type: 'syn', midi: 'Y' },
  'polyend-tracker': { maker: 'Polyend', model: 'Tracker', type: 'seq', midi: 'Y' },
  'radikal-technologies-accelerator': { maker: 'Radikal Technologies', model: 'Accelerator', type: 'syn', midi: 'Y' },
  'radikal-technologies-spectralis': { maker: 'Radikal Technologies', model: 'Spectralis', type: 'syn', midi: 'Y' },
  'rjm-mastermind-gt': { maker: 'RJM', model: 'Mastermind GT', type: 'oth', midi: 'Y' },
  'roland-a-49': { maker: 'Roland', model: 'A-49', type: 'oth', midi: 'Y' },
  'roland-aerophone-ae-10': { maker: 'Roland', model: 'Aerophone AE-10', type: 'oth', midi: 'Y' },
  'roland-aerophone-ae-30': { maker: 'Roland', model: 'Aerophone AE-30', type: 'oth', midi: 'Y' },
  'roland-ax-edge': { maker: 'Roland', model: 'AX-Edge', type: 'syn', midi: 'Y' },
  'roland-bk-5': { maker: 'Roland', model: 'BK-5', type: 'arr', midi: 'Y' },
  'roland-cm-32p': { maker: 'Roland', model: 'CM-32P', type: 'syn', midi: 'Y' },
  'roland-d-05': { maker: 'Roland', model: 'D-05', type: 'syn', midi: 'Y' },
  'roland-e-a7': { maker: 'Roland', model: 'E-A7', type: 'arr', midi: 'Y' },
  'roland-e-x50': { maker: 'Roland', model: 'E-X50', type: 'arr', midi: 'Y' },
  'roland-fantom-0': { maker: 'Roland', model: 'Fantom-0', type: 'syn', midi: 'Y' },
  'roland-fantom-2019': { maker: 'Roland', model: 'Fantom (2019)', type: 'syn', midi: 'Y' },
  'roland-fantom-g': { maker: 'Roland', model: 'Fantom-G', type: 'syn', midi: 'Y' },
  'roland-fantom-s': { maker: 'Roland', model: 'Fantom-S', type: 'syn', midi: 'Y' },
  'roland-fantom-x': { maker: 'Roland', model: 'Fantom-X', type: 'syn', midi: 'Y' },
  'roland-fc-300': { maker: 'Roland', model: 'FC-300', type: 'oth', midi: 'Y' },
  'roland-g-70': { maker: 'Roland', model: 'G-70', type: 'arr', midi: 'Y' },
  'roland-gaia-2': { maker: 'Roland', model: 'GAIA 2', type: 'syn', midi: 'Y' },
  'roland-gaia-sh-01': { maker: 'Roland', model: 'GAIA SH-01', type: 'syn', midi: 'Y' },
  'roland-gr-20': { maker: 'Roland', model: 'GR-20', type: 'gtr', midi: 'Y' },
  'roland-gr-55': { maker: 'Roland', model: 'GR-55', type: 'gtr', midi: 'Y' },
  'roland-handsonic-hpd-20': { maker: 'Roland', model: 'HandSonic HPD-20', type: 'drm', midi: 'Y' },
  'roland-integra-7': { maker: 'Roland', model: 'Integra-7', type: 'syn', midi: 'Y' },
  'roland-j-6': { maker: 'Roland', model: 'J-6', type: 'syn', midi: 'Y' },
  'roland-jd-08': { maker: 'Roland', model: 'JD-08', type: 'syn', midi: 'Y' },
  'roland-jd-xa': { maker: 'Roland', model: 'JD-XA', type: 'syn', midi: 'Y' },
  'roland-jd-xi': { maker: 'Roland', model: 'JD-Xi', type: 'syn', midi: 'Y' },
  'roland-jp-08': { maker: 'Roland', model: 'JP-08', type: 'syn', midi: 'Y' },
  'roland-ju-06': { maker: 'Roland', model: 'JU-06', type: 'syn', midi: 'Y' },
  'roland-juno-d': { maker: 'Roland', model: 'Juno-D', type: 'syn', midi: 'Y' },
  'roland-juno-d6': { maker: 'Roland', model: 'Juno-D6', type: 'syn', midi: 'Y' },
  'roland-juno-di': { maker: 'Roland', model: 'Juno-Di', type: 'syn', midi: 'Y' },
  'roland-juno-ds': { maker: 'Roland', model: 'Juno-DS', type: 'syn', midi: 'Y' },
  'roland-juno-g': { maker: 'Roland', model: 'Juno-G', type: 'syn', midi: 'Y' },
  'roland-juno-gi': { maker: 'Roland', model: 'Juno-Gi', type: 'syn', midi: 'Y' },
  'roland-juno-stage': { maker: 'Roland', model: 'Juno-Stage', type: 'syn', midi: 'Y' },
  'roland-juno-x': { maker: 'Roland', model: 'Juno-X', type: 'syn', midi: 'Y' },
  'roland-jupiter-50': { maker: 'Roland', model: 'Jupiter-50', type: 'syn', midi: 'Y' },
  'roland-jupiter-80': { maker: 'Roland', model: 'Jupiter-80', type: 'syn', midi: 'Y' },
  'roland-jupiter-x': { maker: 'Roland', model: 'Jupiter-X', type: 'syn', midi: 'Y' },
  'roland-jv-1010': { maker: 'Roland', model: 'JV-1010', type: 'syn', midi: 'Y' },
  'roland-jx-03': { maker: 'Roland', model: 'JX-03', type: 'syn', midi: 'Y' },
  'roland-jx-08': { maker: 'Roland', model: 'JX-08', type: 'syn', midi: 'Y' },
  'roland-lucina-ax-09': { maker: 'Roland', model: 'Lucina AX-09', type: 'syn', midi: 'Y' },
  'roland-mc-101': { maker: 'Roland', model: 'MC-101', type: 'drm', midi: 'Y' },
  'roland-mc-202': { maker: 'Roland', model: 'MC-202', type: 'syn', midi: 'N', midiUpgrades: [{"maker":"Tubbutec","product":"MC-2oh2","url":"https://tubbutec.de/mc-2oh2/"}] },
  'roland-mc-500': { maker: 'Roland', model: 'MC-500', type: 'seq', midi: 'Y' },
  'roland-mc-505': { maker: 'Roland', model: 'MC-505', type: 'drm', midi: 'Y' },
  'roland-mc-707': { maker: 'Roland', model: 'MC-707', type: 'drm', midi: 'Y' },
  'roland-mc-808': { maker: 'Roland', model: 'MC-808', type: 'drm', midi: 'Y' },
  'roland-mc-909': { maker: 'Roland', model: 'MC-909', type: 'drm', midi: 'Y' },
  'roland-mpu-401': { maker: 'Roland', model: 'MPU-401', type: 'if', midi: 'Y' },
  'roland-msq-700': { maker: 'Roland', model: 'MSQ-700', type: 'seq', midi: 'Y' },
  'roland-mt-100': { maker: 'Roland', model: 'MT-100', type: 'seq', midi: 'Y' },
  'roland-mv-1-verselab': { maker: 'Roland', model: 'MV-1 Verselab', type: 'drm', midi: 'Y' },
  'roland-mv-30': { maker: 'Roland', model: 'MV-30', type: 'seq', midi: 'Y' },
  'roland-mv-8000': { maker: 'Roland', model: 'MV-8000', type: 'smp', midi: 'Y' },
  'roland-mv-8800': { maker: 'Roland', model: 'MV-8800', type: 'smp', midi: 'Y' },
  'roland-mx-1': { maker: 'Roland', model: 'MX-1', type: 'mix', midi: 'Y' },
  'roland-octapad-spd-30': { maker: 'Roland', model: 'Octapad SPD-30', type: 'oth', midi: 'Y' },
  'roland-p-6': { maker: 'Roland', model: 'P-6', type: 'smp', midi: 'Y' },
  'roland-pr-100': { maker: 'Roland', model: 'PR-100', type: 'seq', midi: 'Y' },
  'roland-rss-10': { maker: 'Roland', model: 'RSS-10', type: 'fx', midi: 'Y' },
  'roland-s-1': { maker: 'Roland', model: 'S-1', type: 'syn', midi: 'Y' },
  'roland-sbx-1000': { maker: 'Roland', model: 'SBX-1000', type: 'if', midi: 'Y' },
  'roland-sc-33': { maker: 'Roland', model: 'SC-33', type: 'syn', midi: 'Y' },
  'roland-sc-8820': { maker: 'Roland', model: 'SC-8820', type: 'syn', midi: 'Y' },
  'roland-sc-8850': { maker: 'Roland', model: 'SC-8850', type: 'syn', midi: 'Y' },
  'roland-sc-88pro': { maker: 'Roland', model: 'SC-88Pro', type: 'syn', midi: 'Y' },
  'roland-sc-88vl': { maker: 'Roland', model: 'SC-88VL', type: 'syn', midi: 'Y' },
  'roland-sc-d70': { maker: 'Roland', model: 'SC-D70', type: 'syn', midi: 'Y' },
  'roland-scb-55': { maker: 'Roland', model: 'SCB-55', type: 'data', midi: 'Y' },
  'roland-sd-80': { maker: 'Roland', model: 'SD-80', type: 'syn', midi: 'Y' },
  'roland-sd-90': { maker: 'Roland', model: 'SD-90', type: 'syn', midi: 'Y' },
  'roland-sdx-330': { maker: 'Roland', model: 'SDX-330', type: 'fx', midi: 'Y' },
  'roland-se-02': { maker: 'Roland', model: 'SE-02', type: 'syn', midi: 'Y' },
  'roland-sh-01a': { maker: 'Roland', model: 'SH-01A', type: 'syn', midi: 'Y' },
  'roland-sh-32': { maker: 'Roland', model: 'SH-32', type: 'syn', midi: 'Y' },
  'roland-sh-4d': { maker: 'Roland', model: 'SH-4d', type: 'syn', midi: 'Y' },
  'roland-sk-88pro': { maker: 'Roland', model: 'SK-88Pro', type: 'syn', midi: 'Y' },
  'roland-sn-u110-pcm-cards': { maker: 'Roland', model: 'SN-U110 PCM cards', type: 'data', midi: 'Y' },
  'roland-sp-404': { maker: 'Roland', model: 'SP-404', type: 'smp', midi: 'Y' },
  'roland-sp-404mkii': { maker: 'Roland', model: 'SP-404MKII', type: 'smp', midi: 'Y' },
  'roland-sp-555': { maker: 'Roland', model: 'SP-555', type: 'smp', midi: 'Y' },
  'roland-sp-606': { maker: 'Roland', model: 'SP-606', type: 'smp', midi: 'Y' },
  'roland-sp-808': { maker: 'Roland', model: 'SP-808', type: 'smp', midi: 'Y' },
  'roland-spd-s': { maker: 'Roland', model: 'SPD-S', type: 'smp', midi: 'Y' },
  'roland-spd-sx': { maker: 'Roland', model: 'SPD-SX', type: 'smp', midi: 'Y' },
  'roland-srv-330': { maker: 'Roland', model: 'SRV-330', type: 'fx', midi: 'Y' },
  'roland-system-1': { maker: 'Roland', model: 'System-1', type: 'syn', midi: 'Y' },
  'roland-t-8': { maker: 'Roland', model: 'T-8', type: 'drm', midi: 'Y' },
  'roland-tb-03': { maker: 'Roland', model: 'TB-03', type: 'syn', midi: 'Y' },
  'roland-tb-303': { maker: 'Roland', model: 'TB-303', type: 'syn', midi: 'N', midiUpgrades: [{"maker":"Kenton","product":"TB-303 (retrofit box) MIDI retrofit kit","url":"https://kentonuk.com/support/retrofit-kit-manuals/"}] },
  'roland-td-02': { maker: 'Roland', model: 'TD-02', type: 'drm', midi: 'Y' },
  'roland-td-07': { maker: 'Roland', model: 'TD-07', type: 'drm', midi: 'Y' },
  'roland-td-11': { maker: 'Roland', model: 'TD-11', type: 'drm', midi: 'Y' },
  'roland-td-12': { maker: 'Roland', model: 'TD-12', type: 'drm', midi: 'Y' },
  'roland-td-15': { maker: 'Roland', model: 'TD-15', type: 'drm', midi: 'Y' },
  'roland-td-17': { maker: 'Roland', model: 'TD-17', type: 'drm', midi: 'Y' },
  'roland-td-20': { maker: 'Roland', model: 'TD-20', type: 'drm', midi: 'Y' },
  'roland-td-25': { maker: 'Roland', model: 'TD-25', type: 'drm', midi: 'Y' },
  'roland-td-30': { maker: 'Roland', model: 'TD-30', type: 'drm', midi: 'Y' },
  'roland-td-50': { maker: 'Roland', model: 'TD-50', type: 'drm', midi: 'Y' },
  'roland-td-713': { maker: 'Roland', model: 'TD-713', type: 'drm', midi: 'Y' },
  'roland-td-8': { maker: 'Roland', model: 'TD-8', type: 'drm', midi: 'Y' },
  'roland-tr-08': { maker: 'Roland', model: 'TR-08', type: 'drm', midi: 'Y' },
  'roland-tr-09': { maker: 'Roland', model: 'TR-09', type: 'drm', midi: 'Y' },
  'roland-tr-1000': { maker: 'Roland', model: 'TR-1000', type: 'drm', midi: 'Y' },
  'roland-tr-606': { maker: 'Roland', model: 'TR-606', type: 'drm', midi: 'N', midiUpgrades: [{"maker":"Tubbutec","product":"TR-6oh6","url":"https://tubbutec.de/tr-6oh6/"},{"maker":"Tubbutec","product":"uniPulse","url":"https://tubbutec.de/unipulse/"}] },
  'roland-tr-6s': { maker: 'Roland', model: 'TR-6S', type: 'drm', midi: 'Y' },
  'roland-tr-8': { maker: 'Roland', model: 'TR-8', type: 'drm', midi: 'Y' },
  'roland-tr-808': { maker: 'Roland', model: 'TR-808', type: 'drm', midi: 'N', midiUpgrades: [{"maker":"Tubbutec","product":"TR-8oh8","url":"https://tubbutec.de/tr-8oh8/"},{"maker":"Kenton","product":"TR-808 MIDI retrofit kit","url":"https://kentonuk.com/support/retrofit-kit-manuals/"},{"maker":"CHD Elektroservis","product":"TR808-M TR-808 MIDI Interface","url":"https://www.chd-el.cz/products/roland-tr808-midi-interface/"},{"maker":"Tubbutec","product":"uniPulse","url":"https://tubbutec.de/unipulse/"}] },
  'roland-tr-8s': { maker: 'Roland', model: 'TR-8S', type: 'drm', midi: 'Y' },
  'roland-v-accordion-fr-8x': { maker: 'Roland', model: 'V-Accordion FR-8x', type: 'oth', midi: 'Y' },
  'roland-v-synth': { maker: 'Roland', model: 'V-Synth', type: 'syn', midi: 'Y' },
  'roland-v-synth-gt': { maker: 'Roland', model: 'V-Synth GT', type: 'syn', midi: 'Y' },
  'roland-varios': { maker: 'Roland', model: 'VariOS', type: 'syn', midi: 'Y' },
  'roland-vb-99': { maker: 'Roland', model: 'VB-99', type: 'gtr', midi: 'Y' },
  'roland-vg-99': { maker: 'Roland', model: 'VG-99', type: 'gtr', midi: 'Y' },
  'roland-vm-3100': { maker: 'Roland', model: 'VM-3100', type: 'mix', midi: 'Y' },
  'roland-vm-7000': { maker: 'Roland', model: 'VM-7000', type: 'mix', midi: 'Y' },
  'roland-vp-03': { maker: 'Roland', model: 'VP-03', type: 'syn', midi: 'Y' },
  'roland-vs-1680': { maker: 'Roland', model: 'VS-1680', type: 'rec', midi: 'Y' },
  'roland-vs-1824cd': { maker: 'Roland', model: 'VS-1824CD', type: 'rec', midi: 'Y' },
  'roland-vs-1880': { maker: 'Roland', model: 'VS-1880', type: 'rec', midi: 'Y' },
  'roland-vs-2000cd': { maker: 'Roland', model: 'VS-2000CD', type: 'rec', midi: 'Y' },
  'roland-vs-2400cd': { maker: 'Roland', model: 'VS-2400CD', type: 'rec', midi: 'Y' },
  'roland-vs-2480': { maker: 'Roland', model: 'VS-2480', type: 'rec', midi: 'Y' },
  'roland-vs-840': { maker: 'Roland', model: 'VS-840', type: 'rec', midi: 'Y' },
  'roland-vs-880': { maker: 'Roland', model: 'VS-880', type: 'rec', midi: 'Y' },
  'roland-vs-890': { maker: 'Roland', model: 'VS-890', type: 'rec', midi: 'Y' },
  'roland-vt-4': { maker: 'Roland', model: 'VT-4', type: 'voc', midi: 'Y' },
  'roland-xv-3080': { maker: 'Roland', model: 'XV-3080', type: 'syn', midi: 'Y' },
  'roland-xv-5050': { maker: 'Roland', model: 'XV-5050', type: 'syn', midi: 'Y' },
  'roland-xv-5080': { maker: 'Roland', model: 'XV-5080', type: 'syn', midi: 'Y' },
  'roland-xv-88': { maker: 'Roland', model: 'XV-88', type: 'syn', midi: 'Y' },
  'sequential-evolver': { maker: 'Sequential', model: 'Evolver', type: 'syn', midi: 'Y' },
  'sequential-fourm': { maker: 'Sequential', model: 'Fourm', type: 'syn', midi: 'Y' },
  'sequential-mopho': { maker: 'Sequential', model: 'Mopho', type: 'syn', midi: 'Y' },
  'sequential-pro-2': { maker: 'Sequential', model: 'Pro 2', type: 'syn', midi: 'Y' },
  'sequential-pro-3': { maker: 'Sequential', model: 'Pro 3', type: 'syn', midi: 'Y' },
  'sequential-prophet-08': { maker: 'Sequential', model: 'Prophet \'08', type: 'syn', midi: 'Y' },
  'sequential-prophet-12': { maker: 'Sequential', model: 'Prophet 12', type: 'syn', midi: 'Y' },
  'sequential-prophet-5-rev4': { maker: 'Sequential', model: 'Prophet-5 Rev4', type: 'syn', midi: 'Y' },
  'sequential-prophet-6': { maker: 'Sequential', model: 'Prophet-6', type: 'syn', midi: 'Y' },
  'sequential-prophet-rev2': { maker: 'Sequential', model: 'Prophet Rev2', type: 'syn', midi: 'Y' },
  'sequential-prophet-x': { maker: 'Sequential', model: 'Prophet X', type: 'syn', midi: 'Y' },
  'sequential-take-5': { maker: 'Sequential', model: 'Take 5', type: 'syn', midi: 'Y' },
  'sequential-tempest': { maker: 'Sequential', model: 'Tempest', type: 'drm', midi: 'Y' },
  'sequential-tetra': { maker: 'Sequential', model: 'Tetra', type: 'syn', midi: 'Y' },
  'sequential-trigon-6': { maker: 'Sequential', model: 'Trigon-6', type: 'syn', midi: 'Y' },
  'sequentix-cirklon': { maker: 'Sequentix', model: 'Cirklon', type: 'seq', midi: 'Y' },
  'sequentix-p3': { maker: 'Sequentix', model: 'P3', type: 'seq', midi: 'Y' },
  'social-entropy-engine': { maker: 'Social Entropy', model: 'Engine', type: 'seq', midi: 'Y' },
  'sonic-potions-lxr': { maker: 'Sonic Potions', model: 'LXR', type: 'drm', midi: 'Y' },
  'sonicware-elz-1': { maker: 'Sonicware', model: 'ELZ_1', type: 'syn', midi: 'Y' },
  'sonicware-smpltrek': { maker: 'Sonicware', model: 'SmplTrek', type: 'smp', midi: 'Y' },
  'squarp-hapax': { maker: 'Squarp', model: 'Hapax', type: 'seq', midi: 'Y' },
  'squarp-pyramid': { maker: 'Squarp', model: 'Pyramid', type: 'seq', midi: 'Y' },
  'steinberg-cc121': { maker: 'Steinberg', model: 'CC121', type: 'oth', midi: 'Y' },
  'steinberg-midex-8': { maker: 'Steinberg', model: 'MIDEX-8', type: 'if', midi: 'Y' },
  'synthaxe-synthaxe': { maker: 'SynthAxe', model: 'SynthAxe', type: 'oth', midi: 'Y' },
  'synthstrom-deluge': { maker: 'Synthstrom', model: 'Deluge', type: 'seq', midi: 'Y' },
  'tascam-2488': { maker: 'Tascam', model: '2488', type: 'rec', midi: 'Y' },
  'tascam-dm-24': { maker: 'Tascam', model: 'DM-24', type: 'mix', midi: 'Y' },
  'tascam-mx-2424': { maker: 'Tascam', model: 'MX-2424', type: 'rec', midi: 'Y' },
  'tascam-us-428': { maker: 'Tascam', model: 'US-428', type: 'oth', midi: 'Y' },
  'tc-electronic-g-major': { maker: 'TC Electronic', model: 'G-Major', type: 'gtr', midi: 'Y' },
  'tc-electronic-g-natural': { maker: 'TC Electronic', model: 'G-Natural', type: 'gtr', midi: 'Y' },
  'tc-electronic-g-sharp': { maker: 'TC Electronic', model: 'G-Sharp', type: 'gtr', midi: 'Y' },
  'tc-electronic-g-system': { maker: 'TC Electronic', model: 'G-System', type: 'gtr', midi: 'Y' },
  'tc-electronic-nova-system': { maker: 'TC Electronic', model: 'Nova System', type: 'gtr', midi: 'Y' },
  'tc-electronic-reverb-4000': { maker: 'TC Electronic', model: 'Reverb 4000', type: 'fx', midi: 'Y' },
  'tc-electronic-system-6000': { maker: 'TC Electronic', model: 'System 6000', type: 'fx', midi: 'Y' },
  'teenage-engineering-op-1': { maker: 'Teenage Engineering', model: 'OP-1', type: 'syn', midi: 'Y' },
  'tubbutec-retrofit-midi-kits': { maker: 'Tubbutec', model: 'Retrofit MIDI kits', type: 'oth', midi: 'Y' },
  'turtle-beach-maui': { maker: 'Turtle Beach', model: 'Maui', type: 'cpu', midi: 'Y' },
  'udo-super-6': { maker: 'UDO', model: 'Super 6', type: 'syn', midi: 'Y' },
  'udo-super-gemini': { maker: 'UDO', model: 'Super Gemini', type: 'syn', midi: 'Y' },
  'waldorf-blofeld': { maker: 'Waldorf', model: 'Blofeld', type: 'syn', midi: 'Y' },
  'waldorf-kyra': { maker: 'Waldorf', model: 'Kyra', type: 'syn', midi: 'Y' },
  'waldorf-q': { maker: 'Waldorf', model: 'Q', type: 'syn', midi: 'Y' },
  'waldorf-rackattack': { maker: 'Waldorf', model: 'RackAttack', type: 'drm', midi: 'Y' },
  'waldorf-streichfett': { maker: 'Waldorf', model: 'Streichfett', type: 'syn', midi: 'Y' },
  'waldorf-stvc': { maker: 'Waldorf', model: 'STVC', type: 'syn', midi: 'Y' },
  'waldorf-wave': { maker: 'Waldorf', model: 'Wave', type: 'syn', midi: 'Y' },
  'yamaha-01v96': { maker: 'Yamaha', model: '01V96', type: 'mix', midi: 'Y' },
  'yamaha-02r96': { maker: 'Yamaha', model: '02R96', type: 'mix', midi: 'Y' },
  'yamaha-aw1600': { maker: 'Yamaha', model: 'AW1600', type: 'rec', midi: 'Y' },
  'yamaha-aw2400': { maker: 'Yamaha', model: 'AW2400', type: 'rec', midi: 'Y' },
  'yamaha-aw2816': { maker: 'Yamaha', model: 'AW2816', type: 'rec', midi: 'Y' },
  'yamaha-aw4416': { maker: 'Yamaha', model: 'AW4416', type: 'rec', midi: 'Y' },
  'yamaha-ck61': { maker: 'Yamaha', model: 'CK61', type: 'syn', midi: 'Y' },
  'yamaha-db50xg': { maker: 'Yamaha', model: 'DB50XG', type: 'data', midi: 'Y' },
  'yamaha-db60xg': { maker: 'Yamaha', model: 'DB60XG', type: 'data', midi: 'Y' },
  'yamaha-dm1000': { maker: 'Yamaha', model: 'DM1000', type: 'mix', midi: 'Y' },
  'yamaha-dm2000': { maker: 'Yamaha', model: 'DM2000', type: 'mix', midi: 'Y' },
  'yamaha-dtx-pro': { maker: 'Yamaha', model: 'DTX-PRO', type: 'drm', midi: 'Y' },
  'yamaha-dtx502': { maker: 'Yamaha', model: 'DTX502', type: 'drm', midi: 'Y' },
  'yamaha-dtx900': { maker: 'Yamaha', model: 'DTX900', type: 'drm', midi: 'Y' },
  'yamaha-dx200': { maker: 'Yamaha', model: 'DX200', type: 'drm', midi: 'Y' },
  'yamaha-genos': { maker: 'Yamaha', model: 'Genos', type: 'arr', midi: 'Y' },
  'yamaha-magicstomp': { maker: 'Yamaha', model: 'Magicstomp', type: 'gtr', midi: 'Y' },
  'yamaha-mo6': { maker: 'Yamaha', model: 'MO6', type: 'syn', midi: 'Y' },
  'yamaha-modx': { maker: 'Yamaha', model: 'MODX', type: 'syn', midi: 'Y' },
  'yamaha-montage': { maker: 'Yamaha', model: 'Montage', type: 'syn', midi: 'Y' },
  'yamaha-montage-m': { maker: 'Yamaha', model: 'Montage M', type: 'syn', midi: 'Y' },
  'yamaha-motif-es': { maker: 'Yamaha', model: 'Motif ES', type: 'syn', midi: 'Y' },
  'yamaha-motif-es-rack': { maker: 'Yamaha', model: 'Motif ES Rack', type: 'syn', midi: 'Y' },
  'yamaha-motif-rack-xs': { maker: 'Yamaha', model: 'Motif Rack XS', type: 'syn', midi: 'Y' },
  'yamaha-motif-xf': { maker: 'Yamaha', model: 'Motif XF', type: 'syn', midi: 'Y' },
  'yamaha-motif-xs': { maker: 'Yamaha', model: 'Motif XS', type: 'syn', midi: 'Y' },
  'yamaha-mox6': { maker: 'Yamaha', model: 'MOX6', type: 'syn', midi: 'Y' },
  'yamaha-moxf6': { maker: 'Yamaha', model: 'MOXF6', type: 'syn', midi: 'Y' },
  'yamaha-mu10': { maker: 'Yamaha', model: 'MU10', type: 'syn', midi: 'Y' },
  'yamaha-mu1000': { maker: 'Yamaha', model: 'MU1000', type: 'syn', midi: 'Y' },
  'yamaha-mu15': { maker: 'Yamaha', model: 'MU15', type: 'syn', midi: 'Y' },
  'yamaha-mx49': { maker: 'Yamaha', model: 'MX49', type: 'syn', midi: 'Y' },
  'yamaha-n12': { maker: 'Yamaha', model: 'n12', type: 'mix', midi: 'Y' },
  'yamaha-plg150-an': { maker: 'Yamaha', model: 'PLG150-AN', type: 'data', midi: 'Y' },
  'yamaha-psr-3000': { maker: 'Yamaha', model: 'PSR-3000', type: 'arr', midi: 'Y' },
  'yamaha-psr-9000': { maker: 'Yamaha', model: 'PSR-9000', type: 'arr', midi: 'Y' },
  'yamaha-psr-a5000': { maker: 'Yamaha', model: 'PSR-A5000', type: 'arr', midi: 'Y' },
  'yamaha-psr-s900': { maker: 'Yamaha', model: 'PSR-S900', type: 'arr', midi: 'Y' },
  'yamaha-psr-s950': { maker: 'Yamaha', model: 'PSR-S950', type: 'arr', midi: 'Y' },
  'yamaha-psr-sx900': { maker: 'Yamaha', model: 'PSR-SX900', type: 'arr', midi: 'Y' },
  'yamaha-qs300': { maker: 'Yamaha', model: 'QS300', type: 'syn', midi: 'Y' },
  'yamaha-reface-cs': { maker: 'Yamaha', model: 'reface CS', type: 'syn', midi: 'Y' },
  'yamaha-rs7000': { maker: 'Yamaha', model: 'RS7000', type: 'drm', midi: 'Y' },
  'yamaha-s70-xs': { maker: 'Yamaha', model: 'S70 XS', type: 'syn', midi: 'Y' },
  'yamaha-s90': { maker: 'Yamaha', model: 'S90', type: 'syn', midi: 'Y' },
  'yamaha-s90es': { maker: 'Yamaha', model: 'S90ES', type: 'syn', midi: 'Y' },
  'yamaha-seqtrak': { maker: 'Yamaha', model: 'SEQTRAK', type: 'drm', midi: 'Y' },
  'yamaha-sfg-05': { maker: 'Yamaha', model: 'SFG-05', type: 'data', midi: 'Y' },
  'yamaha-sw1000xg': { maker: 'Yamaha', model: 'SW1000XG', type: 'cpu', midi: 'Y' },
  'yamaha-tg100': { maker: 'Yamaha', model: 'TG100', type: 'syn', midi: 'Y' },
  'yamaha-vl1': { maker: 'Yamaha', model: 'VL1', type: 'syn', midi: 'Y' },
  'yamaha-vl70-m': { maker: 'Yamaha', model: 'VL70-m', type: 'syn', midi: 'Y' },
  'yamaha-yc61': { maker: 'Yamaha', model: 'YC61', type: 'pno', midi: 'Y' },
  'zoom-arq-ar-48': { maker: 'Zoom', model: 'ARQ AR-48', type: 'drm', midi: 'Y' },
  'zoom-g9-2tt': { maker: 'Zoom', model: 'G9.2tt', type: 'gtr', midi: 'Y' },
  'zoom-mrs-1044': { maker: 'Zoom', model: 'MRS-1044', type: 'rec', midi: 'Y' },
  'zoom-r16': { maker: 'Zoom', model: 'R16', type: 'rec', midi: 'Y' },
  // --- end downloads: devices ---
};

/**
 * Corrections to the catalog's `midi` field (Y yes, N no, R some versions, ? unknown, Y? likely).
 * Devices whose MIDI is N (no DIN, no USB-MIDI, no factory MIDI version) are left out of the checklist and their firmware
 * is only counted in the summary, unless a third-party MIDI upgrade (retrofit kit) is named for them: `midiUpgrades` in the
 * catalog entry (js/devices/catalog-data.js) or in NEW_DEVICES. Those are listed, with the upgrade named.
 */
const MIDI_OVERRIDES = {
  // no MIDI (catalog said unknown or "some versions")
  'alesis-microverb2': 'N', // MIDI came with the Microverb III
  'behringer-dcx2496': 'N', // RS-232/RS-485 remote only
  'edp-spider': 'N', // 1981 CV/gate sequencer
  'kawai-sx210': 'N', // the SX-240 has MIDI, the SX-210 does not
  'korg-polysix': 'N', // retrofits only (Kiwisix, Encore)
  'moog-source': 'N', // retrofits only
  'mxr-185': 'N', // retrofits only (HKA Design)
  'oberheim-dsx': 'N', // Oberheim parallel bus only
  'roland-jupiter8': 'N', // retrofits only (Groove, Kenton)
  'yamaha-mk100': 'N', // 1982
  'yamaha-pss12': 'N', 'yamaha-pss102': 'N', 'yamaha-pss390': 'N', // Yamaha Portasound list: no MIDI
  // no MIDI (catalog said yes)
  'oberheim-systemizer': 'N', // Oberheim parallel bus box
  'roland-difat': 'N', // ADAT/TDIF to R-BUS converter
  // MIDI (catalog said unknown)
  'yamaha-pss595': 'Y', 'yamaha-psr36': 'Y', 'yamaha-psr60': 'Y', 'yamaha-psr230': 'Y', // Portasound list / manuals
  // unknown (catalog said no MIDI; tools/firmware/midi_devices.json lists MIDI in/out; not settled)
  'vermona-sk86': '?',
};

/**
 * File-name rules: [regex on the relative path, action]. Tested in order before the catalog.
 * Actions (first one with a decision wins; entries with only `note`/`version` add to whatever matches later):
 *   { id, variant?, note?, version? }        the item is firmware of that device
 *   { ids: [{ id, note? }, ...] }             firmware of several devices (one archive, several units)
 *   { other: 'what it is' }                   not firmware (notes, tools, scratch): listed apart
 *   { recurse: true }                         a folder of separate items: walk into it
 *   { unknown: 'why' }                        list under "Not identified"
 */
const RULES = [
  // Novation OS updates (Novation's own file names; "(1)", "(2)" are repeated downloads of the same file)
  [/^a-station-os(\d+)[^/]*\.zip$/i, { id: 'novation-a-station' }],
  [/^k-station-os(\d+)[^/]*\.zip$/i, { id: 'novation-k-station' }],
  [/^ks-45-rack-os(\d+)[^/]*\.zip$/i, { id: 'novation-ks-rack', note: 'KS4, KS5 and KS Rack' }],
  [/^ks-factory-sounds[^/]*\.zip$/i, { id: 'novation-ks-rack', note: 'factory sounds (SysEx)' }],
  [/^x-station-os(\d+)[^/]*\.zip$/i, { id: 'novation-x-station' }],
  [/^xio-sysex-files[^/]*\.zip$/i, { id: 'novation-xiosynth', note: 'XioSynth SysEx files' }],
  // Not firmware
  [/^_work$/, { other: 'scratch folder of the session that fetched the Korg firmware (can be deleted)' }],
  [/^korg$/, { recurse: true }],
  [/^korg\/(MANIFEST\.md|manifest\.json)$/i, { other: 'list of the Korg downloads: products, versions, URLs, hashes, checks' }],
  [/^korg\/catalog$/i, { other: 'the Korg System Updater product catalog, as fetched' }],
  [/^korg\/tools$/i, { other: 'scripts that fetched and checked the Korg downloads (`korg_system_updater_fetch.py`, `inno_extract_files.py`)' }],
  [/(^|\/)Korg_System_Updater/i, { other: 'Korg System Updater installer (Windows): the tool that installs the Korg packages in `korg/`' }],
  [/(^|\/)(Thumbs\.db|desktop\.ini|\.DS_Store)$/i, { other: 'system file' }],
  [/^DOWNLOADS\.md$/, { other: 'summary of the official downloads in the maker folders (files, sizes, manifests)' }],
  [/^[^/]+\/(MANIFEST|MANIFEST_WEB)\.md$/, { other: 'list of the downloads in this maker folder: versions, sizes, SHA-256, source URLs; devices checked without a public download' }],

  // Official downloads: one folder per device (or per shared update package)
  // --- downloads: folders (generated) ---
  [/^1010music\/Blackbox$/, { id: '1010music-blackbox', version: 'v3.1.9' }],
  [/^1010music\/Bluebox$/, { id: '1010music-bluebox', version: 'v1.5.2' }],
  [/^1010music\/Lemondrop$/, { id: '1010music-lemondrop', version: 'v1228, Nanobox Fireball 1225, Nanobox Razzmatazz 1216, Nanobox Tangerine 1228' }],
  [/^Akai\/EWI Solo$/, { id: 'akai-ewi4000s', version: 'fw 1.24 (EWI Solo app 1.2, Windows)' }],
  [/^Akai\/EWI4000s$/, { id: 'akai-ewi4000s', version: 'v2.4, v2.3' }],
  [/^Akai\/EWI5000$/, { id: 'akai-ewi4000s', version: 'v1546 (EWI5000)' }],
  [/^Akai\/Force$/, { id: 'akai-force', version: 'v3.3.0.0 (standalone .img)' }],
  [/^Akai\/MPC Live$/, { ids: [{ id: 'akai-mpc-live' }, { id: 'akai-mpc-one' }, { id: 'akai-mpc-x' }, { id: 'akai-mpc-key-61' }], version: 'v3.4.2.13 (standalone .img), v2.15.1.1 (standalone .img)' }],
  [/^Akai\/MPC Renaissance$/, { id: 'akai-mpc-renaissance', version: 'v1.10 (Mac update)' }],
  [/^Akai\/MPK mini$/, { id: 'akai-mpk49', version: 'v0.022 (MPK mini mk2), v1.26 (MPK mini mk3, Windows), v1.13 (MPK mini Plus, Windows)' }],
  [/^Akai\/MPK261$/, { id: 'akai-mpk49', version: 'v1.02 (MPK249/MPK261, Mac)' }],
  [/^Akai\/MPX16$/, { id: 'akai-mpx16', version: 'v1.0.19' }],
  [/^Akai\/MPX8$/, { id: 'akai-mpx16', version: 'v1.0.01 (MPX8)' }],
  [/^Alesis\/ADAT HD24$/, { id: 'alesis-adat-hd24', version: 'v1.21, v1.20, v1.18' }],
  [/^Alesis\/Andromeda A6$/, { id: 'alesis-andromeda-a6', version: 'v1.40.12, v1.40.01 (MIDI file), v1.40.01 (SysEx)' }],
  [/^Alesis\/DM10$/, { id: 'alesis-dm10', version: 'v2014-08-05' }],
  [/^Alesis\/Fusion$/, { id: 'alesis-fusion', version: 'v1.24' }],
  [/^Alesis\/Ion$/, { id: 'alesis-ion', version: 'v1.00, v1.02, v1.03, v1.05, v1.06' }],
  [/^Alesis\/Micron$/, { id: 'alesis-micron', version: 'v1.01, v1.02' }],
  [/^Alesis\/Photon X25$/, { id: 'alesis-photon-x25', version: 'v1.04 (USB fix, DFU only, 2007-07-25)' }],
  [/^Alesis\/SamplePad Pro$/, { id: 'alesis-samplepad', version: 'v1.1.00 (SamplePad Pro)' }],
  [/^Alesis\/Strike$/, { id: 'alesis-strike', version: 'v1.5 (Windows)' }],
  [/^Alesis\/Strike MultiPad$/, { id: 'alesis-strike', version: 'v1.1 (Strike MultiPad), v1.2 (Strike MultiPad), v1.3 (Strike MultiPad)' }],
  [/^Alesis\/Vortex$/, { id: 'alesis-vortex', version: 'Vortex Wireless 2 1.1.5 (Windows)' }],
  [/^Arturia\/AstroLab$/, { id: 'arturia-astrolab', version: 'v2.0.0 (AstroLab 37), v2.0.0 (AstroLab 61)' }],
  [/^Arturia\/BeatStep$/, { id: 'arturia-beatstep', version: 'v1.2.0.3' }],
  [/^Arturia\/BeatStep Pro$/, { id: 'arturia-beatstep-pro', version: 'v2.0.1.6' }],
  [/^Arturia\/DrumBrute$/, { id: 'arturia-drumbrute', version: 'v1.2.1.0' }],
  [/^Arturia\/KeyLab$/, { id: 'arturia-keylab', version: 'MkII 1.3.1, Essential 1.1.10' }],
  [/^Arturia\/KeyStep$/, { id: 'arturia-keystep', version: 'v1.0.28' }],
  [/^Arturia\/KeyStep Pro$/, { id: 'arturia-keystep-pro', version: 'v2.5.20' }],
  [/^Arturia\/MatrixBrute$/, { id: 'arturia-matrixbrute', version: 'v2.0.3' }],
  [/^Arturia\/MicroBrute$/, { id: 'arturia-microbrute', version: 'v1.0.4' }],
  [/^Arturia\/MicroFreak$/, { id: 'arturia-microfreak', version: 'v5.0.0' }],
  [/^Arturia\/MiniBrute 2$/, { id: 'arturia-minibrute-2', version: 'v1.0.18' }],
  [/^Arturia\/MiniFreak$/, { id: 'arturia-minifreak', version: 'v5.0.1' }],
  [/^Arturia\/PolyBrute$/, { id: 'arturia-polybrute', version: 'v3.1.1' }],
  [/^ASM\/Hydrasynth$/, { id: 'asm-hydrasynth', version: 'v2.2.0 (Keyboard), v2.2.0 (Desktop), v2.2.0 (Explorer), v2.2.0 (Deluxe)' }],
  [/^ASM\/Leviasynth$/, { id: 'asm-leviasynth', version: 'v1.2.0 (Keyboard), v1.2.0 (Desktop)' }],
  [/^Atari\/520 ST$/, { id: 'atari-520-st', version: 'TOS 1.00 (on disk)' }],
  [/^Atari\/Falcon030$/, { id: 'atari-falcon030', version: 'ROM dump (MAME set falcon30)' }],
  [/^Atari\/TT030$/, { id: 'atari-tt030', version: 'TOS 3.06 (UK), TOS 3.06 (US), TOS 3.06 (DE)' }],
  [/^Behringer\/DeepMind 12$/, { id: 'behringer-deepmind-12', version: 'v1.0.7 (Windows package)' }],
  [/^Behringer\/Model D$/, { id: 'behringer-model-d', version: 'v1.0.5 (updater)' }],
  [/^Behringer\/Neutron$/, { id: 'behringer-neutron', version: 'v2.0.2 (Mac firmware updater), Neutron Setup 1.0.1 (Windows)' }],
  [/^Behringer\/RD-8$/, { id: 'behringer-rd-8', version: 'v1.3.5 (Mac updater)' }],
  [/^Behringer\/SynthTribe$/, { id: 'behringer-crave', version: 'SynthTribe 2.8.5 (Windows)' }],
  [/^Behringer\/Wing$/, { id: 'behringer-wing', version: 'v3.0.4, v3.0 (WING Compact)' }],
  [/^Behringer\/X-Touch$/, { id: 'behringer-x-touch', version: 'v1.22, v1.22 (X-Touch Extender), v1.10 (X-Touch One)' }],
  [/^Behringer\/X32$/, { id: 'behringer-x32', version: 'v4.09, v3.12' }],
  [/^Behringer\/XR18$/, { id: 'behringer-xr18', version: 'v1.20' }],
  [/^Black Corporation\/Deckard's Dream$/, { id: 'black-corporation-deckard-s-dream', version: 'v2.3.0, v1.5.0' }],
  [/^Black Corporation\/Kijimi$/, { id: 'black-corporation-kijimi', version: 'v2.0.0, v1.4.6' }],
  [/^Black Corporation\/Xerxes$/, { id: 'black-corporation-xerxes', version: 'v1.1.1' }],
  [/^Boss\/BR-1180$/, { id: 'boss-br-1180', version: 'v2.01 (for MIDI), v2.01 (for CD-R)' }],
  [/^Boss\/BR-1600CD$/, { id: 'boss-br-1600cd', version: 'v2.20' }],
  [/^Boss\/BR-532$/, { id: 'boss-br-532', version: 'v1.03' }],
  [/^Boss\/BR-800$/, { id: 'boss-br-800', version: 'v1.10' }],
  [/^Boss\/BR-864$/, { id: 'boss-br-864', version: 'v1.01' }],
  [/^Boss\/BR-900CD$/, { id: 'boss-br-900cd', version: 'v2.12' }],
  [/^Boss\/DD-200$/, { id: 'boss-dd-200', version: 'v1.14' }],
  [/^Boss\/DD-500$/, { id: 'boss-dd-500', version: 'v2.03' }],
  [/^Boss\/DR-880$/, { id: 'boss-dr-880', version: 'v2.00' }],
  [/^Boss\/ES-8$/, { id: 'boss-es-8', version: 'v2.05' }],
  [/^Boss\/GT-001$/, { id: 'boss-gt-001', version: 'v1.10' }],
  [/^Boss\/GT-1$/, { id: 'boss-gt-1', version: 'v1.09' }],
  [/^Boss\/GT-10$/, { id: 'boss-gt-10', version: 'v1.02' }],
  [/^Boss\/GT-100$/, { id: 'boss-gt-100', version: 'v2.12' }],
  [/^Boss\/GT-1000$/, { id: 'boss-gt-1000', version: 'v4.02' }],
  [/^Boss\/GX-10$/, { id: 'boss-gx-10', version: 'v1.06' }],
  [/^Boss\/GX-100$/, { id: 'boss-gx-100', version: 'v2.05' }],
  [/^Boss\/Katana$/, { id: 'boss-katana', version: 'v4.00' }],
  [/^Boss\/ME-90$/, { id: 'boss-me-90', version: 'v1.04' }],
  [/^Boss\/MS-3$/, { id: 'boss-ms-3', version: 'v1.21' }],
  [/^Boss\/RC-300$/, { id: 'boss-rc-300', version: 'v1.05' }],
  [/^Boss\/RC-50$/, { id: 'boss-rc-50', version: 'v1.01' }],
  [/^Boss\/RC-505$/, { id: 'boss-rc-505', version: 'v2.01' }],
  [/^Boss\/RC-600$/, { id: 'boss-rc-600', version: 'v1.50' }],
  [/^Boss\/SP-505$/, { id: 'boss-sp-505', version: 'v1.02 (SmartMedia), v1.02 (SMF)' }],
  [/^Boss\/SY-1000$/, { id: 'boss-sy-1000', version: 'v1.20' }],
  [/^Boss\/SY-200$/, { id: 'boss-sy-200', version: 'v1.03' }],
  [/^Boss\/SY-300$/, { id: 'boss-sy-300', version: 'v1.03' }],
  [/^Boss\/VE-500$/, { id: 'boss-ve-500', version: 'v1.10' }],
  [/^Boss\/VG-800$/, { id: 'boss-vg-800', version: 'v1.50' }],
  [/^Casio\/DG-20$/, { id: 'casio-dg-20', version: 'ROM dump (MAME set dg20)' }],
  [/^Casio\/FZ-10M$/, { id: 'casio-fz-10m', version: 'ROM dump (MAME set fz1 with clones fz10m, fz20m)' }],
  [/^Casio\/XW-P1$/, { id: 'casio-xw-p1', version: 'v1.11 (Windows updater)' }],
  [/^Clavia\/Nord Drum$/, { id: 'clavia-nord-drum', version: 'v1.08' }],
  [/^Clavia\/Nord Electro 2$/, { id: 'clavia-nord-electro-2', version: 'v3.04' }],
  [/^Clavia\/Nord Electro 3$/, { id: 'clavia-nord-electro-3', version: 'v3.14, v3.16 (HP)' }],
  [/^Clavia\/Nord Electro 4$/, { id: 'clavia-nord-electro-4', version: 'v1.22' }],
  [/^Clavia\/Nord Electro 5$/, { id: 'clavia-nord-electro-5', version: 'v2.04' }],
  [/^Clavia\/Nord Electro 6$/, { id: 'clavia-nord-electro-6', version: 'v2.66' }],
  [/^Clavia\/Nord Lead 4$/, { id: 'clavia-nord-lead-4', version: 'v1.32' }],
  [/^Clavia\/Nord Lead A1$/, { id: 'clavia-nord-lead-a1', version: 'v1.36' }],
  [/^Clavia\/Nord Modular G2$/, { id: 'clavia-nord-modular-g2', version: 'v1.62' }],
  [/^Clavia\/Nord Stage$/, { id: 'clavia-nord-stage', version: 'v5.08, v6.08 (EX)' }],
  [/^Clavia\/Nord Stage 2$/, { id: 'clavia-nord-stage-2', version: 'v3.00' }],
  [/^Clavia\/Nord Stage 3$/, { id: 'clavia-nord-stage-3', version: 'v2.64' }],
  [/^Clavia\/Nord Stage 4$/, { id: 'clavia-nord-stage-4', version: 'v1.66' }],
  [/^Clavia\/Nord Wave$/, { id: 'clavia-nord-wave', version: 'v2.14' }],
  [/^Clavia\/Nord Wave 2$/, { id: 'clavia-nord-wave-2', version: 'v1.24' }],
  [/^Dirtywave\/M8$/, { id: 'dirtywave-m8', version: 'latest (main branch)' }],
  [/^Dreadbox\/Nymphes$/, { id: 'dreadbox-nymphes', version: 'v2.1' }],
  [/^Dreadbox\/Typhon$/, { id: 'dreadbox-typhon', version: 'v4.2.1 (Windows updater)' }],
  [/^E-mu\/Audity 2000$/, { id: 'emu-audity2000', version: 'OS 2.01' }],
  [/^E-mu\/B-3$/, { id: 'emu-proteus2000', version: 'B-3 OS 1.01' }],
  [/^E-mu\/Command Station$/, { id: 'e-mu-proteus-pk-6', version: 'Command Station OS 2.00 (XL-7, MP-7, PX-7, Proteus 2500), CommandPrep 1.0 (prepares a Command Station for OS 2.x), CommandPrep 1.0 read-me' }],
  [/^E-mu\/Emulator IV$/, { id: 'e-mu-emulator-iv', version: 'EOS 4.61, EOS 4.10 (Ultra), EOS 4.10 (classic), EOS 4.01, FlashPrep, EOS files (HFE and IMG disk images), EOS 3.0b (non-Ultra, HFE and EXE), EOS 2.8 (classic)' }],
  [/^E-mu\/Proteus 2000$/, { id: 'emu-proteus2000', version: 'OS 1.11, Proteus family OS 2.26 (64-voice: Proteus 1000, B-3, Mo\'Phatt, Planet Earth, Xtreme Lead-1)' }],
  [/^E-mu\/Vintage Pro$/, { id: 'e-mu-proteus-pk-6', version: 'Proteus family OS 2.26 (128-voice: Proteus 2000, Vintage Pro, Virtuoso, Orbit 3, Turbo models)' }],
  [/^Edirol\/PCR-300$/, { id: 'edirol-pcr-300', version: 'v1.05 (PCR-300/500/800)' }],
  [/^Electro-Harmonix\/45000$/, { id: 'electro-harmonix-45000', version: 'update 24' }],
  [/^Elektron\/Analog Four$/, { id: 'elektron-analog-four', version: 'MKII 1.56, MKI/Keys 1.56' }],
  [/^Elektron\/Analog Heat$/, { id: 'elektron-analog-heat', version: 'MKII 1.22, MKI 1.22' }],
  [/^Elektron\/Analog Rytm$/, { id: 'elektron-analog-rytm', version: 'MKII 1.74, MKI 1.74' }],
  [/^Elektron\/Digitakt$/, { id: 'elektron-digitakt', version: 'v1.54' }],
  [/^Elektron\/Digitone$/, { id: 'elektron-digitone', version: 'v1.44' }],
  [/^Elektron\/Machinedrum$/, { id: 'elektron-machinedrum', version: 'v1.63 (UW)' }],
  [/^Elektron\/Model_Cycles$/, { id: 'elektron-model-cycles', version: 'v1.13' }],
  [/^Elektron\/Model_Samples$/, { id: 'elektron-model-samples', version: 'v1.13' }],
  [/^Elektron\/Monomachine$/, { id: 'elektron-monomachine', version: 'v1.32B' }],
  [/^Elektron\/Octatrack$/, { id: 'elektron-octatrack', version: 'v1.40C' }],
  [/^Elektron\/Syntakt$/, { id: 'elektron-syntakt', version: 'v1.42' }],
  [/^Elektron\/Tonverk$/, { id: 'elektron-tonverk', version: 'v1.5.0' }],
  [/^Encore Electronics\/JP8MK$/, { ids: [{ id: 'roland-jupiter8' }, { id: 'encore-electronics-retrofit-midi-kits' }], version: 'final (EPROM)' }],
  [/^Encore Electronics\/OB8MK$/, { ids: [{ id: 'oberheim-ob8' }, { id: 'encore-electronics-retrofit-midi-kits' }], version: 'v2 (EPROM)' }],
  [/^Encore Electronics\/OBXA-MK$/, { ids: [{ id: 'oberheim-obxa' }, { id: 'encore-electronics-retrofit-midi-kits' }], version: 'v2014 (flash, MIDI file), v2014 (flash, MIDI file, Z80 RAM80 processor)' }],
  [/^Encore Electronics\/SMK$/, { ids: [{ id: 'moog-source' }, { id: 'encore-electronics-retrofit-midi-kits' }], version: 'v4.11' }],
  [/^Ensoniq\/ASR-10 OS$/, { ids: [{ id: 'ensoniq-asr10' }, { id: 'ensoniq-asr-88' }], version: 'OS 3.53 (disk image), OS 1.61 (disk image), OS 3.53 (EFA file), OS 1.61 (EFA file), OS 3.53 (E-mu download)' }],
  [/^Ensoniq\/ASR-X$/, { id: 'ensoniq-asrx', version: 'ASR-X Pro OS 3.04' }],
  [/^Ensoniq\/EPS$/, { id: 'ensoniq-eps', version: 'OS 2.49 (disk)' }],
  [/^Ensoniq\/EPS-16 Plus$/, { id: 'ensoniq-eps16plus', version: 'OS disk (E-mu download)' }],
  [/^Erica Synths\/Bassline DB-01$/, { id: 'erica-synths-bassline-db-01', version: 'v1.10' }],
  [/^Erica Synths\/LXR-02$/, { id: 'erica-synths-lxr-02', version: 'v1.6.1' }],
  [/^Erica Synths\/Perkons HD-01$/, { id: 'erica-synths-perkons-hd-01', version: 'v1.3.0' }],
  [/^Erica Synths\/Syntrx II$/, { id: 'erica-synths-syntrx-ii', version: 'v1.05' }],
  [/^Eventide\/Eclipse$/, { id: 'eventide-eclipse', version: 'v4.01 (Mac/Win), v3.51 (Mac/Win), bootloader 1.21 (Windows)' }],
  [/^Eventide\/H7600$/, { id: 'eventide-h7600', version: 'v5.611 (card, Mac/Win), v5.22 (Windows)' }],
  [/^Eventide\/H8000$/, { id: 'eventide-h8000', version: 'v5.61 (CF card, Mac/Win), v5.6 (H8000/H8000A, Windows web updater)' }],
  [/^Eventide\/H9000$/, { id: 'eventide-h9000', version: 'v2.4.8.150 (Gen1 USB installer), v3.2.4.154 (Gen2 USB installer), Dante I/O card 19.1.31.1' }],
  [/^Eventide\/TimeFactor$/, { ids: [{ id: 'eventide-timefactor' }, { id: 'eventide-h9' }], version: 'Eventide Direct Updater 2.1.0 (Windows)' }],
  [/^Fractal Audio\/AX8$/, { id: 'fractal-audio-ax8', version: 'v10.01' }],
  [/^Fractal Audio\/Axe-Fx II$/, { id: 'fractal-audio-axe-fx-ii', version: 'Ares 2.00 (Mk I/II), Ares 2.00 (XL), Ares 2.00 (XL+), Quantum 10.01 (Mk I/II), Quantum 10.01 (XL), Quantum 10.01 (XL+)' }],
  [/^Fractal Audio\/Axe-Fx III$/, { id: 'fractal-audio-axe-fx-iii', version: 'DSP 33.01, USB 1.19' }],
  [/^Fractal Audio\/FM3$/, { id: 'fractal-audio-fm3', version: 'v13.0' }],
  [/^Fractal Audio\/MFC-101$/, { id: 'fractal-audio-mfc-101', version: 'v3.08' }],
  [/^GEM\/S2R Turbo$/, { id: 'gem-s2', version: 'S2R Turbo expansion ROM S2R-17 (dump), S2R Turbo expansion ROM S2R-18 (dump), S2R Turbo expansion ROM S2R-19 (dump), S2R Turbo expansion ROM S2R-20 (dump)' }],
  [/^GEM\/WK2$/, { id: 'gem-wk4', version: 'WK2 HD OS 1999-05-05, WK2 HD MA OS 1999-05-05' }],
  [/^GEM\/WK8$/, { id: 'gem-wk4', version: 'WK8 LE OS 2003-09-18' }],
  [/^genoQs\/Octopus$/, { id: 'genoqs-octopus', version: 'v5.30, v5.00, v5.30 (Nemo), v5.00 (Nemo)' }],
  [/^Haken Audio\/Continuum$/, { id: 'haken-audio-continuum', version: 'v10.81' }],
  [/^Headrush\/Gigboard$/, { id: 'headrush-pedalboard', version: 'v2.7 (Gigboard)' }],
  [/^Headrush\/MX5$/, { id: 'headrush-pedalboard', version: 'v2.7 (MX5)' }],
  [/^Headrush\/Pedalboard$/, { id: 'headrush-pedalboard', version: 'v2.7' }],
  [/^Headrush\/Prime$/, { id: 'headrush-pedalboard', version: 'v5.2.0 (Prime)' }],
  [/^IK Multimedia\/UNO Synth$/, { id: 'ik-multimedia-uno-synth', version: 'v1.1.4 (Windows updater)' }],
  [/^Jomox\/AirBase 99$/, { id: 'jomox-airbase99', version: 'hex binaries (support page, 2017-11-01), AB99all.zip (support page)' }],
  [/^Jomox\/Alpha Base$/, { id: 'jomox-alpha-base', version: 'current OS (SD-card file; newest readme on the site is 1.47), current Mk II OS (SD-card file), current Mk II panel-board CPU OS' }],
  [/^Jomox\/MoonWind$/, { id: 'jomox-moonwind', version: 'v1.11, v1.09, v1.06, v1.12 (MoonWind MkII), v1.08 (MoonWind MkII)' }],
  [/^Jomox\/Resonator Neuronium$/, { id: 'jomox-resonator-neuronium', version: 'v2.01 (RESOS), v1.07 (RESOS)' }],
  [/^Jomox\/Sunsyn$/, { id: 'jomox-sunsyn', version: 'v2.02, v1.23' }],
  [/^Jomox\/XBase 888$/, { id: 'jomox-xbase-888', version: 'v1.13, v1.12, v1.12 (X999_888)' }],
  [/^Jomox\/XBase 999$/, { id: 'jomox-xbase-999', version: 'v1.45, v1.44' }],
  [/^Kawai\/K5000R$/, { id: 'kawai-k5000', version: 'v4.04 (K5000R), v4.03 (K5000R), v4.00 (K5000R), v3.01 (K5000R), v3.00 (K5000R), v4.0 supplement (K5000R)' }],
  [/^Kawai\/K5000S$/, { id: 'kawai-k5000', version: 'v4.04 (K5000S), v4.03 (K5000S), v4.01 (K5000S), v3.00 (K5000S), v4.0 supplement (K5000S)' }],
  [/^Kawai\/K5000W$/, { id: 'kawai-k5000', version: 'v4.03 (K5000W), v4.00 (K5000W), v3.10 (K5000W), v3.00 (K5000W), v4.0 supplement (K5000W)' }],
  [/^Ketron\/Event$/, { id: 'ketron-sd90', version: 'v1.1.0 (Event)' }],
  [/^korg\/CX-3$/, { id: 'korg-cx-3-2008', version: 'v2.00' }],
  [/^korg\/D1200$/, { id: 'korg-d1200', version: 'v1.03 (mkII, CD-R update, Windows), v1.03 (mkII, USB update, Windows)' }],
  [/^korg\/D1600$/, { id: 'korg-d1600', version: 'v2.14' }],
  [/^korg\/drumlogue$/, { id: 'korg-drumlogue', version: 'v1.3.0' }],
  [/^korg\/electribe 2$/, { id: 'korg-electribe-2', version: 'v2.02' }],
  [/^korg\/Electribe EMX-1$/, { id: 'korg-electribe-emx-1', version: 'v1.02' }],
  [/^korg\/Electribe ESX-1$/, { id: 'korg-electribe-esx-1', version: 'v1.02' }],
  [/^korg\/i3$/, { id: 'korg-i3-2020', version: 'v1.6' }],
  [/^korg\/Kaoss Pad KP3$/, { id: 'korg-kaoss-pad-kp3', version: 'KP3+ 1.04' }],
  [/^korg\/Kaossilator Pro$/, { id: 'korg-kaossilator-pro', version: 'Pro+ 1.04, v1.02' }],
  [/^korg\/Karma$/, { id: 'korg-karma', version: 'v2.0.0' }],
  [/^korg\/Kingkorg$/, { id: 'korg-kingkorg', version: 'v1.13' }],
  [/^korg\/KONTROL49$/, { id: 'korg-microkontrol', version: 'v1.06 (KONTROL49, Windows)' }],
  [/^korg\/Krome$/, { id: 'korg-krome', version: 'v1.0.4' }],
  [/^korg\/Kronos$/, { id: 'korg-kronos', version: 'v3.2.3' }],
  [/^korg\/M3$/, { id: 'korg-m3', version: 'v2.00 (XPanded upgrade), v2.0.5 (XPanded), EXB-RADIAS 2.0' }],
  [/^korg\/M50$/, { id: 'korg-m50', version: 'v1.10 (61/73), v1.10 (88)' }],
  [/^korg\/microKEY Air$/, { id: 'korg-microkey', version: 'v1.06 (microKEY Air 37/49/61, Windows), v1.06 (microKEY Air 25, Windows)' }],
  [/^korg\/microKONTROL$/, { id: 'korg-microkontrol', version: 'v1.03 (Windows)' }],
  [/^korg\/microKORG 2$/, { id: 'korg-microkorg-2', version: 'v2.0.2' }],
  [/^korg\/microKORG XL$/, { id: 'korg-microkorg-xl', version: 'v1.04' }],
  [/^korg\/MicroX$/, { id: 'korg-microx', version: 'v1.05' }],
  [/^korg\/minilogue$/, { id: 'korg-minilogue', version: 'v2.01' }],
  [/^korg\/monologue$/, { id: 'korg-monologue', version: 'v2.00' }],
  [/^korg\/MS2000$/, { id: 'korg-ms2000', version: 'full firmware (as uploaded), OS 1.05' }],
  [/^korg\/nanoKEY Studio$/, { id: 'korg-nanokontrol', version: 'v1.08 (nanoKEY Studio, Windows)' }],
  [/^korg\/nanoKEY2$/, { id: 'korg-nanokontrol', version: 'v1.0.3 (nanoKEY2, Windows)' }],
  [/^korg\/nanoKONTROL Studio$/, { id: 'korg-nanokontrol', version: 'v1.05 (nanoKONTROL Studio, Windows)' }],
  [/^korg\/nanoKONTROL2$/, { id: 'korg-nanokontrol', version: 'v1.0.3 (nanoKONTROL2, Windows)' }],
  [/^korg\/nanoPAD2$/, { id: 'korg-nanokontrol', version: 'v1.0.4 (nanoPAD2, Windows)' }],
  [/^korg\/Nautilus$/, { id: 'korg-nautilus', version: 'Sub-System firmware 1.10' }],
  [/^korg\/nts-1$/, { id: 'korg-nts-1', version: 'v1.20' }],
  [/^korg\/OASYS$/, { id: 'korg-oasys', version: 'v1.11' }],
  [/^korg\/Pa1X$/, { id: 'korg-pa1x', version: 'v3.01' }],
  [/^korg\/Pa300$/, { id: 'korg-pa300', version: 'v2.1.1' }],
  [/^korg\/Pa3X$/, { id: 'korg-pa3x', version: 'v1.63' }],
  [/^korg\/Pa4X$/, { id: 'korg-pa4x', version: 'v3.1.0' }],
  [/^korg\/Pa500$/, { id: 'korg-pa500', version: 'v1.19' }],
  [/^korg\/Pa5X$/, { id: 'korg-pa5x', version: 'v1.5.0' }],
  [/^korg\/Pa700$/, { id: 'korg-pa700', version: 'v1.5.1' }],
  [/^korg\/Pa80$/, { id: 'korg-pa80', version: 'v3.06' }],
  [/^korg\/Pa800$/, { id: 'korg-pa800', version: 'v2.03' }],
  [/^korg\/Pa900$/, { id: 'korg-pa900', version: 'v1.3.0' }],
  [/^korg\/phase8$/, { id: 'korg-phase8', version: 'v1.3' }],
  [/^korg\/prologue$/, { id: 'korg-prologue', version: 'v2.10' }],
  [/^korg\/Radias$/, { id: 'korg-radias', version: 'v2.00' }],
  [/^korg\/RK-100S$/, { id: 'korg-rk-100s', version: 'v1.0.2' }],
  [/^korg\/SQ-64$/, { id: 'korg-sq-64', version: 'v2.03' }],
  [/^korg\/SV-1$/, { id: 'korg-sv-1', version: 'v1.3' }],
  [/^korg\/SV-2$/, { id: 'korg-sv-2', version: 'v1.0.3' }],
  [/^korg\/TR$/, { id: 'korg-tr', version: 'v1.04' }],
  [/^korg\/Trinity$/, { id: 'korg-trinity', version: 'v2.41, V3 3.11, boot (korg.co.jp)' }],
  [/^korg\/Triton$/, { id: 'korg-triton-os', version: 'v2.5.3' }],
  [/^korg\/Triton Extreme$/, { id: 'korg-triton-extreme', version: 'v1.06' }],
  [/^korg\/Triton Le$/, { id: 'korg-triton-le', version: 'v1.51' }],
  [/^korg\/Triton Rack$/, { id: 'korg-triton-rack', version: 'v1.52' }],
  [/^korg\/Triton Studio$/, { id: 'korg-triton-studio', version: 'v2.02e' }],
  [/^korg\/volca drum$/, { id: 'korg-volca-drum', version: 'v1.14' }],
  [/^korg\/volca FM$/, { id: 'korg-volca-fm', version: 'v1.07' }],
  [/^korg\/volca modular$/, { id: 'korg-volca-modular', version: 'v1.08' }],
  [/^korg\/volca nubass$/, { id: 'korg-volca-nubass', version: 'v1.07' }],
  [/^korg\/volca sample$/, { id: 'korg-volca-sample', version: 'v1.42' }],
  [/^Kurzweil\/K2088$/, { id: 'kurzweil-k2088', version: 'v1.07' }],
  [/^Kurzweil\/K2600$/, { id: 'kurzweil-k2600', version: 'v4.11, v3.x compatibility files, base objects 4.04' }],
  [/^Kurzweil\/K2661$/, { id: 'kurzweil-k2661', version: 'v1.00' }],
  [/^Kurzweil\/K2700$/, { id: 'kurzweil-k2700', version: 'v2.01' }],
  [/^Kurzweil\/KSP8$/, { id: 'kurzweil-ksp8', version: 'v1.90 (MIDI file), v1.90 (SmartMedia card), v1.81 (MIDI file), v1.81 (SmartMedia card), v1.50 (MIDI file), v1.50 (SmartMedia card), objects 1.50 (MIDI file), objects 1.50 (SmartMedia card), mLAN2 updater' }],
  [/^Kurzweil\/PC1X$/, { id: 'kurzweil-pc1x', version: 'v2.02 (combined update)' }],
  [/^Kurzweil\/PC2$/, { id: 'kurzweil-pc2', version: 'boot loader 2.00, v4.00 (PC2 Orchestral OS), v4.00 (PC2X OS), v4.00 (Polyphony Expansion PCX-1 OS)' }],
  [/^Kurzweil\/PC3$/, { ids: [{ id: 'kurzweil-pc3' }, { id: 'kurzweil-pc361' }], version: 'v2.21' }],
  [/^Kurzweil\/PC4$/, { id: 'kurzweil-pc4', version: 'v2.00' }],
  [/^Lexicon\/MX200$/, { id: 'lexicon-mx200', version: 'MX NetUpdater 1.0 (Windows)' }],
  [/^Lexicon\/PCM96$/, { id: 'lexicon-pcm96', version: 'PCM Control and Plug-in 3.5.3.6 (Mac)' }],
  [/^Linn\/AdrenaLinn$/, { id: 'linn-adrenalinn', version: 'v3.0.3 (AdrenaLinn III)' }],
  [/^Linn\/LinnStrument$/, { id: 'linn-linnstrument', version: 'v2.3.4' }],
  [/^M-Audio\/Hammer 88$/, { id: 'm-audio-hammer-88', version: 'firmware updater (Windows)' }],
  [/^M-Audio\/Hammer 88 Pro$/, { id: 'm-audio-hammer-88', version: 'v2.1.3 (Hammer 88 Pro, Windows)' }],
  [/^M-Audio\/Oxygen 49$/, { id: 'm-audio-oxygen-8', version: 'updater 1.0.1 (Oxygen 49)' }],
  [/^M-Audio\/Oxygen 61$/, { id: 'm-audio-oxygen-8', version: 'updater 1.0.1 (Oxygen 61)' }],
  [/^M-Audio\/Oxygen MKV$/, { id: 'm-audio-oxygen-8', version: 'v0.50 (Oxygen 25 MKV, Windows)' }],
  [/^M-Audio\/Oxygen Pro$/, { id: 'm-audio-oxygen-8', version: 'v2.1.2 (Oxygen Pro 25, Windows), v2.1.2 (Oxygen Pro 49, Windows), v2.15 (Oxygen Pro Mini, Windows)' }],
  [/^Manikin\/Memotron$/, { id: 'manikin-memotron', version: 'v1.3 (keyboard)' }],
  [/^Manikin\/Schrittmacher$/, { id: 'manikin-schrittmacher', version: 'v1.0d' }],
  [/^Melbourne Instruments\/Nina$/, { id: 'melbourne-instruments-nina', version: 'v3.3.0' }],
  [/^MFB\/Tanzbär$/, { id: 'mfb-tanzbar', version: 'Tanzbär Lite update (2016)' }],
  [/^MFB\/Tanzmaus$/, { id: 'mfb-tanzmaus', version: 'update (2020 capture)' }],
  [/^Midiman\/MIDISPORT 2x2$/, { id: 'midiman-midisport-2x2', version: 'midisport-firmware 1.2 (Linux fxload images)' }],
  [/^Moog\/Grandmother$/, { id: 'moog-grandmother', version: 'v1.1.3 (SysEx), v1.1.3 update instructions' }],
  [/^Moog\/Little Phatty$/, { id: 'moog-little-phatty', version: 'v3.12.680 (Stage/Stage II), v3.12.680 (Tribute)' }],
  [/^Moog\/Minitaur$/, { id: 'moog-minitaur', version: 'v2.1' }],
  [/^Moog\/Sub 37$/, { id: 'moog-sub-37', version: 'v1.0.6' }],
  [/^Moog\/Sub Phatty$/, { id: 'moog-sub-phatty', version: 'v2' }],
  [/^Moog\/Taurus 3$/, { id: 'moog-taurus-3', version: 'v2.0.2' }],
  [/^Music Quest\/PC MIDI Card$/, { id: 'music-quest-pc-midi-card', version: 'ROM dump (MAME set isa_pcmidi)' }],
  [/^Mutable Instruments\/Ambika$/, { id: 'mutable-instruments-ambika', version: 'controller, voice card' }],
  [/^Mutable Instruments\/Shruthi-1$/, { id: 'mutable-instruments-shruthi-1', version: 'v1.02' }],
  [/^Nonlinear Labs\/C15$/, { id: 'nonlinear-labs-c15', version: 'v26.34.01' }],
  [/^Novation\/Bass Station II$/, { id: 'novation-bass-station-ii', version: 'Librarian and Firmware Updater 1.2 (firmware r554, Windows)' }],
  [/^Novation\/Launch Control XL$/, { id: 'novation-launch-control-xl', version: 'Launch Control XL updater 1.2 (Mac only), Launch Control updater 1.0 (Mac only)' }],
  [/^Novation\/Launchkey$/, { id: 'novation-launchkey', version: 'Launchkey MK2 updater 1.0 (Windows), Launchkey Mini (mk1) InControl updater 1.1 (Windows)' }],
  [/^Novation\/Launchpad$/, { id: 'novation-launchpad', version: 'Launchpad Pro updater 1.2 (Windows), Launchpad MK2 updater (Windows)' }],
  [/^Novation\/UltraNova$/, { id: 'novation-ultranova', version: 'v1.4 (Windows installer with the firmware update)' }],
  [/^Oberheim\/OB-6$/, { id: 'oberheim-ob-6', version: 'v1.8.0' }],
  [/^Oberheim\/OB-X8$/, { id: 'oberheim-ob-x8', version: 'v2.0.0.1, v1.0.0.2' }],
  [/^Oberheim\/Teo-5$/, { id: 'oberheim-teo-5', version: 'v1.1.0.4' }],
  [/^Polyend\/Medusa$/, { id: 'polyend-medusa', version: 'v4.0.1' }],
  [/^Polyend\/Play$/, { id: 'polyend-play', version: 'v1.6.0, v1.3.0 (Play+)' }],
  [/^Polyend\/Seq$/, { id: 'polyend-seq', version: 'v2.2.6' }],
  [/^Polyend\/Synth$/, { id: 'polyend-synth', version: 'v2.0.1' }],
  [/^Polyend\/Tracker$/, { id: 'polyend-tracker', version: 'v1.9.2, v1.2.0 (Tracker+), v2.2.1 (Tracker Mini)' }],
  [/^Radikal Technologies\/Accelerator$/, { id: 'radikal-technologies-accelerator', version: 'v1.91b, bootloader 1.54' }],
  [/^Radikal Technologies\/Spectralis$/, { id: 'radikal-technologies-spectralis', version: 'v1.71 (Spectralis 2)' }],
  [/^RJM\/Mastermind GT$/, { id: 'rjm-mastermind-gt', version: 'v3.00' }],
  [/^RJM\/Mastermind PBC$/, { id: 'rjm-mastermind-gt', version: 'v1.05 (PBC)' }],
  [/^Roland\/A-49$/, { id: 'roland-a-49', version: 'v1.40' }],
  [/^Roland\/AE-10$/, { id: 'roland-aerophone-ae-10', version: 'v3.12' }],
  [/^Roland\/AE-30$/, { id: 'roland-aerophone-ae-30', version: 'v3.20' }],
  [/^Roland\/AX-Edge$/, { id: 'roland-ax-edge', version: 'v1.11' }],
  [/^Roland\/BK-5$/, { id: 'roland-bk-5', version: 'v1.05' }],
  [/^Roland\/CM-32P$/, { id: 'roland-cm-32p', version: 'ROM dump (MAME set cm32p)' }],
  [/^Roland\/D-05$/, { id: 'roland-d-05', version: 'v1.07' }],
  [/^Roland\/E-A7$/, { id: 'roland-e-a7', version: 'v2.02' }],
  [/^Roland\/E-X50$/, { id: 'roland-e-x50', version: 'v1.0.9' }],
  [/^Roland\/FANTOM-06, 07, 08$/, { id: 'roland-fantom-0', version: 'v1.50' }],
  [/^Roland\/FANTOM-6, 7, 8$/, { id: 'roland-fantom-2019', version: 'v3.02' }],
  [/^Roland\/Fantom-G$/, { id: 'roland-fantom-g', version: 'v1.50' }],
  [/^Roland\/Fantom-S$/, { id: 'roland-fantom-s', version: 'v1.09' }],
  [/^Roland\/Fantom-X$/, { id: 'roland-fantom-x', version: 'v2.10, XR 2.02, XA 1.05' }],
  [/^Roland\/FC-300$/, { id: 'roland-fc-300', version: 'v1.02' }],
  [/^Roland\/FR-8x$/, { id: 'roland-v-accordion-fr-8x', version: 'v2.53' }],
  [/^Roland\/G-70$/, { id: 'roland-g-70', version: 'v2.02' }],
  [/^Roland\/GAIA 2$/, { id: 'roland-gaia-2', version: 'v1.12' }],
  [/^Roland\/GAIA SH-01$/, { id: 'roland-gaia-sh-01', version: 'v1.04' }],
  [/^Roland\/GR-20$/, { id: 'roland-gr-20', version: 'v2.00' }],
  [/^Roland\/GR-55$/, { id: 'roland-gr-55', version: 'v1.50' }],
  [/^Roland\/HPD-20$/, { id: 'roland-handsonic-hpd-20', version: 'v1.04' }],
  [/^Roland\/Integra-7$/, { id: 'roland-integra-7', version: 'v1.21' }],
  [/^Roland\/J-6$/, { id: 'roland-j-6', version: 'v1.02' }],
  [/^Roland\/JD-08, JX-08$/, { ids: [{ id: 'roland-jd-08' }, { id: 'roland-jx-08' }], version: 'v1.03' }],
  [/^Roland\/JD-XA$/, { id: 'roland-jd-xa', version: 'v1.55' }],
  [/^Roland\/JD-Xi$/, { id: 'roland-jd-xi', version: 'v1.52' }],
  [/^Roland\/JP-08, JU-06, JX-03$/, { ids: [{ id: 'roland-jp-08' }, { id: 'roland-ju-06' }, { id: 'roland-jx-03' }], version: 'v1.21' }],
  [/^Roland\/Juno-D$/, { id: 'roland-juno-d', version: 'v1.04 (non-LE)' }],
  [/^Roland\/Juno-D6$/, { id: 'roland-juno-d6', version: 'v1.20' }],
  [/^Roland\/Juno-Di$/, { id: 'roland-juno-di', version: 'v1.12' }],
  [/^Roland\/Juno-DS$/, { id: 'roland-juno-ds', version: 'v2.11' }],
  [/^Roland\/Juno-G$/, { id: 'roland-juno-g', version: 'v2.0' }],
  [/^Roland\/Juno-Gi$/, { id: 'roland-juno-gi', version: 'v1.11' }],
  [/^Roland\/Juno-Stage$/, { id: 'roland-juno-stage', version: 'v1.05' }],
  [/^Roland\/Juno-X$/, { id: 'roland-juno-x', version: 'v1.12' }],
  [/^Roland\/Jupiter-50$/, { id: 'roland-jupiter-50', version: 'v1.11' }],
  [/^Roland\/Jupiter-80$/, { id: 'roland-jupiter-80', version: 'v2.11' }],
  [/^Roland\/Jupiter-X$/, { id: 'roland-jupiter-x', version: 'v3.03' }],
  [/^Roland\/JV-1010$/, { id: 'roland-jv-1010', version: 'v1.02' }],
  [/^Roland\/Lucina AX-09$/, { id: 'roland-lucina-ax-09', version: 'v1.10' }],
  [/^Roland\/MC-101$/, { id: 'roland-mc-101', version: 'v1.82' }],
  [/^Roland\/MC-500$/, { id: 'roland-mc-500', version: 'MRB-500 Bulk Librarian / System Generator disk, MRD-500 Rhythm Bank disk, MRM SMF Converter disk, disk flux dumps' }],
  [/^Roland\/MC-505$/, { id: 'roland-mc-505', version: 'v1.07 (version-up disk, MIDI files), v1.07 (version-up disk, MIDI file 1/13), v1.07 (version-up disk, MIDI file 2/13), v1.07 (version-up disk, MIDI file 3/13), v1.07 (version-up disk, MIDI file 4/13), v1.07 (version-up disk, MIDI file 5/13), v1.07 (version-up disk, MIDI file 6/13), v1.07 (version-up disk, MIDI file 7/13), v1.07 (version-up disk, MIDI file 8/13), v1.07 (version-up disk, MIDI file 9/13), v1.07 (version-up disk, MIDI file 10/13), v1.07 (version-up disk, MIDI file 11/13), v1.07 (version-up disk, MIDI file 12/13), v1.07 (version-up disk, MIDI file 13/13)' }],
  [/^Roland\/MC-707$/, { id: 'roland-mc-707', version: 'v1.82' }],
  [/^Roland\/MC-808$/, { id: 'roland-mc-808', version: 'v1.03' }],
  [/^Roland\/MC-909$/, { id: 'roland-mc-909', version: 'v1.23' }],
  [/^Roland\/MPU-401$/, { id: 'roland-mpu-401', version: 'ROM dump (MAME set mpu401)' }],
  [/^Roland\/MSQ-700$/, { id: 'roland-msq-700', version: 'ROM dump' }],
  [/^Roland\/MT-100$/, { id: 'roland-mt-100', version: 'ROM dump (MAME set mt100)' }],
  [/^Roland\/MV-1$/, { id: 'roland-mv-1-verselab', version: 'v1.82' }],
  [/^Roland\/MV-30$/, { id: 'roland-mv-30', version: 'EPROM dump' }],
  [/^Roland\/MV-8000$/, { id: 'roland-mv-8000', version: 'v3.54' }],
  [/^Roland\/MV-8800$/, { id: 'roland-mv-8800', version: 'v1.01' }],
  [/^Roland\/MX-1$/, { id: 'roland-mx-1', version: 'v1.05' }],
  [/^Roland\/P-6$/, { id: 'roland-p-6', version: 'v1.02' }],
  [/^Roland\/PR-100$/, { id: 'roland-pr-100', version: 'ROM dump (MAME set pr100)' }],
  [/^Roland\/RSS-10$/, { id: 'roland-rss-10', version: 'v1.0.1 (EPROM a), v1.0.0 (EPROM b), v1.0.0 (EPROM c)' }],
  [/^Roland\/S-1$/, { id: 'roland-s-1', version: 'v1.02' }],
  [/^Roland\/SBX-1000$/, { id: 'roland-sbx-1000', version: 'system disk' }],
  [/^Roland\/SC-33$/, { id: 'roland-sc-33', version: 'v2.10 ROMs' }],
  [/^Roland\/SC-8820$/, { id: 'roland-sc-8820', version: 'system update (MIDI)' }],
  [/^Roland\/SC-8850$/, { id: 'roland-sc-8850', version: 'ROM dump (R01561945), ROM dump (R01678145), ROM dump (R01783490), wave ROM dump (R01891445), wave ROM dump (R01891456)' }],
  [/^Roland\/SC-88Pro$/, { id: 'roland-sc-88pro', version: 'control ROM 1.02 (dump), wave ROM 0 (dump), wave ROM 1 (dump), wave ROM 2 (dump)' }],
  [/^Roland\/SC-88VL$/, { id: 'roland-sc-88vl', version: 'ROM dump (MAME set sc88vl)' }],
  [/^Roland\/SC-D70$/, { id: 'roland-sc-d70', version: 'system update (MIDI), system update (USB)' }],
  [/^Roland\/SCB-55$/, { id: 'roland-scb-55', version: 'program ROM (dump), internal (MCU) ROM (dump)' }],
  [/^Roland\/SD-80$/, { id: 'roland-sd-80', version: 'flash backup (sd80.bin), wave flash backup (sd80wave.bin)' }],
  [/^Roland\/SD-90$/, { id: 'roland-sd-90', version: 'v1.03 (USB)' }],
  [/^Roland\/SDX SRV SDE-330$/, { ids: [{ id: 'roland-srv-330' }, { id: 'roland-sdx-330' }, { id: 'roland-sde330' }], version: 'ROM pack (SDX/SRV/SDE-330)' }],
  [/^Roland\/SE-02$/, { id: 'roland-se-02', version: 'v1.11' }],
  [/^Roland\/SH-01A$/, { ids: [{ id: 'roland-sh-01a' }, { id: 'roland-tr-08' }], version: 'v1.08' }],
  [/^Roland\/SH-32$/, { id: 'roland-sh-32', version: 'v1.06' }],
  [/^Roland\/SH-4d$/, { id: 'roland-sh-4d', version: 'v2.00' }],
  [/^Roland\/SK-88Pro$/, { id: 'roland-sk-88pro', version: 'program ROM 1.01 (dump)' }],
  [/^Roland\/SN-U110 PCM cards$/, { id: 'roland-sn-u110-pcm-cards', version: 'SN-U110-01 to -15 card dumps (with SN-MV30-01/02, SN-SPLA-01)' }],
  [/^Roland\/SP-404$/, { id: 'roland-sp-404', version: 'v1.04, v1.07 (SP-404SX)' }],
  [/^Roland\/SP-404MKII$/, { id: 'roland-sp-404mkii', version: 'v5.52' }],
  [/^Roland\/SP-555$/, { id: 'roland-sp-555', version: 'v1.04' }],
  [/^Roland\/SP-606$/, { id: 'roland-sp-606', version: 'v1.09' }],
  [/^Roland\/SP-808$/, { id: 'roland-sp-808', version: 'v1.050 (SMF), v1.001 (SP-808EX)' }],
  [/^Roland\/SPD-30$/, { id: 'roland-octapad-spd-30', version: 'v2.04' }],
  [/^Roland\/SPD-S$/, { id: 'roland-spd-s', version: 'v1.20 (CompactFlash)' }],
  [/^Roland\/SPD-SX$/, { id: 'roland-spd-sx', version: 'v1.10' }],
  [/^Roland\/System-1$/, { id: 'roland-system-1', version: 'v1.30' }],
  [/^Roland\/T-8$/, { id: 'roland-t-8', version: 'v1.02' }],
  [/^Roland\/TB-03$/, { id: 'roland-tb-03', version: 'v1.07' }],
  [/^Roland\/TB-303$/, { id: 'roland-tb-303', version: 'ROM dump (MAME set tb303)' }],
  [/^Roland\/TD-02$/, { id: 'roland-td-02', version: 'v1.01' }],
  [/^Roland\/TD-07$/, { id: 'roland-td-07', version: 'v2.00' }],
  [/^Roland\/TD-11$/, { id: 'roland-td-11', version: 'v1.15' }],
  [/^Roland\/TD-12$/, { id: 'roland-td-12', version: 'v1.11' }],
  [/^Roland\/TD-15$/, { id: 'roland-td-15', version: 'v1.14' }],
  [/^Roland\/TD-17$/, { id: 'roland-td-17', version: 'v2.10' }],
  [/^Roland\/TD-20$/, { id: 'roland-td-20', version: 'v1.10' }],
  [/^Roland\/TD-25$/, { id: 'roland-td-25', version: 'v1.11' }],
  [/^Roland\/TD-30$/, { id: 'roland-td-30', version: 'v1.13' }],
  [/^Roland\/TD-50$/, { id: 'roland-td-50', version: 'v1.09' }],
  [/^Roland\/TD-8$/, { id: 'roland-td-8', version: 'v1.10 (Windows)' }],
  [/^Roland\/TR-09, VP-03$/, { ids: [{ id: 'roland-tr-09' }, { id: 'roland-vp-03' }], version: 'v1.06' }],
  [/^Roland\/TR-1000$/, { id: 'roland-tr-1000', version: 'v1.50' }],
  [/^Roland\/TR-606$/, { id: 'roland-tr-606', version: 'ROM dump (MAME set tr606)' }],
  [/^Roland\/TR-6S$/, { id: 'roland-tr-6s', version: 'v2.00' }],
  [/^Roland\/TR-8$/, { id: 'roland-tr-8', version: 'v1.61' }],
  [/^Roland\/TR-808$/, { id: 'roland-tr-808', version: 'ROM dump (MAME set tr808)' }],
  [/^Roland\/TR-8S$/, { id: 'roland-tr-8s', version: 'v3.00' }],
  [/^Roland\/V-Synth$/, { id: 'roland-v-synth', version: 'v2.00' }],
  [/^Roland\/V-Synth GT$/, { id: 'roland-v-synth-gt', version: 'v2.00' }],
  [/^Roland\/V71$/, { id: 'roland-td-713', version: 'V71 2.10' }],
  [/^Roland\/VariOS$/, { id: 'roland-varios', version: 'v1.07, VariOS-8 software 1.20, VariOS-303 software 1.20' }],
  [/^Roland\/VB-99$/, { id: 'roland-vb-99', version: 'v1.02' }],
  [/^Roland\/VG-99$/, { id: 'roland-vg-99', version: 'v1.04' }],
  [/^Roland\/VM-3100$/, { id: 'roland-vm-3100', version: 'v1.05' }],
  [/^Roland\/VM-7000$/, { id: 'roland-vm-7000', version: 'v1.720 (VM-7100/7200, SmartMedia), v1.720 (VM-7100/7200, SMF)' }],
  [/^Roland\/VS-1680$/, { id: 'roland-vs-1680', version: 'v2.500 (SMF), v2.024 (Zip disk), v2.024 (SMF)' }],
  [/^Roland\/VS-1824CD$/, { id: 'roland-vs-1824cd', version: 'v1.501' }],
  [/^Roland\/VS-1880$/, { id: 'roland-vs-1880', version: 'v1.50 (SMF), v1.015 (Zip disk), v1.015 (SMF)' }],
  [/^Roland\/VS-2000CD$/, { id: 'roland-vs-2000cd', version: 'v2.005' }],
  [/^Roland\/VS-2400CD$/, { id: 'roland-vs-2400cd', version: 'v1.504' }],
  [/^Roland\/VS-2480$/, { id: 'roland-vs-2480', version: 'v2.505' }],
  [/^Roland\/VS-840$/, { id: 'roland-vs-840', version: 'v1.05 (Zip disk), v1.05 (SMF), v2.05 (VS-840EX, SMF)' }],
  [/^Roland\/VS-880$/, { id: 'roland-vs-880', version: 'v1.081' }],
  [/^Roland\/VS-890$/, { id: 'roland-vs-890', version: 'v1.014 (Zip disk), v1.014 (SMF)' }],
  [/^Roland\/VT-4$/, { id: 'roland-vt-4', version: 'v1.03' }],
  [/^Roland\/XV-3080$/, { id: 'roland-xv-3080', version: 'v1.11 (SmartMedia), v1.11 (SMF)' }],
  [/^Roland\/XV-5050$/, { id: 'roland-xv-5050', version: 'v1.08' }],
  [/^Roland\/XV-5080$/, { id: 'roland-xv-5080', version: 'v1.30' }],
  [/^Roland\/XV-88$/, { id: 'roland-xv-88', version: 'v1.10 (SmartMedia), v1.10 (SMF)' }],
  [/^Sequential\/Evolver$/, { id: 'sequential-evolver' }],
  [/^Sequential\/Fourm$/, { id: 'sequential-fourm', version: 'v1.0.0.2' }],
  [/^Sequential\/Mopho$/, { id: 'sequential-mopho' }],
  [/^Sequential\/Pro 2$/, { id: 'sequential-pro-2', version: 'v1.4' }],
  [/^Sequential\/Pro 3$/, { id: 'sequential-pro-3', version: 'v1.2.1.0' }],
  [/^Sequential\/Prophet '08$/, { id: 'sequential-prophet-08', version: 'M2.3/V1.5 (keyboard)' }],
  [/^Sequential\/Prophet 12$/, { id: 'sequential-prophet-12', version: 'v1.4.2.3 (keyboard)' }],
  [/^Sequential\/Prophet Rev2$/, { id: 'sequential-prophet-rev2', version: 'v1.2.5' }],
  [/^Sequential\/Prophet X$/, { id: 'sequential-prophet-x', version: 'v2.2.2.0.0' }],
  [/^Sequential\/Prophet-5 Rev4$/, { id: 'sequential-prophet-5-rev4', version: 'main 2.1.0, panel 1.1.3' }],
  [/^Sequential\/Prophet-6$/, { id: 'sequential-prophet-6', version: 'v1.7.5' }],
  [/^Sequential\/Take 5$/, { id: 'sequential-take-5', version: 'main 2.1.0.2, panel 1.1.2' }],
  [/^Sequential\/Tempest$/, { id: 'sequential-tempest', version: 'v1.5.0.2' }],
  [/^Sequential\/Tetra$/, { id: 'sequential-tetra', version: 'M1.5/V1.2' }],
  [/^Sequential\/Trigon-6$/, { id: 'sequential-trigon-6', version: 'v1.1.2-1' }],
  [/^Sequentix\/Cirklon$/, { id: 'sequentix-cirklon', version: 'v1.22e (CK1 hardware), v1.22d (CK2 hardware)' }],
  [/^Sequentix\/P3$/, { id: 'sequentix-p3', version: 'v4.5b3, v4b28' }],
  [/^Social Entropy\/Engine$/, { id: 'social-entropy-engine', version: 'v1.000h' }],
  [/^Sonic Potions\/LXR$/, { id: 'sonic-potions-lxr', version: 'v0.37' }],
  [/^Sonicware\/ELZ_1$/, { id: 'sonicware-elz-1', version: 'v7.0' }],
  [/^Sonicware\/SmplTrek$/, { id: 'sonicware-smpltrek', version: 'v3.2.174' }],
  [/^Squarp\/Hapax$/, { id: 'squarp-hapax', version: 'v3.22' }],
  [/^Squarp\/Pyramid$/, { id: 'squarp-pyramid', version: 'v4.03' }],
  [/^Steinberg\/CC121$/, { id: 'steinberg-cc121', version: 'Firmware Updater 1.50 (Windows)' }],
  [/^Steinberg\/MIDEX-8$/, { id: 'steinberg-midex-8', version: 'driver archive (Mac 1.0.0b4-b6, OS 9; Windows 1.80, 1.93, 1.9.64 x64; updmros.exe)' }],
  [/^SynthAxe\/SynthAxe$/, { id: 'synthaxe-synthaxe', version: 'v5.3 (SynthAxe EPROM data), v5.3 (console EPROM data)' }],
  [/^Synthstrom\/Deluge$/, { id: 'synthstrom-deluge', version: 'v1.3.0' }],
  [/^Tascam\/2488$/, { id: 'tascam-2488', version: 'v1.02' }],
  [/^Tascam\/DM-24$/, { id: 'tascam-dm-24', version: 'v3.0, v2.10 (MIDI files)' }],
  [/^Tascam\/DM-3200$/, { id: 'tascam-dm-24', version: 'v1.70 (DM-3200)' }],
  [/^Tascam\/DM-4800$/, { id: 'tascam-dm-24', version: 'v1.70 (DM-4800)' }],
  [/^Tascam\/FW-1884$/, { id: 'tascam-us-428', version: 'FW-1884 firmware updater 1.83 (Windows)' }],
  [/^Tascam\/MX-2424$/, { id: 'tascam-mx-2424', version: 'MX-OS 3.12 (Windows)' }],
  [/^Tascam\/US-224$/, { id: 'tascam-us-428', version: 'US-224 driver 3.40 (Windows)' }],
  [/^Tascam\/US-2400$/, { id: 'tascam-us-428', version: 'US-2400 updater 1.31 (Windows)' }],
  [/^Tascam\/US-428$/, { id: 'tascam-us-428', version: 'driver 3.40 (Windows)' }],
  [/^TC Electronic\/G-Major$/, { id: 'tc-electronic-g-major', version: 'v1.27' }],
  [/^TC Electronic\/G-Major 2$/, { id: 'tc-electronic-g-major', version: 'v1.02 (G-Major 2, Windows updater)' }],
  [/^TC Electronic\/G-Natural$/, { id: 'tc-electronic-g-natural', version: 'v1.04 (Windows updater)' }],
  [/^TC Electronic\/G-Sharp$/, { id: 'tc-electronic-g-sharp', version: 'Windows package (2013)' }],
  [/^TC Electronic\/G-System$/, { id: 'tc-electronic-g-system', version: 'v4.5 (Windows updater)' }],
  [/^TC Electronic\/Nova System$/, { id: 'tc-electronic-nova-system', version: 'v1.2.02 (Windows updater)' }],
  [/^TC Electronic\/Reverb 4000$/, { id: 'tc-electronic-reverb-4000', version: 'reverb4000.zip (2007)' }],
  [/^TC Electronic\/System 6000$/, { id: 'tc-electronic-system-6000', version: 'DSP 4.02' }],
  [/^Teenage Engineering\/OP-1$/, { id: 'teenage-engineering-op-1', version: 'v246' }],
  [/^Tubbutec\/Juno-66$/, { ids: [{ id: 'roland-juno6' }, { id: 'tubbutec-retrofit-midi-kits' }], version: 'v1.1, v1.22, v1.23, v1.24, v1.25, v1.26, v1.28, v1.29, v1.30, v1.31' }],
  [/^Tubbutec\/MC-2oh2$/, { ids: [{ id: 'roland-mc-202' }, { id: 'tubbutec-retrofit-midi-kits' }], version: 'v1.00, v1.02, v1.03, v1.04, v1.10_beta, v1.11, v1.12, v1.20, v1.21, v1.22, v1.23' }],
  [/^Tubbutec\/ModyPoly$/, { ids: [{ id: 'korg-polysix' }, { id: 'korg-poly61' }, { id: 'korg-mono-poly' }, { id: 'tubbutec-retrofit-midi-kits' }], version: 'v1.53, v1.54, v1.55, v1.571, v1.6, v2.0, v2.2, v2.3, v2.4, v2.41, v2.42, v2.45, v2.46' }],
  [/^Tubbutec\/Modysix$/, { ids: [{ id: 'korg-polysix' }, { id: 'tubbutec-retrofit-midi-kits' }], version: 'v1.5, v1.54, v1.55' }],
  [/^Tubbutec\/SH-1oh1$/, { ids: [{ id: 'roland-sh101' }, { id: 'tubbutec-retrofit-midi-kits' }], version: 'v1.02, v1.03, v1.04, v1.05, v1.06, v1.07, v1.09, v1.10, v1.11' }],
  [/^Tubbutec\/SH-1oh1 uTune edition$/, { ids: [{ id: 'roland-sh101' }, { id: 'tubbutec-retrofit-midi-kits' }], version: 'v1.08, v1.11' }],
  [/^Tubbutec\/uniPulse$/, { ids: [{ id: 'roland-cr78' }, { id: 'roland-tr-606' }, { id: 'roland-tr-808' }, { id: 'korg-kr55' }, { id: 'linn-linndrum' }, { id: 'tubbutec-retrofit-midi-kits' }], version: 'v1.03' }],
  [/^Turtle Beach\/Rio$/, { id: 'turtle-beach-maui', version: 'Rio ROM (MX27C512 dump)' }],
  [/^UDO\/Super 6$/, { id: 'udo-super-6', version: 'current (Dropbox folder, 2026-11-26)' }],
  [/^UDO\/Super Gemini$/, { id: 'udo-super-gemini', version: 'current (Dropbox folder, 2026-11-26)' }],
  [/^Waldorf\/Blofeld$/, { id: 'waldorf-blofeld', version: 'v1.25' }],
  [/^Waldorf\/Kyra$/, { id: 'waldorf-kyra', version: 'v1.78' }],
  [/^Waldorf\/Q$/, { id: 'waldorf-q', version: 'v1q20 (beta), v2.02 (beta), boot 0.87, boot 0.95, boot 0.96, boot 0.98, boot 1.02, v1.03, v1.05, v1.06, v1.07, v1.08, v1.09, v1.10, v1.11, q_981223, v2.15, v2.16, v3.00, v1.12, v1.13, v1.16, v1.18, v2.00, v2.01, v2.03, v3.02' }],
  [/^Waldorf\/Q\+$/, { id: 'waldorf-q', version: 'v3.54 (Q+), v3.53 (Q+)' }],
  [/^Waldorf\/RackAttack$/, { id: 'waldorf-rackattack', version: 'v1.03, v1.03 (all files), v1.02' }],
  [/^Waldorf\/Streichfett$/, { id: 'waldorf-streichfett', version: 'v1.14' }],
  [/^Waldorf\/STVC$/, { id: 'waldorf-stvc', version: 'v1.30' }],
  [/^Waldorf\/Wave$/, { id: 'waldorf-wave', version: 'v1.700, v1.680, beta' }],
  [/^Yamaha\/01V96$/, { id: 'yamaha-01v96', version: 'v1.08, V2 2.42-2, v01V96i 1.02, v01V96VCM 2.42-2' }],
  [/^Yamaha\/02R96$/, { id: 'yamaha-02r96', version: 'v1.23, V2 2.40-2' }],
  [/^Yamaha\/AW1600$/, { id: 'yamaha-aw1600', version: 'v1.13' }],
  [/^Yamaha\/AW2400$/, { id: 'yamaha-aw2400', version: 'v1.13' }],
  [/^Yamaha\/AW2816$/, { id: 'yamaha-aw2816', version: 'v1.14' }],
  [/^Yamaha\/AW4416$/, { id: 'yamaha-aw4416', version: 'v2.12' }],
  [/^Yamaha\/CK61$/, { id: 'yamaha-ck61', version: 'v2.00' }],
  [/^Yamaha\/DB50XG$/, { id: 'yamaha-db50xg', version: 'ROM dump (MAME set db50xg)' }],
  [/^Yamaha\/DB60XG$/, { id: 'yamaha-db60xg', version: 'ROM dump (MAME set db60xg)' }],
  [/^Yamaha\/DM1000$/, { id: 'yamaha-dm1000', version: 'v1.08, V2 2.41-2' }],
  [/^Yamaha\/DM2000$/, { id: 'yamaha-dm2000', version: 'v1.23, V2 2.40-2' }],
  [/^Yamaha\/DTX-PRO$/, { id: 'yamaha-dtx-pro', version: 'v2.10' }],
  [/^Yamaha\/DTX502$/, { id: 'yamaha-dtx502', version: 'v1.30' }],
  [/^Yamaha\/DTX900$/, { id: 'yamaha-dtx900', version: 'v1.10' }],
  [/^Yamaha\/DX200$/, { id: 'yamaha-dx200', version: 'v1.01, v1.01 (readme)' }],
  [/^Yamaha\/Genos$/, { id: 'yamaha-genos', version: 'v2.13, Genos2 2.00' }],
  [/^Yamaha\/Magicstomp$/, { id: 'yamaha-magicstomp', version: 'v2.10 (UB99 MK2, MIDI file)' }],
  [/^Yamaha\/MO6$/, { id: 'yamaha-mo6', version: 'v1.02' }],
  [/^Yamaha\/MODX$/, { id: 'yamaha-modx', version: 'v2.52' }],
  [/^Yamaha\/Montage$/, { id: 'yamaha-montage', version: 'v3.51' }],
  [/^Yamaha\/Montage M$/, { id: 'yamaha-montage-m', version: 'v3.01 (from 3.00)' }],
  [/^Yamaha\/Motif ES$/, { id: 'yamaha-motif-es', version: 'v1.08' }],
  [/^Yamaha\/Motif ES Rack$/, { id: 'yamaha-motif-es-rack', version: 'v1.03' }],
  [/^Yamaha\/Motif Rack XS$/, { id: 'yamaha-motif-rack-xs', version: 'v1.04' }],
  [/^Yamaha\/Motif XF$/, { id: 'yamaha-motif-xf', version: 'v1.50' }],
  [/^Yamaha\/Motif XS$/, { id: 'yamaha-motif-xs', version: 'v1.60' }],
  [/^Yamaha\/MOX6$/, { id: 'yamaha-mox6', version: 'v1.02' }],
  [/^Yamaha\/MOXF6$/, { id: 'yamaha-moxf6', version: 'v1.12' }],
  [/^Yamaha\/MU10$/, { id: 'yamaha-mu10', version: 'ROM dump (MAME set mu10)' }],
  [/^Yamaha\/MU1000$/, { id: 'yamaha-mu1000', version: 'Extended Edition R1 (MU1000, Windows)' }],
  [/^Yamaha\/MU15$/, { id: 'yamaha-mu15', version: 'ROM dump (MAME set mu15)' }],
  [/^Yamaha\/MU2000$/, { id: 'yamaha-mu1000', version: 'Extended Edition R1 (MU2000, Windows)' }],
  [/^Yamaha\/MX49$/, { id: 'yamaha-mx49', version: 'v1.01' }],
  [/^Yamaha\/n12$/, { id: 'yamaha-n12', version: 'v1.03' }],
  [/^Yamaha\/PLG100-VL$/, { id: 'yamaha-plg150-an', version: 'ROM dump PLG100-VL (MAME device plg100_vl)' }],
  [/^Yamaha\/PLG150-AP$/, { id: 'yamaha-plg150-an', version: 'ROM dump PLG150-AP (MAME device plg150_ap)' }],
  [/^Yamaha\/PSR-3000$/, { id: 'yamaha-psr-3000', version: 'v1.80' }],
  [/^Yamaha\/PSR-9000$/, { id: 'yamaha-psr-9000', version: 'v3.06' }],
  [/^Yamaha\/PSR-A5000$/, { id: 'yamaha-psr-a5000', version: 'v1.40' }],
  [/^Yamaha\/PSR-S900$/, { id: 'yamaha-psr-s900', version: 'v1.30' }],
  [/^Yamaha\/PSR-S950$/, { id: 'yamaha-psr-s950', version: 'v1.04 (USA)' }],
  [/^Yamaha\/PSR-SX900$/, { id: 'yamaha-psr-sx900', version: 'v1.11' }],
  [/^Yamaha\/QS300$/, { id: 'yamaha-qs300', version: 'ROM dump (MAME set qs300)' }],
  [/^Yamaha\/reface CS$/, { id: 'yamaha-reface-cs', version: 'YC 1.30, CP 1.30, v1.30 (CS/DX)' }],
  [/^Yamaha\/RS7000$/, { id: 'yamaha-rs7000', version: 'v1.22 (Windows)' }],
  [/^Yamaha\/S70 XS$/, { id: 'yamaha-s70-xs', version: 'v1.06' }],
  [/^Yamaha\/S90$/, { id: 'yamaha-s90', version: 'v1.04 (Windows)' }],
  [/^Yamaha\/S90ES$/, { id: 'yamaha-s90es', version: 'v1.03' }],
  [/^Yamaha\/SEQTRAK$/, { id: 'yamaha-seqtrak', version: 'v2.00' }],
  [/^Yamaha\/SFG-05$/, { id: 'yamaha-sfg-05', version: 'ROM dump (MAME device msx_cart_sfg05)' }],
  [/^Yamaha\/SW1000XG$/, { id: 'yamaha-sw1000xg', version: 'ROM dump (MAME set sw1000xg)' }],
  [/^Yamaha\/TG100$/, { id: 'yamaha-tg100', version: 'ROM dump (MAME set tg100)' }],
  [/^Yamaha\/VL1$/, { id: 'yamaha-vl1', version: 'ROM dump (MAME set vl1)' }],
  [/^Yamaha\/VL70-m$/, { id: 'yamaha-vl70-m', version: 'v1.11' }],
  [/^Yamaha\/YC61$/, { id: 'yamaha-yc61', version: 'v2.00' }],
  [/^Zoom\/AR-48$/, { id: 'zoom-arq-ar-48', version: 'v1.20' }],
  [/^Zoom\/AR-96$/, { id: 'zoom-arq-ar-48', version: 'v2.20 (AR-96)' }],
  [/^Zoom\/G9\.2tt$/, { id: 'zoom-g9-2tt', version: 'v1.08' }],
  [/^Zoom\/MRS-8$/, { id: 'zoom-mrs-1044', version: 'v1.12 (MRS-8)' }],
  [/^Zoom\/MRS-802$/, { id: 'zoom-mrs-1044', version: 'v2.01 (MRS-802)' }],
  [/^Zoom\/R16$/, { id: 'zoom-r16', version: 'v1.23' }],
  [/^Zoom\/R24$/, { id: 'zoom-r16', version: 'v1.13 (R24)' }],
  [/^Zoom\/R8$/, { id: 'zoom-r16', version: 'v1.17a (R8)' }],
  // --- end downloads: folders ---

  // Korg System Updater packages (korg/<product>/...) and an unpacked one
  [/(^|\/)modwave[^/]*_system_update[^/]*$/i, { id: 'korg-modwave' }],
  [/(^|\/)wavestate[^/]*_system_update[^/]*$/i, { id: 'korg-wavestate' }],
  [/(^|\/)opsix[^/]*_system_update[^/]*$/i, { id: 'korg-opsix' }],
  [/(^|\/)multipoly[^/]*_system_update[^/]*$/i, { id: 'korg-multipoly' }],
  [/(^|\/)Grandstage_X[^/]*_system_update[^/]*$/i, { id: 'korg-grandstage-x' }],
  [/(^|\/)modwave_system_update_[^/]*$/i, { note: 'unpacked copy of an update zip (its readme: the updater wants the zip itself, unchanged)' }],

  // Access Virus OS updates (MIDI files) and the TI software suite
  [/(^|\/)Virus_A_Series_OS/i, { id: 'access-virus-a', version: 'OS 2.80' }],
  [/(^|\/)Virus_Classic/i, { id: 'access-virus-classic', version: 'OS 490x061' }],
  [/(^|\/)Virus_OSB/i, { id: 'access-virus-b', version: 'OS 490x050' }],
  [/(^|\/)Virus_OSC/i, { id: 'access-virus-c', version: 'OS 650x352' }],
  [/(^|\/)Virus_rackXL/i, { id: 'access-virus-rack-xl', version: 'OS 650x79' }],
  [/(^|\/)Virus TI Software Suite/i, { id: 'access-virus-ti2', version: '5.1.7.00', note: 'Virus TI Software Suite installer (64-bit); carries the TI firmware (also covers the Virus TI/TI1 and Snow)' }],
  [/(^|\/)VirusTI2$/, { id: 'access-virus-ti2', note: 'also covers the Virus TI/TI1 and Snow; the Virus TI Software Suite unpacked: `firmware_bin` (+64), VirusControl plug-ins, USB drivers, soundsets, ROM bank backups (TI, TI2, Snow), manuals' }],

  // Roland
  [/(^|\/)Roland System 8/i, { id: 'roland-system-8' }],

  // Corrections to the catalog's grouping (contents checked)
  [/(^|\/)KX firmware\.zip$/i, { id: 'yamaha-kx88', note: 'holds `KX88_76 in0110 V1.7.bin` and `V1.8.bin` (the catalog lists it as "Unknown KX firmware")' }],
  [/(^|\/)Sequential Prophet OS v1\.00\.zip$/i, { id: 'sequential-prophetvs', note: 'same EPROM images as `SCI Prophet VS EPROM Firmware v1.0.zip` (the catalog lists it as "Prophet (unidentified OS)")' }],
  [/(^|\/)Sequential Prophet OS v1\.1\.zip$/i, { id: 'sequential-prophetvs', note: 'same EPROM images as `SCI Prophet VS EPROM Firmware v1.1.zip` (the catalog lists it as "Prophet (unidentified OS)")' }],
  [/(^|\/)EPROM KAWAI 80 AND ROLAND MC500MKII\.zip$/i, {
    ids: [
      { id: 'roland-mc500', note: '`ROLAND MC500mkII/ROLANDMC500MKII 1.4.BIN` (AM27C64)' },
      { id: 'kawai-q80', note: '`KAWAI Q80EX/KAWAIQ80EX.BIN` (27C1000)' },
    ],
  }],

  // the catalog files these under the Korg 01/W, the Roland R-8 and the E-mu Emulator II
  [/(^|\/)Korg 01RW \(latest OS version\)\.rar$/i, { id: 'korg-01r-w', note: '01R/W rack: IC32 MSB 910435 (27C1001), IC31 LSB 910535 (27C2001)' }],
  [/(^|\/)Korg_01RW_09\.20\.1991_v27\.zip$/i, { id: 'korg-01r-w', note: '01R/W: `Korg01RW_v37_910439_IC32`, `_910539_IC31` (MBM27C1001/27C2001)' }],
  [/(^|\/)Korg01rw_rack-fw62-TothCsaba\.zip$/i, { id: 'korg-01r-w', note: '01R/W rack firmware v62 (IC31 LSB, IC32 MSB) with notes' }],
  [/(^|\/)Roland R8 MKII EPROM v1\.0\.3\.zip$/i, { id: 'roland-r-8-mkii' }],
  [/(^|\/)Roland-R-8M-v1\.04\.zip$/i, { id: 'roland-r-8m' }],
  [/(^|\/)Emu Emulator Boot ROMs \(various, includes rare WILDCARD\)\.zip$/i, {
    ids: [
      { id: 'emu-emulator2', note: '`820816-*.bin` boot ROMs' },
      { id: 'e-mu-emulator', note: '`E14Voice2708.BIN` (Emulator I, 4-voice, 2708) and `Emu_wildcard.bin`' },
    ],
  }],

  [/(^|\/)FM3xA52F\.zip$/i, { unknown: 'one 4213-byte image (`FM3xA52F.bin`) with no readable text; the catalog lists it as "Unknown FM3xA52F"' }],

  // Notes only
  [/(^|\/)tc-helicon_firmware_updates_201909\.zip$/i, { note: 'one .syx update per product: VoiceLive 2/Play/Play GTX/Rack/Touch/Touch 2, Perform-V/VE/VG/VK, Play Acoustic/Electric, Harmony Singer 2, Mic Mechanic 2, Blender, Critical Mass, Duplicator, SingThing, Talkbox Synth' }],
];

/**
 * Editor notes per device that has an editor in the registry. Every device with an editor is ticked
 * (the user: "mark any editor we have as complete"); whether it is finished (a Full editor) comes from
 * js/devices/levels.js, and one that is not counts as work still open in the summary. The note comes
 * from the device's doc, docs/FUTURE_WORK.md and levels.js.
 */
const EDITORS = {
  'kurzweil-k2000': { note: 'its own module (`js/devices/kurzweil-k2000`): programs, keymaps, samples, effects, Branch Library, disk import and front panel; still open: the program translator and program settings by parameter in the Head Library', doc: 'PROTOCOL.md' },
  'korg-m1': { note: 'full editor: every byte named from the M1R v1.06 firmware, checked on an M1R; program and combination translators' },
  'korg-m1r': { note: 'full editor (same as the M1): every byte named from the v1.06 firmware, checked on an M1R; program and combination translators' },
  'oberheim-matrix1000': { note: 'mapped from the v1.13 firmware and checked against the ROM, patch translator; still open: a hardware check, master bytes without names' },
  'roland-jp8080': { note: 'full editor: every byte named from OS 1.04, checked on a JP-8080; patch and performance translators' },
  'roland-jp8000': { note: 'mapped from the OS 1.05 firmware, patch and performance translators; still open: a JP-8000 hardware check (none available), system 12h-16h without names' },
  'roland-jv2080': { note: 'mapped from the v1.02 firmware, checked on a JV-2080, patch, performance and rhythm set translators; still open: preset and board rhythm sets for part 10, the XP-format bytes, data cards' },
  'roland-vsynth-xt': { note: 'full editor: V-Synth engine, mapped from OS 2.02, checked on a V-Synth XT; translator' },
  'roland-vsynth-xt-vc1': { note: 'full editor: VC-1 (D-50) engine, mapped from OS 2.02, checked on the XT; translator' },
  'roland-vsynth-xt-vc2': { note: 'VC-2 (Vocal Designer) engine, mapped from OS 2.02, checked on the XT, translator; still open: names of the modulator waves' },
  'novation-supernova2': { done: false, note: 'mapped from Rack OS 2.0 and checked on a SuperNova II Rack, with the arpeggio pattern page, a Rack/Keyboard choice and the Keyboard OS 2.0 menu displays; still open: a few unnamed bytes and bits (factory-data evidence in the doc), Keyboard Tx option bits, OS 1.x' },
  'novation-supernova': { done: false, note: 'mapped from its own OS 4.1 image (Novation OS update decoded); not checked on a SuperNova (none available)' },
  'novation-nova': { done: false, note: 'mapped from the Nova OS 4.1 image (one OS for desktop and Laptop); not checked on a Nova (none available)' },
  'novation-nova2': { done: false, note: 'the SuperNova II editor with model 23, from the Nova II Keyboard OS 2 image; not checked on a Nova II (none available); no rack/desktop OS published' },
};

/** Groups (catalog type codes) in the order the document lists them. */
const GROUPS = [
  ['syn', 'Synthesizers and sound modules'],
  ['smp', 'Samplers and sampling workstations'],
  ['drm', 'Drum machines'],
  ['fx', 'Effects processors'],
  ['gtr', 'Guitar and bass processors'],
  ['voc', 'Vocal processors'],
  ['seq', 'Sequencers'],
  ['ctl', 'Controllers and master keyboards'],
  ['pno', 'Pianos and organs'],
  ['arr', 'Arranger keyboards'],
  ['if', 'MIDI interfaces, patchbays and sync'],
  ['mix', 'Mixers'],
  ['rec', 'Recorders'],
  ['cpu', 'Computers and sound cards'],
  ['data', 'Sound data (ROMs and cartridges)'],
  ['oth', 'Other'],
];

// ---------------------------------------------------------------------------------------------

const REPO = new URL('..', import.meta.url);
const repoPath = (p) => new URL(p, REPO);
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const FW = (args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') || 'z:/firmwares').replace(/\\/g, '/').replace(/\/$/, '');
const OUT = opt('--out') ? resolve(opt('--out')) : fileURLToPath(repoPath('docs/FIRMWARE_CHECKLIST.md'));
const warn = [];

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
/** Paths folder by folder, so "korg/modwave/x" comes before "korg/modwave_mkII/x". */
function byPath(a, b) {
  const x = a.split('/'), y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = natural(x[i], y[i]); if (c) return c; }
  return x.length - y.length;
}
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// --- MIDIMaster: catalog, registry, STATUS.md, docs, translator backlog -------------------------

const registry = await import(new URL('js/devices/registry.js', REPO));
const { deviceTypes } = await import(new URL('js/core/mainlib/devicetypes.js', REPO));
const EDITOR_IDS = new Set([...registry.MODULE_IDS, ...registry.DEF_IDS]);

const DEVICES = new Map();
for (const d of registry.DEVICES) DEVICES.set(d.id, { ...d, inCatalog: true });
for (const [id, d] of Object.entries(NEW_DEVICES)) {
  if (DEVICES.has(id)) warn.push(`NEW_DEVICES: ${id} is in the catalog now; remove it from the table`);
  else DEVICES.set(id, { id, ...d, title: `${d.maker} ${d.model}`, archives: [], inCatalog: false });
}
for (const [id, m] of Object.entries(MIDI_OVERRIDES)) {
  if (DEVICES.has(id)) DEVICES.get(id).midi = m; else warn.push(`MIDI_OVERRIDES: no device ${id}`);
}
/** No factory MIDI and no third-party MIDI upgrade: left out of the list (counted only). */
const noMidi = (id) => { const d = DEVICES.get(id); return d?.midi === 'N' && !(d.midiUpgrades || []).length; };

/** Catalog archive name -> device ids. */
const BY_ARCHIVE = new Map();
for (const d of registry.DEVICES) for (const a of d.archives || []) {
  if (!BY_ARCHIVE.has(a)) BY_ARCHIVE.set(a, []);
  BY_ARCHIVE.get(a).push(d.id);
}

/** Editor levels (Full editor or not): js/devices/levels.js, the source of docs/devices/STATUS.md too. */
const { editorLevel } = await import(new URL('js/devices/levels.js', REPO));

/** tests/mainlib.test.js BACKLOG: device id -> sound objects without a translator. */
let BACKLOG = {};
{
  const m = /const BACKLOG = (\{[^\n]*\});/.exec(readText(repoPath('tests/mainlib.test.js')) || '');
  try { if (m) BACKLOG = JSON.parse(m[1].replace(/'/g, '"')); } catch { warn.push('could not read BACKLOG in tests/mainlib.test.js'); }
}

const docOf = (id) => {
  if (EDITORS[id]?.doc) return EDITORS[id].doc;
  return existsSync(repoPath(`docs/devices/${id}.md`)) ? `devices/${id}.md` : null;
};

/** The catalog builder's rules (tools/firmware/devices.py), as a fallback for new files. */
const PY_RULES = [];
for (const line of (readText(repoPath('tools/firmware/devices.py')) || '').split('\n')) {
  const m = /^\s*\('([^']+)',\s*'[^']*',\s*'[^']*',\s*'\w+',\s*'[^']*',\s*r?(['"])(.*)\2\),?\s*(#.*)?$/.exec(line);
  if (!m) continue;
  try { PY_RULES.push([m[1], new RegExp(m[3], 'i')]); } catch { /* Python-only syntax: skip */ }
}
if (PY_RULES.length < 100) warn.push(`only ${PY_RULES.length} rules read from tools/firmware/devices.py`);

// --- Firmware folder ---------------------------------------------------------------------------

const DOC_EXT = /\.(pdf|txt|jpe?g|gif|png|bmp|tiff?|rtf|docx?|html?|nfo|url|md|xls|csv|ini|log|ico)$/i;
const MIDI_EXT = /\.(mid|syx)$/i;
const EXE_EXT = /\.(exe|msi|bat|com|dll|sys|inf|cat)$/i;
const AUDIO_EXT = /\.(wav|aiff?|mp3|flac)$/i;
const ARC_EXT = /\.(zip|rar|7z|lzh|tgz|gz)$/i;
const ARCHIVE = /\.(zip|rar|7z)$/i;

/** Member names of a .zip (central directory only; nothing is decompressed). null if unreadable. */
function zipMembers(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 65557);
    const tail = Buffer.alloc(len);
    readSync(fd, tail, 0, len, size - len);
    let e = -1;
    for (let i = len - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    let cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if ((cdOff === 0xffffffff || cdSize === 0xffffffff) && e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) {
      const z = Buffer.alloc(56);
      readSync(fd, z, 0, 56, Number(tail.readBigUInt64LE(e - 12)));
      if (z.readUInt32LE(0) === 0x06064b50) { cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48)); }
    }
    if (cdSize > 64 << 20 || cdOff + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOff);
    const names = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const flags = cd.readUInt16LE(p + 8), n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      names.push(cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + n));
      p += 46 + n + x + c;
    }
    return names;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/** .rar/.7z member names from the catalog builder's listing (tools/firmware/catalog.json). */
const LISTED = new Map();
try {
  const cat = JSON.parse(readFileSync(repoPath('tools/firmware/catalog.json'), 'utf8'));
  for (const d of cat.devices || []) for (const a of d.archives || []) LISTED.set(a.name, (a.files || []).map((f) => f.path));
} catch { warn.push('tools/firmware/catalog.json not readable: .rar/.7z contents not listed'); }

/** Korg-style manifest.json (folder, file, products, version, architecture) found while walking. */
const MANIFEST = new Map();
function loadManifest(dirRel, dirAbs) {
  const text = readText(join(dirAbs, 'manifest.json'));
  if (!text) return;
  try {
    for (const e of JSON.parse(text)) {
      if (e && e.folder && e.file && e.version) MANIFEST.set(`${dirRel}/${e.folder}/${e.file}`, e);
    }
  } catch { /* not that kind of manifest */ }
}

function countFiles(abs) {
  try { return readdirSync(abs, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length; } catch { return 0; }
}

// --- What a name says: versions, chips, board positions, kind ----------------------------------

const squash = (s) => s.toLowerCase().replace(/[\s_-]/g, '');

/** Versions in a file or folder name. model: the device's model, so "Wave 2.2" or "V3" are not taken for versions. */
function versionsOf(name, model = '') {
  const stem = name.replace(/(\.(zip|rar|7z|bin|rom|msi|exe))+$/i, '');
  const m2 = squash(model);
  const out = [];
  const add = (label, raw) => {
    if (m2 && raw && m2.includes(squash(raw))) return; // part of the model's name
    if (!out.some((o) => o.toLowerCase() === label.toLowerCase())) out.push(label);
  };
  // A keyword (OS, Ver, Version, V, Rev) and a number: "v1.2a", "OS 2.10", "V1-8", "v2_02", "Ver.11", "v.1.13".
  const num = String.raw`(\d+-\d+(?![._-]?\d)|\d+(?:[._]\d+)*(?:r\d+[a-z]?|[a-z])?)(?![a-z]*\d)((?:-\d{1,3}\.\d{1,3}[a-z]?(?![0-9]))*)`;
  const keyword = new RegExp(String.raw`(?<![a-z0-9])(os[\s._-]{0,2}v?|ver(?:sion)?\.?|v|rev(?:ision)?\.?)[\s._-]{0,2}` + num, 'gi');
  for (const m of stem.matchAll(keyword)) {
    // "V4_0911": a long segment after the first is a checksum or serial, not part of the version
    const seg = m[2].replace(/[_-]/g, '.').split('.');
    const cut = seg.findIndex((s, i) => i > 0 && /^\d{4,}/.test(s));
    const v = (cut > 0 ? seg.slice(0, cut) : seg).join('.');
    if (/^(19|20)\d\d$/.test(v)) continue; // "final version 2002-11-05": a year
    const label = /^rev/i.test(m[1]) ? 'rev ' : /^os/i.test(m[1]) ? 'OS ' : 'v';
    add(label + v, m[0]);
    for (const more of (m[3] || '').split('-').filter(Boolean)) add(label + more, more); // "V1.05-1.06-1.07"
  }
  for (const m of stem.matchAll(/(?<![a-z0-9])rev(?:ision)?[\s._-]?([a-z])(?![a-z])/gi)) add(`rev ${m[1].toUpperCase()}`, m[0]);
  for (const m of stem.matchAll(/system_update_(\d+)_(\d+)_(\d+)/gi)) add(`v${m[1]}.${m[2]}.${m[3]}`, '');
  // A bare dotted number ("Akai S1000 2.2", "(1.07)") only when nothing above named the version.
  if (!out.length) {
    for (const m of stem.matchAll(/(?<![a-z0-9.])(\d{1,2}(?:\.\d{1,3}){1,3}[a-z]?)(?![0-9.])/gi)) {
      const seg = m[1].split('.');
      if (seg.length === 3 && seg.every((s) => /^\d\d$/.test(s))) continue; // a date
      add(`v${m[1]}`, m[1]);
    }
  }
  return out;
}

const CHIP = /(?<![a-z0-9])((?:[a-z]{1,5})?(?:27[ce]?\d{2,4}[a-z]{0,2}|29f\d{3}[a-z]?|23c\d{3,4}|93c\d{2}[a-z]?))(?![0-9])/gi;
const POSITION = /(?<![a-z0-9])(ic[\s_-]?\d{1,3}[a-z]?|u\d{1,2})(?![0-9])/gi;
const TAGS = [
  [/(?<![a-z])(cfw|custom|patched|mod(ded)?|hack(ed)?|gligli|vimana|mansell|gr[ae]y ?matter|musitronics|protologic|tommora|kiwi|tauntek|oled)(?![a-z])|(?<![a-z])e!/i, 'custom/third-party firmware'],
  [/sound(?!scape|brush)|pcm(?![\s_-]?\d)|wave ?roms?|wav(hi|lo)|voice ?rom|samples?(?![a-z])|waveform|waves(?![a-z])|cymbals?/i, 'sound ROM/data'],
  [/(?<![a-z])(diag\w*|debug|test rom)/i, 'diagnostic/debug'],
  [/schematic|service manual|(?<![a-z])manual|circuit diagram|changelog|part list/i, 'documentation'],
];

/** What the members of an archive or folder are, in a few words, or ''. */
function contentsNote(names) {
  const files = names.filter((n) => !n.endsWith('/'));
  if (!files.length) return '';
  const k = { doc: 0, midi: 0, exe: 0, audio: 0, arc: 0, rom: 0 };
  for (const f of files) {
    const b = basename(f);
    if (DOC_EXT.test(b)) k.doc++; else if (MIDI_EXT.test(b)) k.midi++; else if (EXE_EXT.test(b)) k.exe++;
    else if (AUDIO_EXT.test(b)) k.audio++; else if (ARC_EXT.test(b)) k.arc++; else k.rom++;
  }
  if (k.rom) return '';
  if (k.midi) return 'MIDI/SysEx update files';
  if (k.exe) return 'updater program';
  if (k.arc) return 'archives inside';
  if (k.audio) return 'audio files only';
  return 'documents only, no firmware image';
}

/** Details of an item for its checklist line. inner: look for versions in member names when the name has none. */
function describe(item, model, inner = true) {
  const parts = [];
  const name = basename(item.rel);
  if (item.isDir) parts.push(`folder, ${item.files} file${item.files === 1 ? '' : 's'}`);
  else if (/\.msi$/i.test(name)) parts.push('Windows installer');
  let versions = item.version ? [item.version] : versionsOf(name, model);
  const man = MANIFEST.get(item.rel);
  if (man) {
    if (!versions.length) versions = [`v${man.version}`];
    parts.push(...versions, `for ${man.products.join(', ')}`, `${man.architecture} board`);
  } else if (item.versionInfo) {
    const vi = item.versionInfo;
    if (!versions.length && vi.version) versions = [`v${vi.version}`];
    parts.push(...versions, vi.product && `for ${vi.product}`, vi.architecture && `${vi.architecture} board`);
  } else {
    if (!versions.length && item.members && inner) {
      const found = [...new Set(item.members.flatMap((m) => m.split('/').filter(Boolean).flatMap((s) => versionsOf(s, model))))];
      if (found.length) versions = [`inside: ${found.slice(0, 4).join(', ')}${found.length > 4 ? ', ...' : ''}`];
    }
    parts.push(...versions);
  }
  const stem = name.replace(/(\.(zip|rar|7z))+$/i, '');
  const chips = [...new Set([...stem.matchAll(CHIP)].map((m) => m[1]))];
  if (chips.length) parts.push(`chip ${chips.join(', ')}`);
  const pos = [...new Set([...stem.matchAll(POSITION)].map((m) => m[1].toUpperCase().replace(/[\s_-]/g, '')))].filter((p) => !squash(model).includes(p.toLowerCase()));
  if (pos.length) parts.push(`board position ${pos.join(', ')}`);
  for (const [re, tag] of TAGS) if (re.test(stem)) parts.push(tag);
  const c = item.members ? contentsNote(item.members) : '';
  if (c === 'documents only, no firmware image' && parts.includes('documentation')) parts.splice(parts.indexOf('documentation'), 1);
  if (c) parts.push(c);
  if (item.note) parts.push(item.note);
  if (item.isDir && item.version) parts.push(parts.shift()); // download folders: version first, then "folder, N files"
  return parts.filter(Boolean);
}

// --- Walk and identify ---------------------------------------------------------------------------

const items = []; // { rel, isDir, files, members, versionInfo, version, note, devices: [{ id, note }] }
const others = []; // { rel, isDir, note }
const unknown = []; // { rel, isDir, files, members, why }
const fallback = []; // items matched by tools/firmware/devices.py only

function ruleFor(rel) {
  const extra = {};
  for (const [re, act] of RULES) {
    if (!re.test(rel)) continue;
    if (act.id || act.ids || act.other || act.recurse || act.unknown) {
      return { ...act, note: [extra.note, act.note].filter(Boolean).join('; ') || undefined, version: act.version || extra.version };
    }
    if (act.note) extra.note = [extra.note, act.note].filter(Boolean).join('; ');
    if (act.version) extra.version = act.version;
  }
  return extra;
}

function visit(rel, abs, isDir) {
  const name = basename(rel);
  const rule = ruleFor(rel);
  const walk = () => {
    loadManifest(rel, abs);
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => natural(a.name, b.name))) {
      visit(`${rel}/${e.name}`, join(abs, e.name), e.isDirectory());
    }
  };
  if (rule.recurse) return walk();
  if (rule.other) return void others.push({ rel, isDir, note: rule.other });

  let devices = rule.ids || (rule.id ? [{ id: rule.id }] : null);
  if (!devices && !rule.unknown && BY_ARCHIVE.has(name)) devices = BY_ARCHIVE.get(name).map((id) => ({ id }));
  if (!devices && !rule.unknown && isDir) {
    const kids = readdirSync(abs, { withFileTypes: true });
    if (kids.some((k) => k.isDirectory() || ARCHIVE.test(k.name))) return walk();
  }
  if (!devices && !rule.unknown) {
    const py = PY_RULES.find(([id, re]) => DEVICES.has(id) && re.test(name));
    if (py) { devices = [{ id: py[0] }]; fallback.push(rel); }
  }

  const item = { rel, isDir, note: rule.note, version: rule.version };
  if (isDir) {
    item.files = countFiles(abs);
    const vi = readText(join(abs, '.versioninfo.xml'));
    if (vi) {
      const attr = (k) => (new RegExp(`${k}="([^"]*)"`).exec(vi) || [])[1];
      item.versionInfo = { product: attr('product'), version: attr('version'), architecture: attr('architecture') };
    }
  } else if (/\.zip$/i.test(name)) item.members = zipMembers(abs);
  else if (LISTED.has(name)) item.members = LISTED.get(name);

  const known = (devices || []).filter((d) => DEVICES.has(d.id) && DEVICES.get(d.id).maker !== 'Unknown');
  if (!known.length) {
    const cat = (devices || []).map((d) => DEVICES.get(d.id)).filter(Boolean).map((d) => `the catalog lists it as "${d.title}"`);
    const missing = (devices || []).filter((d) => !DEVICES.has(d.id)).map((d) => `rule names unknown device id ${d.id}`);
    unknown.push({ ...item, why: rule.unknown || [...cat, ...missing].join('; ') || 'no rule or catalog entry matches the name' });
    if (missing.length) warn.push(`${rel}: ${missing.join('; ')}`);
    return;
  }
  item.devices = known;
  items.push(item);
}

if (!existsSync(FW)) { console.error(`Firmware folder not found: ${FW}`); process.exit(1); }
for (const e of readdirSync(FW, { withFileTypes: true }).sort((a, b) => natural(a.name, b.name))) {
  visit(e.name, join(FW, e.name), e.isDirectory());
}

// --- Assemble ------------------------------------------------------------------------------------

/** device id -> [{ item, note }] */
const byDevice = new Map();
let leftOut = 0; // firmwares of devices without MIDI (MIDI_OVERRIDES, catalog midi N): counted, not listed
for (const item of items) {
  const ds = item.devices.filter((d) => !noMidi(d.id));
  if (!ds.length) { leftOut++; continue; }
  for (const d of ds) {
    if (!byDevice.has(d.id)) byDevice.set(d.id, []);
    byDevice.get(d.id).push({ item, note: d.note });
  }
}

function editorState(d) {
  if (!EDITOR_IDS.has(d.id)) return null;
  const level = editorLevel(d);
  const e = EDITORS[d.id] || { note: `${level.toLowerCase()} (state not reviewed for this checklist: add it to EDITORS in tools/firmware_checklist.mjs)` };
  const backlog = BACKLOG[d.id];
  const note = backlog?.length ? `${e.note}; translator not written yet (${backlog.join(', ')})` : e.note;
  return { done: true, finished: level === 'Full editor', note, level };
}

const MIDI_TAG = { R: 'MIDI in some versions only', '?': 'MIDI unknown', 'Y?': 'MIDI likely', N: 'no MIDI', H: 'MIDI host (computer/card)', D: 'sound data' };

const groups = GROUPS.map(([code, title]) => ({ code, title, devices: [] }));
const groupOf = new Map(groups.map((g) => [g.code, g]));
for (const id of byDevice.keys()) {
  const d = DEVICES.get(id);
  const g = groupOf.get(d.type) || groupOf.get('oth');
  if (!groupOf.has(d.type)) warn.push(`${id}: type "${d.type}" has no group; listed under Other`);
  g.devices.push(d);
}
for (const g of groups) g.devices.sort((a, b) => natural(a.maker, b.maker) || natural(a.model, b.model));

const code = (s) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);
const pathOf = (x) => code(x.rel + (x.isDir ? '/' : ''));

function deviceLine(d) {
  const ed = editorState(d);
  const bits = [];
  if (ed) bits.push(ed.note);
  if (ed) bits.push(`types: ${deviceTypes(d).join(', ')}`);
  if ((d.midiUpgrades || []).length) bits.push(`${d.midi === 'N' ? 'no factory MIDI; ' : d.midi === 'R' ? 'factory MIDI in some versions only; ' : ''}MIDI: ${d.midiUpgrades.map((u) => `${u.maker} ${u.product}`).join(', ')} (retrofit)`);
  else if (MIDI_TAG[d.midi]) bits.push(MIDI_TAG[d.midi]);
  if (!d.inCatalog) bits.push('not in the MIDIMaster catalog yet');
  const doc = docOf(d.id);
  if (doc) bits.push(`[doc](${doc})`);
  return `- [${ed?.done ? 'x' : ' '}] **${d.maker} ${d.model}**${bits.length ? ` — ${bits.join('; ')}` : ''}`;
}

const lines = [];
const fwCount = items.length - leftOut;
const devs = [...byDevice.keys()].map((id) => DEVICES.get(id));
const finished = devs.filter((d) => editorState(d)?.done);
const partial = devs.filter((d) => editorState(d) && !editorState(d).finished);
const newDevs = devs.filter((d) => !d.inCatalog);
const date = new Date().toISOString().slice(0, 10);

lines.push(
  '# Firmware checklist',
  '',
  `Every firmware in \`${FW.replace(/\//g, '\\')}\` (all subfolders), one line per device, grouped by device type.`,
  'A ticked device has a finished MIDIMaster editor.',
  '',
  `Generated ${date} by \`node tools/firmware_checklist.mjs\` from the firmware folder, the device catalog`,
  '(`js/devices/catalog-data.js`, `catalog-extra.js`), the registry (`js/devices/registry.js`),',
  'the editor levels (`js/devices/levels.js`) and the editor notes in the script. Run it again when firmware is added; new',
  'file-name rules and devices go in the tables at the top of the script. Do not edit this file by hand.',
  '',
  '## Summary',
  '',
  `- **${devs.length} devices** with firmware here: **${finished.length}** with an editor (ticked; ${partial.length} of them with work still open, see their notes), **${devs.length - finished.length}** without an editor.`,
  `- **${fwCount} firmwares** (archives, files and unpacked folders)${unknown.length ? `, plus **${unknown.length} not identified**` : ''}; ${others.length} other files and folders (notes, tools, scratch) are listed at the end.`,
  `- ${leftOut} firmwares of devices without MIDI are in the folder but left out of this list (\`MIDI_OVERRIDES\` in the script and the catalog's MIDI field).`,
  `- **${newDevs.length} devices are not in the MIDIMaster catalog yet**: ${newDevs.sort((a, b) => natural(a.title, b.title)).map((d) => d.title).join(', ') || 'none'}.`,
  '',
  '| Group | Devices | Firmwares | With an editor | Of which work still open |',
  '|---|---:|---:|---:|---:|',
);
for (const g of groups) {
  if (!g.devices.length) continue;
  const fw = new Set(g.devices.flatMap((d) => byDevice.get(d.id).map((x) => x.item)));
  const f = g.devices.filter((d) => editorState(d)?.done).length;
  const p = g.devices.filter((d) => editorState(d) && !editorState(d).finished).length;
  lines.push(`| [${g.title}](#${g.title.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')}) | ${g.devices.length} | ${fw.size} | ${f} | ${p} |`);
}
lines.push(
  `| **Total** | **${devs.length}** | **${fwCount}** | **${finished.length}** | **${partial.length}** |`,
  '',
  'Legend:',
  '',
  '- `[x]` MIDIMaster has an editor for the device; its note says what is still open, if anything (in progress, not checked on hardware, no translator yet).',
  '- `[ ]` alone: no editor yet. A device with MIDI still opens in MIDIMaster\'s generic MIDI module. Tags say when',
  '  the catalog knows the device has no MIDI or is not sure.',
  '- Under each device: the firmware (path relative to the firmware folder), then what its name or contents show:',
  '  version, chip, board position (IC/U number), kind of contents.',
  '',
);

for (const g of groups) {
  if (!g.devices.length) continue;
  lines.push(`## ${g.title}`, '');
  for (const d of g.devices) {
    lines.push(deviceLine(d));
    const entries = byDevice.get(d.id).sort((a, b) => byPath(a.item.rel, b.item.rel));
    for (const { item, note } of entries) {
      const parts = describe(item, d.model, !note);
      if (note) parts.push(note);
      lines.push(`  - ${pathOf(item)}${parts.length ? ` — ${parts.join('; ')}` : ''}`);
    }
  }
  lines.push('');
}

lines.push(`## Not identified (${unknown.length})`, '');
if (!unknown.length) lines.push('Nothing: every file is filed under a device or listed below as not firmware.');
for (const u of unknown.sort((a, b) => byPath(a.rel, b.rel))) {
  const parts = describe(u, '');
  lines.push(`- ${pathOf(u)} — ${[...parts, u.why].join('; ')}`);
}
lines.push('');

lines.push(`## Other files (not firmware) (${others.length})`, '');
for (const o of others.sort((a, b) => byPath(a.rel, b.rel))) lines.push(`- ${pathOf(o)} — ${o.note}`);
lines.push('');

// Differences from the catalog, for whoever rebuilds it.
const moved = registry.DEVICES.filter((d) => d.maker !== 'Unknown' && (d.archives || []).length && !byDevice.has(d.id) && !noMidi(d.id));
const absent = registry.DEVICES.flatMap((d) => (d.archives || []).filter((a) => !existsSync(join(FW, a))).map((a) => `${code(a)} (${d.title})`));
lines.push(
  '## Differences from the MIDIMaster catalog',
  '',
  `- Devices not in the catalog yet (\`NEW_DEVICES\` in the script): ${newDevs.map((d) => `${d.title} (\`${d.id}\`)`).join(', ') || 'none'}.`,
  `- Catalog entries whose firmware the rules file under another device: ${moved.map((d) => `${d.title} (\`${d.id}\`)`).join(', ') || 'none'}.`,
  `- Catalog archives not found in the firmware folder: ${absent.join(', ') || 'none'}.`,
  `- Files filed by the catalog builder's rules only (\`tools/firmware/devices.py\`; not in the catalog's archive lists yet): ${fallback.map(code).join(', ') || 'none'}.`,
  '',
);

const text = lines.join('\n');
const toStdout = args.includes('--stdout');
if (toStdout) process.stdout.write(text);
else writeFileSync(OUT, text);

const log = toStdout ? console.error : console.log;
log(`${devs.length} devices (${finished.length} with an editor, ${partial.length} of them with work still open), ${fwCount} firmwares, ${unknown.length} not identified, ${others.length} other files`);
for (const w of warn) console.warn(`warning: ${w}`);
if (!toStdout) log(`wrote ${OUT}`);

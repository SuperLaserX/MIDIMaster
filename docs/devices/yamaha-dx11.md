# Yamaha DX11

Definition: `js/devices/defs/yamaha-dx11.js`: the TX81Z definition (`yamaha-tx81z.md`). **Not yet checked on a DX11.**

The DX11 firmware (`z:/firmwares/Yamaha DX11.zip`, 64 KB) holds the TX81Z's bulk headers ("LM  8976AE", "PE", "PM", "S0", "S1", "LM  MCRTE0/1"), the same maximum tables (05E6, extended by aftertouch maxima) and the same INIT VOICE (009E), so it shares the TX81Z's voice, additional data, 32-voice and performance formats. Its own data:

- "LM  8023AE" (`F0 43 0n 7E 00 14 "LM  8023AE" <10> cs F7`): the aftertouch settings of the voice being edited, an object of its own (After touch page). RAM 2C29-2C2C, after the voice (2BB5) and its TX81Z additional data (2C12); the sender (upper bank EE02) sends the four bytes and six zeros, the receiver (DE17) keeps the first four; INIT (DFF0) 0, 0, 50, 0; maxima 99, 99, 100, 99 at 061A (the maximum table 05E6 goes on after the additional data); screen texts (lower bank 4572-4588, with the word tokens A4h "Pitch" and 9Ah "Amplitude" from the word list at 4290) "AT Pitch", "AT Amplitude", "AT P. Bias", "AT EG Bias". No parameter change for them is known, so a change sends the whole message.
- "LM  8023S0" (system) is recognised and kept by the Branch Library, not edited yet.

Listings: `re/dx/dx11_lower.lst`, `re/dx/dx11_upper.lst` (the two 32 KB halves at 8000h, `--auto`). Open: the DX11 system data; whether the 32-voice bulk carries the aftertouch bytes; a hardware check.

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Sent as 0 by the DX11 (EE5A), ignored when received (DE17).

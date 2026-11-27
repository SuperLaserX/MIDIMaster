// Devices added to the firmware collection after js/devices/catalog-data.js was generated
// (tools/firmware/catalog.py). Kept here by hand until the catalog is rebuilt from the new archives;
// an id that the generated catalog also has is ignored here.

export const CATALOG_EXTRA = [
  {
    id: 'roland-vsynth-xt', maker: 'Roland', model: 'V-Synth XT', type: 'syn', midi: 'Y', sysex: '41',
    cpu: ['SH-4'], archives: ['Roland V-Synth XT v2.02.zip'], evidence: { added: 'by hand, 2026-11-23' }, strings: [],
  },
  // The XT's other two engines are separate applications with their own MIDI implementation.
  {
    id: 'roland-vsynth-xt-vc1', maker: 'Roland', model: 'V-Synth XT VC-1 (D-50)', type: 'syn', midi: 'Y', sysex: '41',
    cpu: ['SH-4'], archives: ['Roland V-Synth XT v2.02.zip'], evidence: { added: 'by hand, 2026-11-24' }, strings: [],
  },
  {
    id: 'roland-vsynth-xt-vc2', maker: 'Roland', model: 'V-Synth XT VC-2 (Vocal Designer)', type: 'syn', midi: 'Y', sysex: '41',
    cpu: ['SH-4'], archives: ['Roland V-Synth XT v2.02.zip'], evidence: { added: 'by hand, 2026-11-24' }, strings: [],
  },
  // The SYSTEM-8: three Roland BMC chips (Cortex-M cores + DSPs) and an STM32F103 panel CPU; the OS is
  // encrypted, the engines (SYSTEM-8 and PLUG-OUTs) are LZSS images in the update (docs/devices/roland-system8.md).
  {
    id: 'roland-system8', maker: 'Roland', model: 'SYSTEM-8', type: 'syn', midi: 'Y', sysex: '41',
    cpu: ['Roland BMC', 'STM32F103'], archives: ['Roland System 8_sys_v132 .zip'], evidence: { added: 'by hand, 2026-11-26' }, strings: [],
  },
  // The first SuperNova (1998) and the Nova family: Novation's OS-update MIDI files, decoded with
  // tools/novation/os_mid.py (docs/devices/novation-supernova.md, novation-nova.md, novation-nova2.md).
  {
    id: 'novation-supernova', maker: 'Novation', model: 'Supernova', type: 'syn', midi: 'Y', sysex: '00 20 29',
    cpu: ['H8/300H'], archives: ['supernova-os2.zip'], evidence: { added: 'by hand, 2026-11-25; from its OS 4.1 image' }, strings: [],
  },
  {
    id: 'novation-nova', maker: 'Novation', model: 'Nova (desktop and Laptop)', type: 'syn', midi: 'Y', sysex: '00 20 29',
    cpu: ['H8/300H'], archives: ['nova-laptop-os3.zip'], evidence: { added: 'by hand, 2026-11-25' }, strings: [],
  },
  {
    id: 'novation-nova2', maker: 'Novation', model: 'Nova II Keyboard', type: 'syn', midi: 'Y', sysex: '00 20 29',
    cpu: ['H8/300H'], archives: ['nova-ii-keyboard-os2.zip'], evidence: { added: 'by hand, 2026-11-25' }, strings: [],
  },
  // The Virus TI family: the TI2 OS (an 8051-family uPSD3212 host, two DSP56367) and Virus Control's
  // parameter description, both in the Virus TI Software Suite 5.1.7 (docs/devices/access-virus-ti2.md).
  {
    id: 'access-virus-ti2', maker: 'Access', model: 'Virus TI2', type: 'syn', midi: 'Y', sysex: '00 20 33',
    cpu: ['uPSD3212', 'DSP56367'], archives: ['Virus TI Software Suite 5.1.7.00 64-bit (1).msi'], evidence: { added: 'by hand, 2026-11-25' }, strings: [],
  },
  // The other TI models running the same host OS (vti_2.bin; vti.bin for the first TI differs in one byte):
  // thin files over the TI2 editor, not checked on those units (docs/devices/access-virus-ti-models.md).
  ...[['access-virus-ti2-keyboard', 'Virus TI2 Keyboard'], ['access-virus-ti2-polar', 'Virus TI2 Polar'], ['access-virus-ti-desktop', 'Virus TI Desktop'],
    ['access-virus-ti-keyboard', 'Virus TI Keyboard'], ['access-virus-ti-polar', 'Virus TI Polar']].map(([id, model]) => ({
    id, maker: 'Access', model, type: 'syn', midi: 'Y', sysex: '00 20 33',
    cpu: ['uPSD3212', 'DSP56367'], archives: ['Virus TI Software Suite 5.1.7.00 64-bit (1).msi'], evidence: { added: 'by hand, 2026-11-26' }, strings: [],
  })),
  // The Virus TI Snow: its own host OS build (vti_snow.bin: 4 parts, banks of 64), mapped from the firmware
  // (docs/devices/access-virus-snow.md); not checked on a Snow.
  {
    id: 'access-virus-snow', maker: 'Access', model: 'Virus TI Snow', type: 'syn', midi: 'Y', sysex: '00 20 33',
    cpu: ['uPSD3212', 'DSP56367'], archives: ['Virus TI Software Suite 5.1.7.00 64-bit (1).msi'], evidence: { added: 'by hand, 2026-11-26' }, strings: [],
  },
  // The earlier Virus models (8051 host, DSP56300): editors over access-virus-abc.js with tables read from each
  // model's host OS (docs/devices/access-virus-abc.md). The Virus B and C are in the generated catalog.
  ...[['access-virus-kb', 'Virus kb', 'Virus_OSB490x050_INT.zip'], ['access-virus-indigo', 'Virus Indigo', 'Virus_OSB490x050_INT.zip'],
    ['access-virus-rack', 'Virus Rack', 'Virus_OSB490x050_INT.zip'], ['access-virus-classic', 'Virus Classic', 'Virus_Classic490x061_INT.zip'],
    ['access-virus-kc', 'Virus KC', 'Virus_OSC650x352_INT (1).zip'], ['access-virus-indigo2', 'Virus Indigo 2', 'Virus_OSC650x352_INT (1).zip'],
    ['access-virus-rack-xl', 'Virus Rack XL', 'Virus_rackXL_OS650x79_INT (1).zip'], ['access-virus-a', 'Virus A', 'Virus_A_Series_OS280-EN.zip']].map(([id, model, archive]) => ({
    id, maker: 'Access', model, type: 'syn', midi: 'Y', sysex: '00 20 33',
    cpu: ['8051', 'DSP56300'], archives: [archive], evidence: { added: 'by hand, 2026-11-26' }, strings: [],
  })),
];

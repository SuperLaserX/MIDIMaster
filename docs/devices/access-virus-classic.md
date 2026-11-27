# Access Virus Classic

The Virus Classic (2004) has the Virus B's engine and its own OS build, 4.9 x061 (26.03.04, boot
text "VIRUS CLASSIC"), from the update `Virus_Classic490x061_INT.zip` (first MIDI file decoded with
`re/virus/old/osupd.py`). That build is the B OS 4.9's code with everything from 2A3C on moved by
-44h; its tables were read the same way (`python -I tools/virus/abc_tables.py extract classic ...`,
then `js classic ...` -> `js/devices/defs/access-virus-classic-os.js`). Its editor:
`js/devices/defs/access-virus-classic.js`; details in [access-virus-b.md](access-virus-b.md) and
[access-virus-abc.md](access-virus-abc.md). Not checked on a Classic (none was connected).

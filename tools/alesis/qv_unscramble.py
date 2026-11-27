# Alesis Quadraverb family (Quadraverb, Quadraverb Plus, Quadraverb GT): put an EPROM dump into the
# order the 8031 sees it.
#
#   python -I tools/alesis/qv_unscramble.py <eprom dump .bin> <cpu image .bin>
#
# The boards wire the EPROM's low address lines in reverse: CPU A0..A7 go to EPROM A7..A0 (A8-A15 are
# straight, the data lines too). Found by hill-climbing over bit permutations with an LCD-word bigram
# score; the result reads "***  ALESIS  ***** QUADRAVERB **" at 1100h and its reset vector (LJMP at 0)
# lands on code. Applying the swap twice gives the dump back.
import sys


def unscramble(d):
    out = bytearray(len(d))
    rev = [int('{:08b}'.format(i)[::-1], 2) for i in range(256)]
    for a in range(len(d)):
        out[a] = d[(a & ~0xff) | rev[a & 0xff]]
    return bytes(out)


if __name__ == '__main__':
    src = open(sys.argv[1], 'rb').read()
    open(sys.argv[2], 'wb').write(unscramble(src))
